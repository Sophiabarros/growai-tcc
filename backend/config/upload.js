const multer = require("multer");

// O upload de avatar em disco foi DESATIVADO ao migrar o backend para a
// Vercel: o filesystem é somente-leitura em ambiente serverless, então
// multer.diskStorage (e o fs.mkdirSync que rodava aqui na importação)
// quebrava a função inteira no cold start.
//
// O multer continua neste arquivo só para PARSEAR o multipart/form-data
// do formulário de perfil (o campo "name"). Um arquivo enviado no campo
// "avatar" fica em memória e é descartado pelo authController.
//
// Para reativar a foto de perfil: trocar por um storage externo
// (Vercel Blob, S3, Cloudinary) e voltar a gravar avatar_url no banco.
const ALLOWED_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(new Error("Formato de imagem não suportado (use PNG, JPG ou WEBP)"));
    }
    cb(null, true);
  },
});

module.exports = { uploadAvatar };
