#!/usr/bin/env node
// Roda os arquivos de db/migrations/ em ordem, uma vez cada.
//
// Existe em Node (e não como `psql -f`, o estilo dos outros scripts db:*)
// porque o psql não vem instalado no Windows junto com o Node, e o driver pg
// já é dependência do projeto. Assim `npm run db:migrate` funciona na mesma
// máquina em que se roda `npm run dev`, sem instalar mais nada.
//
// Uso:
//   npm run db:migrate            aplica o que falta
//   npm run db:migrate -- --dry   só mostra o que faria
//
// As migrações também são idempotentes por dentro (IF NOT EXISTS etc.), então
// rodar de novo num banco já migrado não quebra nem perde dado. A tabela
// schema_migrations serve para não reexecutar à toa e para deixar registrado
// o que já passou por este banco.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DIR = path.join(__dirname, "migrations");
const seco = process.argv.includes("--dry");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL não está definida (veja backend/.env).");
    process.exit(1);
  }

  const arquivos = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!arquivos.length) {
    console.log("Nenhuma migração em db/migrations/.");
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const alvo = new URL(process.env.DATABASE_URL);
    console.log(`Banco: ${alvo.hostname}${alvo.pathname}`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        nome        TEXT PRIMARY KEY,
        aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query("SELECT nome FROM schema_migrations");
    const jaAplicadas = new Set(rows.map((r) => r.nome));

    let aplicou = 0;
    for (const nome of arquivos) {
      if (jaAplicadas.has(nome)) {
        console.log(`  = ${nome} (já aplicada)`);
        continue;
      }
      if (seco) {
        console.log(`  ~ ${nome} (aplicaria agora)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(DIR, nome), "utf8");
      console.log(`  + ${nome} ...`);
      // O próprio arquivo abre e fecha a transação (BEGIN/COMMIT), então aqui
      // não se envolve numa segunda: se ele falhar no meio, nada fica aplicado.
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (nome) VALUES ($1)", [nome]);
      aplicou++;
    }

    console.log(seco ? "Nada foi executado (--dry)." : `Pronto. ${aplicou} migração(ões) aplicada(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("\nFalhou:", err.message);
  if (err.position) console.error("posição no SQL:", err.position);
  process.exit(1);
});
