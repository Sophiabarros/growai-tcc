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
          `SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia, r.*
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

module.exports = { getWeekly, getDaily };
