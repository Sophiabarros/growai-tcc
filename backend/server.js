require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const authRoutes = require("./routes/auth");
const stationsRoutes = require("./routes/stations");
const reportsRoutes = require("./routes/reports");
const suggestionsRoutes = require("./routes/suggestions");
const settingsRoutes = require("./routes/settings");
const contactRoutes = require("./routes/contact");
const deviceRoutes = require("./routes/device");
const { requireAuth } = require("./middleware/auth");
const realtime = require("./services/realtime");

// Evita que uma falha assíncrona não capturada (ex.: pool do Postgres
// indisponível) derrube o processo inteiro - loga e mantém a API no ar.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

const app = express();

// CORS_ORIGIN pode ser "*", uma origem única ou uma lista separada por
// vírgula (ex.: "https://growai-claude.vercel.app,https://outro.com").
// Origens de desenvolvimento local (localhost/127.0.0.1, qualquer porta)
// são sempre liberadas além do que estiver configurado - CORS só decide
// quem pode LER a resposta no navegador, a autenticação de verdade
// continua sendo o JWT (requireAuth), então isso não abre nenhuma
// brecha de segurança. Sem isso, testar o front-end estático local
// (Live Server, file://, etc.) contra o backend hospedado falhava com
// "Failed to fetch" mesmo com token válido.
const configuredOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const isLocalDevOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // requests sem Origin (curl, apps nativos)
      if (configuredOrigins.includes("*")) return callback(null, true);
      if (configuredOrigins.includes(origin) || isLocalDevOrigin(origin)) return callback(null, true);
      callback(new Error("Não permitido pelo CORS: " + origin));
    },
    // O aviso de POST /stations/:id/commands vem em header; sem isto o
    // navegador não deixa o JS ler, agora que o site e a API têm domínios
    // diferentes.
    exposedHeaders: ["X-Aviso"],
  })
);
// Telemetria e formulários são pequenos; a foto da ESP32-CAM NÃO passa por
// aqui (é image/jpeg, tratada em routes/device.js com limite próprio).
app.use(express.json({ limit: process.env.JSON_LIMITE || "1mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// /health é o que o Render consulta (healthCheckPath); /api/health continua
// existindo para quem já usava.
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// As placas ESP32 se autenticam com X-Device-Key (middleware/deviceAuth), nao
// com o JWT do usuario, entao esta rota NAO passa por requireAuth.
app.use("/api/device", deviceRoutes);

app.use("/api/contact", contactRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/stations", requireAuth, stationsRoutes);
app.use("/api/reports", requireAuth, reportsRoutes);
app.use("/api/suggestions", requireAuth, suggestionsRoutes);
app.use("/api/settings", requireAuth, settingsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "Imagem muito grande (máx. 1 MB)." });
  }
  const status = err instanceof multer.MulterError || err.status === 400 ? 400 : err.status || 500;
  res.status(status).json({ error: err.message || "Erro interno do servidor" });
});

const PORT = process.env.PORT || 3000;

// Rodando direto (node server.js / npm start, que é o que o Render faz) sobe
// um servidor HTTP de longa duração com o WebSocket em /ws na MESMA porta.
// Importado (backend/api/index.js, deploy antigo da Vercel) exporta só o app.
if (require.main === module) {
  const server = http.createServer(app);
  realtime.anexar(server);
  server.listen(PORT, () => {
    console.log(`GrowAI API rodando em http://localhost:${PORT} (WebSocket em ${realtime.CAMINHO})`);
  });

  // O Render manda SIGTERM antes de trocar a instância num deploy.
  const desligar = () => {
    realtime.fechar();
    server.close(() => {
      require("./config/db").pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", desligar);
  process.on("SIGINT", desligar);
}

module.exports = app;
