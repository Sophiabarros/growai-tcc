const multer = require("multer");

// Foto de perfil: o filesystem da Vercel é somente-leitura, então o arquivo
// fica em memória (multer.memoryStorage) e o authController grava a imagem
// no banco como data URL. O front já reduz a foto para ~256px antes de
// enviar; o limite de 1 MB só barra clientes que não passaram por ele.
const ALLOWED_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 }, // 1MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      const err = new Error("Formato de imagem não suportado (use PNG, JPG ou WEBP)");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

module.exports = { uploadAvatar };
