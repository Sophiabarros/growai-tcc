const { Pool } = require("pg");

/* Um pool só para o processo inteiro: o require() guarda este módulo em cache,
   então todo controller que importa config/db usa a mesma instância.

   SSL: a connection string do Neon já traz ?sslmode=require e isso basta.
   DB_SSL=true força SSL para bancos cuja URL não diz nada (ou quando o
   provedor exige CA própria, passada em DB_SSL_CA). */
function sslConfig() {
  if (String(process.env.DB_SSL || "").toLowerCase() !== "true") return undefined;
  const ssl = { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" };
  if (process.env.DB_SSL_CA) ssl.ca = process.env.DB_SSL_CA.replace(/\\n/g, "\n");
  return ssl;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max: Number(process.env.DB_POOL_MAX) || 10,
});

pool.on("error", (err) => {
  console.error("Erro inesperado no pool do PostgreSQL:", err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
