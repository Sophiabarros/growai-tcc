require("dotenv").config();
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
const { requireAuth } = require("./middleware/auth");

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
  })
);
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

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

// Em ambiente serverless (Vercel) este arquivo é apenas importado como
// handler HTTP - quem "escuta" a porta é a plataforma. Rodando direto
// (node server.js / nodemon) sobe o servidor normalmente.
if (require.main === module) {
  app.listen(PORT, () => console.log(`GrowAI API rodando em http://localhost:${PORT}`));
}

module.exports = app;
