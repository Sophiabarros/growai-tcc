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
// Linha do tempo: a lista leve primeiro, cada imagem sob demanda (latest e
// timeline vêm antes de :photoId, senão seriam lidas como um id).
router.get("/:id/photos/timeline", ctrl.getTimeline);
router.get("/:id/photos/:photoId(\\d+)", ctrl.getPhoto);

// Controle manual e placas da estacao (cada handler confere o dono)
router.post("/:id/commands", cmds.create);
router.get("/:id/commands", cmds.list);
router.get("/:id/devices", cmds.listDevices);
// Cadastra uma placa e devolve a chave dela UMA unica vez
router.post("/:id/devices", cmds.createDevice);
router.delete("/:id/devices/:deviceId", cmds.removeDevice);
// A placa esquece o Wi-Fi e volta para a rede GrowAI-setup (portal).
router.post("/:id/devices/:deviceId/trocar-wifi", cmds.trocarWifi);

// A IA avalia a rotina contra a especie e a finalidade (sem foto)
router.post("/:id/avaliar-rotina", ctrl.avaliarRotina);
router.post("/:id/analisar-foto", ctrl.analisarFotoAgora);

module.exports = router;
