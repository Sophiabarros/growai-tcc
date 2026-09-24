// Tokens de redefinição de senha.
//
// O token enviado por e-mail é aleatório (32 bytes) e NUNCA é guardado em
// texto puro: no banco fica só o hash SHA-256, então um vazamento da tabela
// não permite redefinir a senha de ninguém. Cada token expira (padrão: 30
// minutos, RESET_TOKEN_TTL_MIN) e só vale uma vez (used_at).

const crypto = require("crypto");
const db = require("../config/db");

const TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MIN) || 30;
// Um usuário não recebe outro e-mail em menos que isso (evita spam de e-mails).
const COOLDOWN_SECONDS = 60;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// Cria a tabela na primeira utilização, para o recurso funcionar sem uma
// migração manual no banco de produção. O mesmo SQL está em db/schema.sql.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db
      .query(
        `CREATE TABLE IF NOT EXISTS password_resets (
           id         SERIAL PRIMARY KEY,
           user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           token_hash TEXT NOT NULL UNIQUE,
           expires_at TIMESTAMPTZ NOT NULL,
           used_at    TIMESTAMPTZ,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .catch((err) => {
        tableReady = null; // tenta de novo na próxima requisição
        throw err;
      });
  }
  return tableReady;
}

/**
 * Gera um token novo para o usuário e invalida os anteriores ainda abertos.
 * @returns {Promise<string|null>} o token em texto puro (para o e-mail), ou
 *          null se o usuário pediu outro há menos de COOLDOWN_SECONDS.
 */
async function createToken(userId) {
  await ensureTable();

  const recent = await db.query(
    `SELECT 1 FROM password_resets
      WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)
      LIMIT 1`,
    [userId, COOLDOWN_SECONDS]
  );
  if (recent.rowCount > 0) return null;

  await db.query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [userId]);

  const token = crypto.randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [userId, hashToken(token), TTL_MINUTES]
  );
  return token;
}

/**
 * Consome o token dentro de uma transação já aberta (client). Atômico: duas
 * requisições com o mesmo token não conseguem ambas ter sucesso.
 * @returns {Promise<number|null>} id do usuário dono do token, ou null se o
 *          token não existe, já foi usado ou expirou.
 */
async function consumeToken(client, token) {
  const { rows } = await client.query(
    `UPDATE password_resets
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)]
  );
  return rows[0] ? rows[0].user_id : null;
}

module.exports = { ensureTable, createToken, consumeToken, TTL_MINUTES };
