const router = require("express").Router();
const ctrl = require("../controllers/veraController");

// V.E.R.A, montado em /api/vera com requireAuth (server.js).
router.get("/", ctrl.estado);
router.post("/", ctrl.perguntar);

module.exports = router;
