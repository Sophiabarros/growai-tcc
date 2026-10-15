// O sino do app: lista e marca como lidas as notificações da pessoa.
// Quem cria as notificações: services/notificacoes.js.

const db = require("../config/db");

// GET /api/notificacoes — as 50 mais recentes e quantas não foram lidas.
async function listar(req, res, next) {
  try {
    const [{ rows: itens }, { rows: cont }] = await Promise.all([
      db.query(
        `SELECT n.id, n.tipo, n.titulo, n.mensagem, n.lida, n.criado_em, n.station_id, s.name AS station_name
           FROM notificacoes n LEFT JOIN stations s ON s.id = n.station_id
          WHERE n.user_id = $1
          ORDER BY n.criado_em DESC
          LIMIT 50`,
        [req.user.id]
      ),
      db.query("SELECT count(*)::int AS n FROM notificacoes WHERE user_id = $1 AND NOT lida", [req.user.id]),
    ]);
    res.json({ nao_lidas: cont[0].n, itens });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/notificacoes/lidas — marca todas como lidas (ao abrir o sino).
async function marcarLidas(req, res, next) {
  try {
    await db.query("UPDATE notificacoes SET lida = true WHERE user_id = $1 AND NOT lida", [req.user.id]);
    res.json({ nao_lidas: 0 });
  } catch (err) {
    next(err);
  }
}

module.exports = { listar, marcarLidas };
