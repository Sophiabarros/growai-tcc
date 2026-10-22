const router = require("express").Router();
const ctrl = require("../controllers/devController");

// Montado em /api/dev com requireAuth (server.js); a senha vem em X-Dev-Senha.
router.get("/ia-uso", ctrl.exigirSenha, ctrl.usoIa);
router.post("/ia-teste", ctrl.exigirSenha, ctrl.testarIa);

module.exports = router;
