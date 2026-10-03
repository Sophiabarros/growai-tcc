#!/usr/bin/env node
// Cadastra uma placa numa estação e imprime a chave dela UMA única vez.
//
//   node scripts/criar-dispositivo.js <station_id> <main|cam> [nome]
//   npm run criar-dispositivo -- 1 main "ESP32 principal"
//
// O banco guarda apenas o sha256 da chave. Não existe "recuperar a chave":
// se você perder, rode de novo e a antiga para de valer.

require("dotenv").config();
const crypto = require("crypto");
const db = require("../config/db");
const { hashChave } = require("../middleware/deviceAuth");

async function main() {
  const [stationIdArg, tipo, ...restoNome] = process.argv.slice(2);
  const nome = restoNome.join(" ").trim() || null;

  if (!stationIdArg || !["main", "cam"].includes(tipo)) {
    console.error("Uso: node scripts/criar-dispositivo.js <station_id> <main|cam> [nome]");
    console.error("Ex.:  node scripts/criar-dispositivo.js 1 main \"ESP32 principal\"");
    process.exit(1);
  }
  const stationId = Number(stationIdArg);
  if (!Number.isInteger(stationId) || stationId <= 0) {
    console.error("station_id precisa ser um inteiro positivo.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL não está definida (veja backend/.env).");
    process.exit(1);
  }

  const { rows: estacoes } = await db.query(
    `SELECT s.id, s.name, s.plant, u.email
       FROM stations s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [stationId]
  );
  const estacao = estacoes[0];
  if (!estacao) {
    console.error(`Estação ${stationId} não existe. Estações disponíveis:`);
    const { rows } = await db.query(
      `SELECT s.id, s.name, u.email FROM stations s JOIN users u ON u.id = s.user_id ORDER BY s.id`
    );
    rows.forEach((r) => console.error(`  ${r.id}  ${r.name}  (${r.email})`));
    process.exit(1);
  }

  const { rows: existentes } = await db.query(
    "SELECT id, nome, last_seen FROM devices WHERE station_id = $1 AND tipo = $2",
    [stationId, tipo]
  );

  // 32 bytes em base64url: forte o bastante e sem caractere que atrapalhe num
  // #define de C nem numa variável de ambiente.
  const chave = crypto.randomBytes(32).toString("base64url");

  await db.query(
    `INSERT INTO devices (station_id, tipo, nome, key_hash) VALUES ($1, $2, $3, $4)`,
    [stationId, tipo, nome || (tipo === "main" ? "ESP32 principal" : "ESP32-CAM"), hashChave(chave)]
  );

  const rota = tipo === "main" ? "POST /api/device/telemetria" : "POST /api/device/foto";
  const pasta = tipo === "main" ? "firmware/esp32-main" : "firmware/esp32-cam";

  console.log("");
  console.log(`Placa '${tipo}' criada na estação ${estacao.id} — ${estacao.name} (${estacao.plant})`);
  console.log(`Dono: ${estacao.email}`);
  if (existentes.length) {
    console.log("");
    console.log(`AVISO: já havia ${existentes.length} placa(s) '${tipo}' nesta estação.`);
    console.log("As antigas continuam valendo. Se a ideia era substituir, apague a antiga:");
    existentes.forEach((d) => console.log(`  DELETE FROM devices WHERE id = ${d.id};   -- ${d.nome || "sem nome"}`));
  }
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────────────────┐");
  console.log("  │ CHAVE (aparece só esta vez — copie agora)                       │");
  console.log("  └─────────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  ${chave}`);
  console.log("");
  console.log(`Cole no ${pasta}/include/secrets.h:`);
  console.log("");
  console.log(`  #define DEVICE_KEY "${chave}"`);
  console.log("");
  console.log(`Essa chave abre só ${rota}, e só para a estação ${estacao.id}.`);
  console.log("Ela não dá acesso a conta nenhuma. O banco guardou apenas o sha256:");
  console.log("perdeu, gera outra (e a antiga para de valer).");
  console.log("");
}

main()
  .then(() => db.pool.end())
  .catch(async (err) => {
    console.error("\nFalhou:", err.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
