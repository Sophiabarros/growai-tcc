// Registro de cada chamada feita à IA (Gemini/Claude), para o painel de
// desenvolvedor saber quanto da cota já foi e por que a IA falhou.
//
// A API do Gemini não diz quanto sobra da cota gratuita: só responde 429
// quando acaba. Então contamos nós mesmos. Uma linha por requisição HTTP:
// status 200 conta como uso; 429 é "cota acabou"; 5xx/timeout é instabilidade
// do provedor (não gasta cota).
//
// A tabela é criada no primeiro uso (como password_resets), sem migração à
// mão. registrar() nunca lança: o log é extra e não pode derrubar a análise.

const db = require("../config/db");

let pronta = null;
function garantirTabela() {
  if (!pronta) {
    pronta = db
      .query(
        `CREATE TABLE IF NOT EXISTS ia_uso (
           id        SERIAL PRIMARY KEY,
           em        TIMESTAMPTZ NOT NULL DEFAULT now(),
           modo      TEXT,         -- foto | rotina | vera | teste
           provedor  TEXT,         -- gemini | claude
           modelo    TEXT,
           status    INTEGER,      -- HTTP; 0 = não respondeu a tempo
           ok        BOOLEAN NOT NULL DEFAULT false,
           tokens    INTEGER,
           erro      TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_ia_uso_em ON ia_uso (em DESC);`
      )
      .catch((err) => {
        pronta = null; // tenta de novo na próxima
        throw err;
      });
  }
  return pronta;
}

/* Guarda os últimos dias só: o painel mostra hoje e a semana. */
let ultimaLimpeza = 0;
function limparVelhos() {
  if (Date.now() - ultimaLimpeza < 6 * 3600 * 1000) return;
  ultimaLimpeza = Date.now();
  db.query("DELETE FROM ia_uso WHERE em < now() - interval '30 days'").catch(() => {});
}

async function registrar({ modo = null, provedor = null, modelo = null, status = null, ok = false, tokens = null, erro = null }) {
  try {
    await garantirTabela();
    await db.query(
      "INSERT INTO ia_uso (modo, provedor, modelo, status, ok, tokens, erro) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [modo, provedor, modelo, status, !!ok, Number.isFinite(Number(tokens)) ? Math.round(Number(tokens)) : null, erro ? String(erro).slice(0, 400) : null]
    );
    limparVelhos();
  } catch (err) {
    console.warn("[iaUso] não registrou:", err.message);
  }
}

module.exports = { registrar, garantirTabela };
