const db = require("../config/db");
const { montarConfig } = require("../services/configDispositivo");
const { analisar } = require("../services/ia");
const autoAjuste = require("../services/autoAjuste");
const aoVivo = require("../services/aoVivo");
const relatorios = require("../services/relatorios");
const notificacoes = require("../services/notificacoes");
const realtime = require("../services/realtime");
const { temperaturaSaoPauloJa, completarTemperatura } = require("../services/temperaturaExterna");

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
/* Com o app aberto (WebSocket do usuário conectado) ou comando na fila, a
   placa fala a cada 5 s: o botão "ligar" do app precisa de resposta em
   segundos, não em 15. Com ninguém olhando, volta aos 15 s. 5 s é o mínimo
   que o firmware aceita. */
const PROXIMA_EM_S_ATIVO = 5;

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
      uv_s_hoje: t.uv_s_hoje ?? null,
      hoje_s: t.hoje_s ?? null,
      manual_hoje_s: t.manual_hoje_s ?? null,
      reset: t.reset ?? null,
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

    // ---- ao vivo: o app vê esta telemetria agora, não daqui a 1 min ----
    const vivo = {
      humidity: num(t.umidade),
      temperature: num(t.temp_c),
      estado: t.estado || null,
      reles: t.reles || null,
      manual: t.manual || {},
      erro: t.erro || null,
      erro_cfg: t.erro_cfg || null,
      hora_valida: t.hora_valida ?? null,
      nutri_s_hoje: t.nutri_s_hoje ?? null,
      uv_s_hoje: t.uv_s_hoje ?? null,
      uv_min_dia: station.uv_min_dia ?? null,
      // Tempo ligado hoje por relé (e quanto foi manual) e o motivo do último
      // reinício da placa: o painel compara com a rotina e avisa.
      hoje_s: t.hoje_s || null,
      manual_hoje_s: t.manual_hoje_s || null,
      reset: t.reset || null,
      uptime_s: t.uptime_s ?? null,
      light_hours: station.light_hours != null ? Number(station.light_hours) : null,
      rssi: t.rssi ?? null,
      fw: t.fw || null,
      cfg_versao_placa: t.cfg_versao ?? null,
      cfg_versao_servidor: station.cfg_versao,
    };
    // Avisos no sino: aparelho ligado (pela rotina ou manual) e sensor com problema.
    const anterior = aoVivo.obter(station.id);
    notificacoes.daTelemetria(station, anterior, t).catch(() => {});
    if (t.erro) {
      notificacoes.criar({
        userId: station.user_id, stationId: station.id, tipo: "sensor", semRepetirMin: 24 * 60,
        titulo: `Sensor com problema em ${station.name || station.plant}`,
        mensagem: String(t.erro),
      });
    }
    aoVivo.registrar(station.id, vivo);
    realtime.enviarParaUsuario(station.user_id, {
      tipo: "telemetria",
      station_id: station.id,
      // Sem DS18B20: vai a temperatura de São Paulo, marcada como tal.
      leitura: completarTemperatura({ ...vivo, online: true, recorded_at: new Date().toISOString() }, temperaturaSaoPauloJa()),
      confirmados: acks,
    });

    const ativo = pendentes.length > 0 || realtime.usuarioConectado(station.user_id);

    // ---- resposta ----
    const resposta = { cfg_versao: station.cfg_versao, proxima_em_s: ativo ? PROXIMA_EM_S_ATIVO : PROXIMA_EM_S };

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
/* A placa recebe o 200 assim que a foto está gravada; a IA roda DEPOIS.
   Antes a resposta esperava a análise (5-20 s, mais quando um modelo de
   reserva entra), e a CAM desiste em HTTP_TIMEOUT_MS = 10 s: a foto chegava,
   mas a placa registrava falha. O Render mantém o processo vivo depois da
   resposta, então a análise termina normalmente. Se a instância reiniciar no
   meio, a foto só fica como 'indefinido' — a próxima vem em 30 min. */
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
    const analisarAgora = !ultimaAnalise.length;

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

    let motivo = "análise em andamento";
    if (!analisarAgora) {
      const min = Math.round((Date.now() - new Date(ultimaAnalise[0].captured_at).getTime()) / 60000);
      motivo = `análise espaçada: a última foi há ${min} min (intervalo de ${IA_FOTO_INTERVALO_MIN} min, para caber na cota da API)`;
    }

    /* image_url como data URL: o disco da Vercel é somente leitura, e o app
       já joga image_url direto no <img>. Mesmo esquema do avatar.
       Entra como 'indefinido'; analisarFoto() troca pelo resultado. */
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    const { rows: fotoRows } = await db.query(
      `INSERT INTO station_photos
         (station_id, image_url, health_status, analysis_text, sensor_snapshot, ia_raw, captured_at)
       VALUES ($1, $2, 'indefinido', $3, $4, $5, $6)
       RETURNING id, captured_at`,
      [
        station.id,
        dataUrl,
        "Análise indisponível no momento.",
        JSON.stringify(snapshot),
        JSON.stringify({ provider: null, model: null, ok: false, motivo, resposta: null }),
        capturedAt,
      ]
    );

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

    res.json({ ok: true });

    if (analisarAgora) {
      analisarFoto({ fotoId: fotoRows[0].id, jpeg, station, leitura, config, capturedAt }).catch((e) =>
        console.error(`[foto] estação ${station.id}: falha na análise em segundo plano -`, e.message)
      );
    } else if (process.env.DEVICE_LOG === "1") {
      console.log(`[foto] estação ${station.id} ${(jpeg.length / 1024).toFixed(1)} kB guardada sem análise (${motivo})`);
    }
  } catch (err) {
    next(err);
  }
}

/* Roda depois de a placa já ter recebido o 200, e também quando o usuário
   aperta "Analisar saúde agora" no app (stationsController.analisarFotoAgora).
   Devolve o resultado da IA. */
async function analisarFoto({ fotoId, jpeg, station, leitura, config, capturedAt = new Date(), manterSeFalhar = false }) {
  // O quadro da iluminação vai junto, na mesma chamada da IA (se houver).
  const luzBuffer = await quadroDeLuzPara(station, capturedAt).catch(() => null);
  let r = await analisar({ jpegBuffer: jpeg, luzBuffer, estacao: station, leitura, config });
  /* O quadro de luz é extra: se a análise com ele falhar (imagem recusada,
     por exemplo), a foto é analisada de novo sem ele. Saúde e pragas nunca
     se perdem por causa da luz. */
  if (!r.ok && luzBuffer) {
    console.warn(`[foto] estação ${station.id}: análise com o quadro de luz falhou (${r.motivo}); repetindo sem ele`);
    r = await analisar({ jpegBuffer: jpeg, estacao: station, leitura, config });
  }
  if (!r.ok) console.warn(`[foto] estação ${station.id}: IA não analisou — ${r.motivo}`);
  /* Reanálise manual que falhou: a análise que a foto já tinha continua
     valendo. Sem isto, um timeout da IA trocava um diagnóstico bom por
     "Análise indisponível". */
  if (!r.ok && manterSeFalhar) return r;

  const iaRaw = {
    provider: r.provider,
    model: r.model,
    ok: r.ok,
    motivo: r.ok ? null : r.motivo,
    resposta: r.raw || null,
  };
  await db.query(
    `UPDATE station_photos
        SET health_status = $2, analysis_text = $3, ia_raw = $4, pragas = $5, pragas_descricao = $6,
            luz_nivel = $7, luz_descricao = $8
      WHERE id = $1`,
    [
      fotoId,
      r.ok ? r.health_status : "indefinido",
      r.ok ? r.analysis_text : "Análise indisponível no momento.",
      JSON.stringify(iaRaw),
      r.ok ? r.pragas : null,
      r.ok ? r.pragas_descricao : null,
      r.ok ? r.luz_nivel : null,
      r.ok ? r.luz_descricao : null,
    ]
  );
  // Avisos no sino: atenção, praga, pouca/muita luz.
  notificacoes.daAnalise(station, r);
  // O resumo do dia ganha esta foto já (o gráfico de saúde não espera 10 min).
  relatorios.atualizarResumo(station.id, relatorios.diaSP(0)).catch((e) =>
    console.error("[foto] resumo do dia:", e.message)
  );
  // A tela Câmera/Home aberta recarrega a foto sem esperar o usuário.
  realtime.enviarParaUsuario(station.user_id, { tipo: "foto", station_id: station.id });

  /* Sugestao da IA. O autoAjuste decide se aplica sozinho ou so registra -
     ele e quem conhece o cooldown e o ia_autoajuste da estacao. */
  if (r.ok && r.suggestion) {
    const reg = await autoAjuste.registrar({
      stationId: station.id,
      sugestao: r.suggestion,
      origem: "ia_foto",
    });
    if (process.env.DEVICE_LOG === "1") {
      console.log(
        `[foto] sugestao ${reg.sugestao.id}: ` +
          (reg.aplicada ? "APLICADA automaticamente" : `so registrada (${reg.motivo})`)
      );
    }
  }

  if (process.env.DEVICE_LOG === "1") {
    console.log(
      `[foto] estação ${station.id} ${(jpeg.length / 1024).toFixed(1)} kB -> ${r.ok ? r.health_status : "indefinido"}` +
        (r.ok && r.suggestion ? " (+sugestão)" : "")
    );
  }
  return r;
}


// ------------------------------------------------------------- luz
/* POST /api/device/luz — quadro da ILUMINAÇÃO (cam-2.1.0).
   A CAM o tira ~20 s antes da foto da IA, sem flash, com a luz de cultivo
   acesa e exposição travada. Só guarda o último por estação; a análise da
   foto seguinte o manda junto para a IA, que diz pouca/boa/muita luz. */
async function luz(req, res, next) {
  try {
    const jpeg = req.corpoBruto;
    if (!jpeg || jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      return res.status(400).json({ error: "O corpo não é um JPEG" });
    }
    const epoch = Number(req.headers["x-captured-at"] || 0);
    const capturedAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
    await db.query(
      `INSERT INTO luz_frames (station_id, image_url, captured_at) VALUES ($1, $2, $3)
       ON CONFLICT (station_id) DO UPDATE SET image_url = EXCLUDED.image_url, captured_at = EXCLUDED.captured_at`,
      [req.station.id, `data:image/jpeg;base64,${jpeg.toString("base64")}`, capturedAt]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Minutos desde a meia-noite em São Paulo.
function minutosSP(data) {
  const p = new Date(data).toLocaleTimeString("en-GB", { timeZone: "America/Sao_Paulo", hour12: false }).split(":");
  return Number(p[0]) * 60 + Number(p[1]);
}

// A luz de cultivo deveria estar acesa neste horário, pela rotina?
function dentroDoFotoperiodo(station, data) {
  const horas = Number(station.light_hours);
  if (!Number.isFinite(horas) || horas <= 0) return false;
  if (horas >= 24) return true;
  const m = String(station.luz_inicio || "06:00").match(/^(\d{1,2}):(\d{2})/);
  const inicio = m ? Number(m[1]) * 60 + Number(m[2]) : 360;
  const fim = (inicio + Math.round(horas * 60)) % 1440;
  const agora = minutosSP(data);
  return inicio < fim ? agora >= inicio && agora < fim : agora >= inicio || agora < fim;
}

/* O quadro de luz que combina com uma foto: tirado até 5 min antes dela e
   dentro do fotoperíodo. Fora do horário de luz a planta está no escuro de
   propósito, e "pouca luz" seria um falso alarme: aí não vai quadro. */
async function quadroDeLuzPara(station, fotoCapturadaEm) {
  const { rows } = await db.query("SELECT image_url, captured_at FROM luz_frames WHERE station_id = $1", [station.id]);
  const q = rows[0];
  if (!q) return null;
  const dif = new Date(fotoCapturadaEm).getTime() - new Date(q.captured_at).getTime();
  if (dif < -60 * 1000 || dif > 5 * 60 * 1000) return null;
  if (!dentroDoFotoperiodo(station, q.captured_at)) return null;
  const b64 = String(q.image_url).split(",")[1];
  return b64 ? Buffer.from(b64, "base64") : null;
}

// analisarFoto também atende o botão "Analisar saúde agora" do app.
module.exports = { telemetria, foto, luz, analisarFoto };
