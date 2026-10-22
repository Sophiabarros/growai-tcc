const router = require("express").Router();
const ctrl = require("../controllers/reportsController");

router.get("/weekly", ctrl.getWeekly);
router.get("/daily", ctrl.getDaily);
router.get("/agua", ctrl.getAgua);
router.get("/diario-ia", ctrl.getDiarioIa);

module.exports = router;
