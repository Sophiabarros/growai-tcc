const router = require("express").Router();
const ctrl = require("../controllers/notificacoesController");

// Montado em /api/notificacoes com requireAuth (server.js).
router.get("/", ctrl.listar);
router.patch("/lidas", ctrl.marcarLidas);

module.exports = router;
