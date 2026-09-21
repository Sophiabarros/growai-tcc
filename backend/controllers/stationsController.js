const db = require("../config/db");
const { generateReading } = require("../services/mockSensor");

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT * FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Estação não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target } = req.body;
    if (!name || !plant) {
      return res.status(400).json({ error: "Nome e planta são obrigatórios" });
    }

    const { rows } = await db.query(
      `INSERT INTO stations (user_id, name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target)
       VALUES ($1, $2, $3, $4,
               COALESCE($5, 8), COALESCE($6, 12), COALESCE($7, 70), COALESCE($8, 6.5))
       RETURNING *`,
      [req.user.id, name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { water_interval_h, light_hours, humidity_target, ph_target } = req.body;
    const { rows } = await db.query(
      `UPDATE stations
       SET water_interval_h = COALESCE($1, water_interval_h),
           light_hours      = COALESCE($2, light_hours),
           humidity_target  = COALESCE($3, humidity_target),
           ph_target        = COALESCE($4, ph_target)
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [water_interval_h, light_hours, humidity_target, ph_target, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Estação não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { rowCount } = await db.query(
      "DELETE FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: "Estação não encontrada" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// Gera uma leitura simulada (NÃO grava no banco) - ver services/mockSensor.js
// para trocar por integração real com o ESP32 no futuro. Não persistir evita
// que valores inventados entrem no relatório semanal, que só conta leituras
// reais de sensor_readings.
async function getLatestReading(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT * FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const station = rows[0];
    if (!station) return res.status(404).json({ error: "Estação não encontrada" });

    res.json({ ...generateReading(station), recorded_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

// Última foto/status de saúde da estação (tela Câmera).
async function getLatestPhoto(req, res, next) {
  try {
    const { rows: stationRows } = await db.query(
      "SELECT id FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!stationRows[0]) return res.status(404).json({ error: "Estação não encontrada" });

    const { rows } = await db.query(
      `SELECT * FROM station_photos WHERE station_id = $1
       ORDER BY captured_at DESC LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Nenhuma foto registrada ainda" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getOne, create, update, remove, getLatestReading, getLatestPhoto };
