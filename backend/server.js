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

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
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
