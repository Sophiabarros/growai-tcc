const db = require("../config/db");
const { WEEKDAYS } = require("../services/mockSensor");
const { atualizarResumo, diaSP, TZ } = require("../services/relatorios");

const n = (v) => (v === null || v === undefined ? null : Number(v));

/* GET /api/reports/weekly
   Semana atual (Seg..Dom, fuso de São Paulo), por estação, a partir do
   resumo diário GUARDADO (relatorio_diario). O dia de hoje é recalculado
   antes de responder, para o gráfico não ficar 10 min atrasado.

   Dia sem dado vem como null, não como 0: zero diria "a planta morreu"
   quando o que houve foi "não tinha foto/leitura". O app desenha a lacuna.

   Saúde = % das fotos ANALISADAS no dia que a IA julgou "saudável". Foto
   'indefinido' (IA desligada, falhou) fica fora da conta. */
async function getWeekly(req, res, next) {
  try {
    const { rows: stations } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at, id",
      [req.user.id]
    );
    const hoje = diaSP(0);
    await Promise.all(stations.map((s) => atualizarResumo(s.id, hoje)));

    const reports = await Promise.all(
      stations.map(async (station) => {
        const { rows } = await db.query(
          /* r.* ANTES do dia: com r.* depois, o r.dia (nulo no dia sem resumo)
             sobrescrevia o dia da série, e o app recebia dia = null (datas
             erradas e dias futuros nunca marcados como futuros). */
          `SELECT r.*, to_char(d.dia, 'YYYY-MM-DD') AS dia
             FROM generate_series(
                    date_trunc('week', now() AT TIME ZONE $2)::date,
                    date_trunc('week', now() AT TIME ZONE $2)::date + 6,
                    interval '1 day'
                  ) AS d(dia)
             LEFT JOIN relatorio_diario r ON r.station_id = $1 AND r.dia = d.dia::date
            ORDER BY d.dia`,
          [station.id, TZ]
        );
        const dias = rows.map((r, i) => ({
          dia: r.dia,
          label: WEEKDAYS[i],
          futuro: r.dia > hoje,
          saude_pct: n(r.saude_pct),
          fotos_analisadas: r.fotos_analisadas || 0,
          fotos_atencao: r.fotos_atencao || 0,
          umidade_media: n(r.umidade_media),
          temp_media: n(r.temp_media),
          temp_min: n(r.temp_min),
          temp_max: n(r.temp_max),
          luz_h: r.luz_s == null ? null : Math.round((r.luz_s / 3600) * 10) / 10,
          uv_min: r.uv_s == null ? null : Math.round(r.uv_s / 60),
        }));
        return {
          station_id: station.id,
          station_name: station.name,
          plant: station.plant,
          dias,
          // Formato antigo, mantido para quem já lia: agora com null no dia vazio.
          health: dias.map((d) => ({ day: d.label, value: d.saude_pct })),
          environment: dias.map((d) => ({ day: d.label, value: d.umidade_media })),
        };
      })
    );

    res.json(reports);
  } catch (err) {
    next(err);
  }
}

/* GET /api/reports/daily?station_id=11&dia=2026-10-15
   Um dia hora a hora (padrão: hoje). Sai das tabelas brutas, que ficam
   RETENCAO_LEITURAS_DIAS; o resumo do dia sai do relatorio_diario. */
async function getDaily(req, res, next) {
  try {
    const { rows: donas } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at, id",
      [req.user.id]
    );
    const station = req.query.station_id
      ? donas.find((s) => String(s.id) === String(req.query.station_id))
      : donas[0];
    if (!station) return res.status(404).json({ error: "Estação não encontrada" });

    const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dia || "")) ? req.query.dia : diaSP(0);
    await atualizarResumo(station.id, dia);

    const [leit, fot, resumo] = await Promise.all([
      db.query(
        `SELECT extract(hour FROM recorded_at AT TIME ZONE $3)::int AS hora,
                round(avg(humidity), 1) AS umidade, round(avg(temperature), 1) AS temp
           FROM sensor_readings
          WHERE station_id = $1 AND (recorded_at AT TIME ZONE $3)::date = $2::date
          GROUP BY hora`,
        [station.id, dia, TZ]
      ),
      db.query(
        `SELECT extract(hour FROM captured_at AT TIME ZONE $3)::int AS hora,
                count(*) FILTER (WHERE health_status <> 'indefinido')::int AS analisadas,
                count(*) FILTER (WHERE health_status = 'saudavel')::int    AS saudaveis
           FROM station_photos
          WHERE station_id = $1 AND (captured_at AT TIME ZONE $3)::date = $2::date
          GROUP BY hora`,
        [station.id, dia, TZ]
      ),
      db.query("SELECT * FROM relatorio_diario WHERE station_id = $1 AND dia = $2::date", [station.id, dia]),
    ]);

    const porHoraL = new Map(leit.rows.map((r) => [r.hora, r]));
    const porHoraF = new Map(fot.rows.map((r) => [r.hora, r]));
    const horaAgora = dia === diaSP(0)
      ? Number(new Date().toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }))
      : 23;

    const horas = Array.from({ length: 24 }, (_, h) => {
      const l = porHoraL.get(h);
      const f = porHoraF.get(h);
      return {
        hora: h,
        futuro: h > horaAgora,
        saude_pct: f && f.analisadas ? Math.round((100 * f.saudaveis) / f.analisadas) : null,
        fotos_analisadas: f ? f.analisadas : 0,
        umidade: l ? n(l.umidade) : null,
        temp: l ? n(l.temp) : null,
      };
    });

    const r = resumo.rows[0] || null;
    res.json({
      station_id: station.id,
      station_name: station.name,
      plant: station.plant,
      dia,
      horas,
      resumo: r && {
        saude_pct: n(r.saude_pct),
        fotos_analisadas: r.fotos_analisadas,
        fotos_atencao: r.fotos_atencao,
        umidade_media: n(r.umidade_media),
        temp_media: n(r.temp_media),
        luz_h: r.luz_s == null ? null : Math.round((r.luz_s / 3600) * 10) / 10,
        uv_min: r.uv_s == null ? null : Math.round(r.uv_s / 60),
      },
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ água
   GET /api/reports/agua?station_id=11&dias=30

   Quanto a bomba ligou por dia (relatorio_diario.bomba_s, que vem do
   contador hoje_s.bomba da placa) convertido em litros, comparado com um
   timer comum: regar a cada `water_interval_h` horas (o "Rega a cada" da
   estação) pelo MESMO tempo de cada rega da placa. A diferença é a água que
   a rega por umidade deixou de gastar.

   É uma ESTIMATIVA e o app diz isso: a vazão é a da bomba informada (ou a de
   referência), e o timer é hipotético. */
const REGA_S = 315; // tempo mínimo de cada rega no main-1.6.0: 5 min enchendo os canos + 15 s de dose
const VAZAO_PADRAO_LPM = Number(process.env.BOMBA_LPM) || 1.5; // mini bomba 12 V de referência

async function getAgua(req, res, next) {
  try {
    const { rows: donas } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at, id",
      [req.user.id]
    );
    const station = req.query.station_id
      ? donas.find((s) => String(s.id) === String(req.query.station_id))
      : donas[0];
    if (!station) return res.status(404).json({ error: "Estação não encontrada" });

    const dias = Math.min(90, Math.max(7, Number(req.query.dias) || 30));
    await atualizarResumo(station.id, diaSP(0));

    const { rows } = await db.query(
      `SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia, r.bomba_s, r.leituras
         FROM generate_series((now() AT TIME ZONE $2)::date - ($3::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day') AS d(dia)
         LEFT JOIN relatorio_diario r ON r.station_id = $1 AND r.dia = d.dia::date
        ORDER BY d.dia`,
      [station.id, TZ, dias]
    );

    const vazao = n(station.bomba_lpm) || VAZAO_PADRAO_LPM;
    const intervalo = Math.max(1, n(station.water_interval_h) || 8);
    const fixoSDia = (24 / intervalo) * REGA_S;
    const litros = (seg) => Math.round(((seg / 60) * vazao) * 10) / 10;

    /* Só conta o dia em que a placa principal mandou dado (bomba_s não nulo):
       dia sem telemetria não é "economizou tudo", é "não se sabe". */
    const lista = rows.map((r) => {
      const temDado = r.bomba_s !== null && r.bomba_s !== undefined;
      return {
        dia: r.dia,
        bomba_s: temDado ? Number(r.bomba_s) : null,
        litros: temDado ? litros(Number(r.bomba_s)) : null,
        litros_fixo: temDado ? litros(fixoSDia) : null,
      };
    });
    const comDado = lista.filter((d) => d.bomba_s !== null);
    const somaReal = comDado.reduce((a, d) => a + d.litros, 0);
    const somaFixo = comDado.reduce((a, d) => a + d.litros_fixo, 0);

    res.json({
      station_id: station.id,
      station_name: station.name,
      plant: station.plant,
      vazao_lpm: vazao,
      vazao_informada: n(station.bomba_lpm) != null,
      rega_fixa: { intervalo_h: intervalo, duracao_s: REGA_S, regas_por_dia: Math.round((24 / intervalo) * 10) / 10 },
      dias: lista,
      total: {
        dias_com_dado: comDado.length,
        litros: Math.round(somaReal * 10) / 10,
        litros_fixo: Math.round(somaFixo * 10) / 10,
        economia_litros: Math.round((somaFixo - somaReal) * 10) / 10,
        economia_pct: somaFixo > 0 ? Math.round((100 * (somaFixo - somaReal)) / somaFixo) : null,
        bomba_min: Math.round(comDado.reduce((a, d) => a + d.bomba_s, 0) / 60),
      },
    });
  } catch (err) {
    next(err);
  }
}

/* ----------------------------------------------------------- diário da IA
   GET /api/reports/diario-ia

   Tudo o que a IA decidiu, numa lista só e com o motivo de cada coisa:
     analise  - cada foto analisada (saúde, pragas, luz, modelo usado)
     ajuste   - rotina que a IA mudou sozinha (dá para desfazer)
     sugestao - rotina que a IA propôs e espera a pessoa aplicar
     luz      - LED de cultivo apagado/aceso pela IA (luz natural)
   Sai das tabelas que já existem; nada é gravado só para isto. */
async function getDiarioIa(req, res, next) {
  try {
    const uid = req.user.id;
    const limite = Math.min(120, Math.max(10, Number(req.query.limite) || 60));
    const [fotos, sugestoes, luz] = await Promise.all([
      db.query(
        `SELECT p.id, p.station_id, s.name AS station_name, s.plant, p.captured_at AS em,
                p.health_status, p.analysis_text, p.pragas, p.pragas_descricao,
                p.luz_nivel, p.luz_descricao, p.ia_raw->>'model' AS modelo
           FROM station_photos p JOIN stations s ON s.id = p.station_id
          WHERE s.user_id = $1 AND p.health_status <> 'indefinido'
          ORDER BY p.captured_at DESC LIMIT $2`,
        [uid, limite]
      ),
      db.query(
        `SELECT sg.id, sg.station_id, s.name AS station_name, s.plant, sg.created_at AS em,
                sg.message, sg.config, sg.config_anterior, sg.origem, sg.applied,
                sg.auto_aplicada, sg.desfeita_em, sg.growth_pct, sg.health_pct
           FROM suggestions sg JOIN stations s ON s.id = sg.station_id
          WHERE s.user_id = $1 AND sg.origem IN ('ia_foto', 'ia_rotina')
          ORDER BY sg.created_at DESC LIMIT $2`,
        [uid, limite]
      ),
      db.query(
        `SELECT n.id, n.station_id, s.name AS station_name, s.plant, n.criado_em AS em, n.titulo, n.mensagem
           FROM notificacoes n LEFT JOIN stations s ON s.id = n.station_id
          WHERE n.user_id = $1 AND n.tipo = 'luz' AND n.titulo LIKE 'A IA %'
          ORDER BY n.criado_em DESC LIMIT $2`,
        [uid, limite]
      ),
    ]);

    const eventos = [
      ...fotos.rows.map((f) => ({ tipo: "analise", ...f })),
      ...sugestoes.rows.map((sg) => ({ tipo: sg.auto_aplicada ? "ajuste" : "sugestao", ...sg })),
      ...luz.rows.map((l) => ({ tipo: "luz", apagou: /apagou/.test(l.titulo), ...l })),
    ]
      .sort((a, b) => new Date(b.em) - new Date(a.em))
      .slice(0, limite);

    // Resumo do topo: o que a IA fez nos últimos 7 dias.
    const semana = Date.now() - 7 * 86400000;
    const recentes = eventos.filter((e) => new Date(e.em).getTime() >= semana);
    res.json({
      resumo: {
        analises: recentes.filter((e) => e.tipo === "analise").length,
        pragas: recentes.filter((e) => e.tipo === "analise" && e.pragas === "sim").length,
        ajustes: recentes.filter((e) => e.tipo === "ajuste" && !e.desfeita_em).length,
        luz: recentes.filter((e) => e.tipo === "luz").length,
      },
      eventos,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getWeekly, getDaily, getAgua, getDiarioIa };
