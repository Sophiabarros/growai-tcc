const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/deviceController");
const { requireDevice } = require("../middleware/deviceAuth");

/* Rotas das placas ESP32. Montadas em /api/device SEM requireAuth: as placas
   não têm login, elas se autenticam com X-Device-Key (middleware/deviceAuth).

   A telemetria usa o express.json() global (Content-Type application/json).
   A foto é binária e precisa de tratamento próprio — só nesta rota. */

const LIMITE_FOTO = "2mb";

/* Lê o corpo binário que ainda não foi consumido. Existe por causa da Vercel:
   o runtime Node de lá às vezes já leu o corpo antes do Express, e nesse caso
   express.raw() entrega um objeto vazio em vez do Buffer.

   Na prática a Vercel só faz o parse de application/json, urlencoded e tipos
   de texto — image/jpeg deve chegar cru. Mas "deve" não é "chega", e este
   caminho é o que transforma uma suposição errada num erro legível em vez de
   uma foto corrompida no banco. Confirme no primeiro deploy (README). */
function corpoBruto(req, res, next) {
  // Caminho normal: express.raw() já montou o Buffer.
  if (Buffer.isBuffer(req.body) && req.body.length) {
    req.corpoBruto = req.body;
    return next();
  }

  // Alguém leu o corpo e decodificou como texto. Se foi latin1, os bytes
  // sobrevivem; se foi utf8, não tem volta — a checagem de FF D8 no controller
  // pega isso e responde 400 em vez de gravar imagem quebrada.
  if (typeof req.body === "string" && req.body.length) {
    console.warn("[foto] corpo chegou como string, tentando recuperar como latin1");
    req.corpoBruto = Buffer.from(req.body, "latin1");
    return next();
  }

  // O stream ainda está fechado? Então nada leu, e dá para ler agora.
  if (req.readable) {
    const partes = [];
    let total = 0;
    const max = 2 * 1024 * 1024;
    req.on("data", (c) => {
      total += c.length;
      if (total > max) {
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on("end", () => {
      req.corpoBruto = Buffer.concat(partes);
      next();
    });
    req.on("error", () => res.status(400).json({ error: "Falha ao ler o corpo da requisição" }));
    return;
  }

  console.error(
    "[foto] corpo indisponível: typeof req.body =",
    typeof req.body,
    "| readable =", req.readable,
    "| content-type =", req.headers["content-type"]
  );
  return res.status(400).json({ error: "Corpo da imagem não chegou ao servidor" });
}

router.post("/telemetria", requireDevice("main"), ctrl.telemetria);

router.post(
  "/foto",
  express.raw({ type: "image/jpeg", limit: LIMITE_FOTO }),
  corpoBruto,
  requireDevice("cam"),
  ctrl.foto
);

module.exports = router;
