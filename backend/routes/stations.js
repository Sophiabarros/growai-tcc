const router = require("express").Router();
const ctrl = require("../controllers/stationsController");
const cmds = require("../controllers/commandsController");

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.get("/:id", ctrl.getOne);
router.put("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);
router.get("/:id/readings/latest", ctrl.getLatestReading);
router.get("/:id/photos/latest", ctrl.getLatestPhoto);

// Controle manual e placas da estacao (cada handler confere o dono)
router.post("/:id/commands", cmds.create);
router.get("/:id/commands", cmds.list);
router.get("/:id/devices", cmds.listDevices);

// A IA avalia a rotina contra a especie e a finalidade (sem foto)
router.post("/:id/avaliar-rotina", ctrl.avaliarRotina);

module.exports = router;
