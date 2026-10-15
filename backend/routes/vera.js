const router = require("express").Router();
const ctrl = require("../controllers/veraController");

// Montado em /api/vera com requireAuth (server.js).
router.get("/", ctrl.estado);
router.post("/", ctrl.perguntar);

module.exports = router;
