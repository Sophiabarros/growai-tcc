const db = require("../config/db");
const { WEEKDAYS } = require("../services/mockSensor");

const TIMEZONE = "America/Sao_Paulo";

/* Relatório semanal por estação, da semana atual (Seg..Dom, fuso de São
   Paulo), só com dados REAIS:

   - environment: média da umidade por dia, de sensor_readings;
   - health: % de fotos 'saudavel' por dia, de station_photos.

   As fotos 'indefinido' (IA desligada, falhou ou deu timeout) ficam FORA da
   conta: entrar como 0% diria "a planta piorou" quando o que houve foi uma
   falha da análise. Dia sem foto nenhuma, ou só com 'indefinido', vale 0 —
   o gráfico começa vazio e se preenche conforme a câmera envia. */
async function getWeekly(req, res, next) {
  try {
    const { rows: stations } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at",
      [req.user.id]
    );

    const reports = await Promise.all(
      stations.map(async (station) => {
        const [ambiente, saude] = await Promise.all([
          db.query(
            `SELECT extract(isodow FROM recorded_at AT TIME ZONE $2)::int AS dow,
                    round(avg(humidity))::int AS value
               FROM sensor_readings
              WHERE station_id = $1
                AND humidity IS NOT NULL
                AND (recorded_at AT TIME ZONE $2) >= date_trunc('week', now() AT TIME ZONE $2)
              GROUP BY dow`,
            [station.id, TIMEZONE]
          ),
          db.query(
            `SELECT extract(isodow FROM captured_at AT TIME ZONE $2)::int AS dow,
                    round(
                      100.0 * count(*) FILTER (WHERE health_status = 'saudavel') / count(*)
                    )::int AS value
               FROM station_photos
              WHERE station_id = $1
                AND health_status <> 'indefinido'
                AND (captured_at AT TIME ZONE $2) >= date_trunc('week', now() AT TIME ZONE $2)
              GROUP BY dow`,
            [station.id, TIMEZONE]
          ),
        ]);

        const porDiaAmbiente = new Map(ambiente.rows.map((r) => [r.dow, r.value]));
        const porDiaSaude = new Map(saude.rows.map((r) => [r.dow, r.value]));

        return {
          station_id: station.id,
          station_name: station.name,
          plant: station.plant,
          health: WEEKDAYS.map((day, i) => ({ day, value: porDiaSaude.get(i + 1) || 0 })),
          environment: WEEKDAYS.map((day, i) => ({ day, value: porDiaAmbiente.get(i + 1) || 0 })),
        };
      })
    );

    res.json(reports);
  } catch (err) {
    next(err);
  }
}

module.exports = { getWeekly };
