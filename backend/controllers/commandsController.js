const db = require("../config/db");

const RELES = ["bomba", "nutri", "luz", "vent"];
const ACOES = ["ligar", "desligar"];
const DUR_MAX_S = 3600;

/* "Online" quer dizer coisas diferentes para cada placa, e usar o mesmo prazo
   para as duas dava um resultado errado.

   A 'main' fica acordada e manda telemetria a cada 15 s: 60 s sem falar já é
   problema.

   A 'cam' passa a vida em DEEP SLEEP. Ela acorda a cada 30 min, tira a foto,
   manda e dorme de novo — fica acordada menos de 90 s por ciclo. Com o prazo
   de 60 s ela apareceria como offline em ~97% do tempo, mesmo funcionando
   perfeitamente. O prazo dela é de ~3 ciclos perdidos. */
const ONLINE_S = 60;              // placa main
const ONLINE_CAM_S = 95 * 60;     // placa cam: ~3 ciclos de foto de 30 min

// Confirma que a estação é do usuário do token antes de qualquer coisa.
async function estacaoDoUsuario(stationId, userId) {
  const { rows } = await db.query("SELECT id FROM stations WHERE id = $1 AND user_id = $2", [stationId, userId]);
  return rows[0] || null;
}

/* Cria um comando manual. Ele fica 'pendente' até a placa pedir a próxima
   telemetria — o servidor não consegue chamar a placa.

   Os limites de segurança de verdade (20 s de bomba, 30 s de nutriente por
   dia) são do firmware e não dependem daqui. A validação abaixo existe para o
   app receber um erro claro em vez de enfileirar algo que a placa vai cortar
   em silêncio. */
async function create(req, res, next) {
  try {
    if (!(await estacaoDoUsuario(req.params.id, req.user.id))) {
      return res.status(404).json({ error: "Estação não encontrada" });
    }

    const { rele, acao } = req.body || {};
    if (!RELES.includes(rele)) {
      return res.status(400).json({ error: `rele precisa ser um de: ${RELES.join(", ")}` });
    }
    if (!ACOES.includes(acao)) {
      return res.status(400).json({ error: `acao precisa ser ${ACOES.join(" ou ")}` });
    }

    let dur_s = null;
    if (acao === "ligar") {
      const n = Number(req.body.dur_s);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: "dur_s precisa ser um número inteiro de segundos maior que zero" });
      }
      if (n > DUR_MAX_S) {
        return res.status(400).json({ error: `dur_s no máximo ${DUR_MAX_S} s (1 hora)` });
      }
      dur_s = n;
      // Aviso, não erro: a placa corta em 20 s e o comando ainda é válido.
      if (rele === "bomba" && n > 20) {
        res.set("X-Aviso", "a placa limita a bomba a 20 s por acionamento");
      }
    }

    const { rows } = await db.query(
      `INSERT INTO commands (station_id, rele, acao, dur_s, origem, status)
       VALUES ($1, $2, $3, $4, 'manual', 'pendente')
       RETURNING *`,
      [req.params.id, rele, acao, dur_s]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    if (!(await estacaoDoUsuario(req.params.id, req.user.id))) {
      return res.status(404).json({ error: "Estação não encontrada" });
    }
    const { rows } = await db.query(
      `SELECT * FROM commands WHERE station_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// Placas da estação. O key_hash NUNCA sai daqui.
async function listDevices(req, res, next) {
  try {
    if (!(await estacaoDoUsuario(req.params.id, req.user.id))) {
      return res.status(404).json({ error: "Estação não encontrada" });
    }
    const { rows } = await db.query(
      `SELECT id, tipo, nome, fw, last_seen, created_at,
              (last_seen IS NOT NULL
               AND last_seen > now() - ((CASE WHEN tipo = 'cam' THEN $3 ELSE $2 END) || ' seconds')::interval
              ) AS online
         FROM devices
        WHERE station_id = $1
        ORDER BY tipo`,
      [req.params.id, String(ONLINE_S), String(ONLINE_CAM_S)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, listDevices, ONLINE_S, ONLINE_CAM_S };
