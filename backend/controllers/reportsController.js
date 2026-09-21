const db = require("../config/db");
const { WEEKDAYS } = require("../services/mockSensor");

const TIMEZONE = "America/Sao_Paulo";

// Relatório semanal por estação: uma média por dia da semana atual
// (Seg..Dom, fuso de São Paulo) calculada só com leituras REAIS gravadas em
// sensor_readings. Dia sem leitura vale 0 - o relatório começa zerado e vai
// se preenchendo conforme o ESP32 enviar dados. Nada é simulado aqui (as
// leituras de demonstração de GET /stations/:id/readings/latest não são mais
// gravadas no banco).
async function getWeekly(req, res, next) {
  try {
    const { rows: stations } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at",
      [req.user.id]
    );

    const reports = await Promise.all(
      stations.map(async (station) => {
        const { rows } = await db.query(
          `SELECT extract(isodow FROM recorded_at AT TIME ZONE $2)::int AS dow,
                  round(avg(humidity))::int AS value
           FROM sensor_readings
           WHERE station_id = $1
             AND (recorded_at AT TIME ZONE $2) >= date_trunc('week', now() AT TIME ZONE $2)
           GROUP BY dow`,
          [station.id, TIMEZONE]
        );

        const byDay = new Map(rows.map((r) => [r.dow, r.value]));
        const series = WEEKDAYS.map((day, i) => ({ day, value: byDay.get(i + 1) || 0 }));

        return {
          station_id: station.id,
          station_name: station.name,
          plant: station.plant,
          health: series,
          environment: series,
        };
      })
    );

    res.json(reports);
  } catch (err) {
    next(err);
  }
}

module.exports = { getWeekly };
