const router = require("express").Router();
const ctrl = require("../controllers/authController");
const { requireAuth } = require("../middleware/auth");
const { uploadAvatar } = require("../config/upload");

router.post("/register", ctrl.register);
router.post("/login", ctrl.login);
// Recuperação de senha (públicas): pedir o link por e-mail e trocar a senha
// com o token recebido.
router.post("/forgot-password", ctrl.forgotPassword);
router.post("/reset-password", ctrl.resetPassword);
router.get("/me", requireAuth, ctrl.me);
// requireAuth runs first so config/upload.js can name the file using req.user.id
router.put("/me", requireAuth, uploadAvatar.single("avatar"), ctrl.updateMe);

module.exports = router;
