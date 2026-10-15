const router = require("express").Router();
const ctrl = require("../controllers/reportsController");

router.get("/weekly", ctrl.getWeekly);
router.get("/daily", ctrl.getDaily);

module.exports = router;
