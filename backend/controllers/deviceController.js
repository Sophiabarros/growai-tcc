const db = require("../config/db");
const { montarConfig } = require("../services/configDispositivo");
const { analisar } = require("../services/ia");
const autoAjuste = require("../services/autoAjuste");

const MAX_FOTOS_POR_ESTACAO = 300; // retenção: cabe no plano gratuito do Neon

/* Espaçamento das chamadas de IA.
   A CAM manda foto a cada 30 min = 48 por dia POR ESTAÇÃO. A cota gratuita do
   Gemini é de 20 requisições por dia por modelo, então analisar toda foto
   estoura a cota antes do meio-dia e o resto do dia fica sem análise nenhuma.

   A foto é SEMPRE guardada; o que é espaçado é a análise. Com 180 min dá 8
   análises por dia por estação, o que cabe na cota com folga para as
   avaliações de rotina. Quem tiver cota paga pode baixar para 30 e analisar
   todas. */
const IA_FOTO_INTERVALO_MIN = Number(process.env.IA_FOTO_INTERVALO_MIN || 180);
const EXPIRA_COMANDO_MIN = 10;
const PROXIMA_EM_S = 15;

// ------------------------------------------------------------- telemetria
async function telemetria(req, res, next) {
  try {
    const t = req.body || {};
    const station = req.station;

    /* Uma leitura por minuto, no máximo, por estação. A placa manda a cada
       15 s: guardar tudo daria ~5.700 linhas por dia por estação e estouraria
       o plano gratuito do Neon em poucas semanas, sem ganho nenhum — o app
       mostra a última leitura e o relatório usa média por dia. As telemetrias
       descartadas ainda valem: elas atualizam last_seen (no deviceAuth) e
       processam comandos e config, que é o que precisa ser rápido.

       O NOT EXISTS deixa a decisão no banco, então duas requisições
       simultâneas não conseguem gravar duas linhas. */
    const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

    const extra = {
      umidade_bruto: t.umidade_bruto ?? null,
      rssi: t.rssi ?? null,
      uptime_s: t.uptime_s ?? null,
      hora_valida: t.hora_valida ?? null,
      nutri_s_hoje: t.nutri_s_hoje ?? null,
      manual: t.manual ?? null,
      cfg_versao: t.cfg_versao ?? null,
      erro: t.erro ?? null,
      erro_cfg: t.erro_cfg ?? null,
      fw: t.fw ?? null,
    };

    const { rows: gravadas } = await db.query(
      `INSERT INTO sensor_readings (station_id, humidity, ph, light_h, temperature, estado, reles, extra)
       SELECT $1, $2, NULL, $3, $4, $5, $6, $7
        WHERE NOT EXISTS (
                SELECT 1 FROM sensor_readings
                 WHERE station_id = $1
                   AND recorded_at > now() - interval '1 minute'
              )
       RETURNING id`,
      [
        station.id,
        num(t.umidade),
        num(station.light_hours),
        num(t.temp_c),
        t.estado || null,
        t.reles ? JSON.stringify(t.reles) : null,
        JSON.stringify(extra),
      ]
    );

    // ---- acks: fecha o que a placa confirmou ----
    const acks = Array.isArray(t.acks) ? t.acks.map(Number).filter(Number.isInteger) : [];
    if (acks.length) {
      await db.query(
        `UPDATE commands SET status = 'confirmado', acked_at = now()
          WHERE station_id = $1 AND id = ANY($2::int[]) AND status <> 'confirmado'`,
        [station.id, acks]
      );
    }

    /* Expira o que ficou velho. Inclui 'enviado', não só 'pendente': se a
       placa ficou uma hora fora do ar, mandar agora um "ligar a bomba" de uma
       hora atrás é pior que não mandar. */
    await db.query(
      `UPDATE commands SET status = 'expirado'
        WHERE station_id = $1
          AND status IN ('pendente', 'enviado')
          AND created_at < now() - ($2 || ' minutes')::interval`,
      [station.id, String(EXPIRA_COMANDO_MIN)]
    );

    /* O que sobrou vai na resposta e passa a 'enviado'. Continua sendo
       reenviado até vir o ack: a placa guarda os últimos 16 ids, ignora
       repetido e manda o ack de novo, então reenviar é seguro. */
    const { rows: pendentes } = await db.query(
      `UPDATE commands SET status = 'enviado', sent_at = COALESCE(sent_at, now())
        WHERE id IN (
                SELECT id FROM commands
                 WHERE station_id = $1 AND status IN ('pendente', 'enviado')
                 ORDER BY created_at
                 LIMIT 20
              )
       RETURNING id, rele, acao, dur_s`,
      [station.id]
    );

    // ---- resposta ----
    const resposta = { cfg_versao: station.cfg_versao, proxima_em_s: PROXIMA_EM_S };

    // config só quando a placa está numa versão diferente da nossa
    if (Number(t.cfg_versao) !== Number(station.cfg_versao)) {
      resposta.config = montarConfig(station);
    }
    if (pendentes.length) {
      resposta.comandos = pendentes.map((c) => ({
        id: c.id,
        rele: c.rele,
        acao: c.acao,
        dur_s: c.dur_s === null ? undefined : c.dur_s,
      }));
    }

    if (process.env.DEVICE_LOG === "1") {
      console.log(
        `[telemetria] estação ${station.id} ${t.fw || "?"} cfg v${t.cfg_versao}->v${station.cfg_versao} ` +
          `umid ${t.umidade ?? "null"} temp ${t.temp_c ?? "null"} ${t.estado || "?"} ` +
          `${gravadas.length ? "gravada" : "descartada (1/min)"} ` +
          `cmds ${pendentes.length} acks ${acks.length}`
      );
    }

    res.json(resposta);
  } catch (err) {
    next(err);
  }
}

// ------------------------------------------------------------------- foto
async function foto(req, res, next) {
  try {
    const station = req.station;
    const jpeg = req.corpoBruto;

    if (!jpeg || !jpeg.length) {
      return res.status(400).json({ error: "Corpo vazio: envie o JPEG em image/jpeg" });
    }
    // JPEG começa com FF D8. Sem isso, não vale gastar chamada de IA.
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      return res.status(400).json({ error: "O corpo não é um JPEG (esperado FF D8 no início)" });
    }

    // X-Captured-At: epoch UTC em segundos. 0 = a placa não tinha hora (NTP
    // falhou), então vale a hora de chegada no servidor.
    const epoch = Number(req.headers["x-captured-at"] || 0);
    const capturedAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();

    const { rows: leituras } = await db.query(
      `SELECT * FROM sensor_readings WHERE station_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [station.id]
    );
    const leitura = leituras[0] || null;
    const config = montarConfig(station);

    /* Já houve análise desta estação dentro da janela? Então esta foto é
       guardada sem analisar. Não é perda: o histórico fica completo, e a tela
       Câmera mostra a última foto ANALISADA (ver getLatestPhoto). */
    const { rows: ultimaAnalise } = await db.query(
      `SELECT captured_at FROM station_photos
        WHERE station_id = $1 AND health_status <> 'indefinido'
          AND captured_at > now() - ($2 || ' minutes')::interval
        ORDER BY captured_at DESC LIMIT 1`,
      [station.id, String(IA_FOTO_INTERVALO_MIN)]
    );

    let r;
    if (ultimaAnalise.length) {
      const min = Math.round((Date.now() - new Date(ultimaAnalise[0].captured_at).getTime()) / 60000);
      r = {
        ok: false,
        motivo: `análise espaçada: a última foi há ${min} min (intervalo de ${IA_FOTO_INTERVALO_MIN} min, para caber na cota da API)`,
        raw: null,
        provider: null,
        model: null,
      };
    } else {
      r = await analisar({ jpegBuffer: jpeg, estacao: station, leitura, config });
      if (!r.ok) console.warn(`[foto] estação ${station.id}: IA não analisou — ${r.motivo}`);
    }

    const health = r.ok ? r.health_status : "indefinido";
    const texto = r.ok ? r.analysis_text : "Análise indisponível no momento.";

    const snapshot = leitura
      ? {
          humidity: leitura.humidity === null ? null : Number(leitura.humidity),
          temperature: leitura.temperature === null ? null : Number(leitura.temperature),
          estado: leitura.estado,
          reles: leitura.reles,
          recorded_at: leitura.recorded_at,
          config,
        }
      : { humidity: null, temperature: null, config, aviso: "nenhuma leitura registrada ainda" };

    const iaRaw = {
      provider: r.provider,
      model: r.model,
      ok: r.ok,
      motivo: r.ok ? null : r.motivo,
      resposta: r.raw || null,
    };

    /* image_url como data URL: o disco da Vercel é somente leitura, e o app
       já joga image_url direto no <img>. Mesmo esquema do avatar. */
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

    const { rows: fotoRows } = await db.query(
      `INSERT INTO station_photos
         (station_id, image_url, health_status, analysis_text, sensor_snapshot, ia_raw, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, captured_at`,
      [station.id, dataUrl, health, texto, JSON.stringify(snapshot), JSON.stringify(iaRaw), capturedAt]
    );

    /* Sugestao da IA. O autoAjuste decide se aplica sozinho ou so registra -
       ele e quem conhece o cooldown e o ia_autoajuste da estacao. Uma falha
       aqui nao pode derrubar a resposta: a foto ja esta gravada e a placa nao
       reenvia. */
    if (r.ok && r.suggestion) {
      try {
        const res = await autoAjuste.registrar({
          stationId: station.id,
          sugestao: r.suggestion,
          origem: "ia_foto",
        });
        if (process.env.DEVICE_LOG === "1") {
          console.log(
            `[foto] sugestao ${res.sugestao.id}: ` +
              (res.aplicada ? "APLICADA automaticamente" : `so registrada (${res.motivo})`)
          );
        }
      } catch (e) {
        console.error(`[foto] estacao ${station.id}: falha ao registrar sugestao -`, e.message);
      }
    }

    // Retenção: as fotos são data URLs e ocupam ~60-120 kB cada linha.
    await db.query(
      `DELETE FROM station_photos
        WHERE station_id = $1
          AND id NOT IN (
                SELECT id FROM station_photos
                 WHERE station_id = $1
                 ORDER BY captured_at DESC, id DESC
                 LIMIT $2
              )`,
      [station.id, MAX_FOTOS_POR_ESTACAO]
    );

    if (process.env.DEVICE_LOG === "1") {
      console.log(
        `[foto] estação ${station.id} ${(jpeg.length / 1024).toFixed(1)} kB -> ${health}` +
          (r.ok && r.suggestion ? " (+sugestão)" : "")
      );
    }

    // 200 mesmo quando a IA falhou: a placa não reenvia foto.
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { telemetria, foto };
