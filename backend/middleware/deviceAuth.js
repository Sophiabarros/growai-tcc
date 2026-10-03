// Autenticação das placas ESP32. Não usa o JWT do usuário: a placa não faz
// login, ela tem uma chave fixa gravada no secrets.h.
//
// A chave em texto puro não existe no banco, só o sha256 em hex — mesmo
// esquema de password_resets. Isso é o que permite a chave circular no código
// da placa sem virar credencial de conta: ela só abre as duas rotas de
// /api/device e só para a estação dela.
//
// IMPORTANTE: a estação é descoberta A PARTIR da chave. Nunca aceite um
// station_id vindo do corpo da requisição, senão uma placa conseguiria
// escrever na estação de outro usuário.

const crypto = require("crypto");
const db = require("../config/db");

function hashChave(chave) {
  return crypto.createHash("sha256").update(String(chave), "utf8").digest("hex");
}

// tipo: 'main' (telemetria) ou 'cam' (foto). A rota errada para o tipo da
// placa responde 401, igual a uma chave inexistente — não vale dizer a quem
// tem a chave errada que ela existe, só que é de outro tipo.
function requireDevice(tipo) {
  return async function (req, res, next) {
    try {
      const chave = req.headers["x-device-key"];
      if (!chave) return res.status(401).json({ error: "Chave de dispositivo ausente" });

      /* Os campos de devices vão com prefixo dev_ de propósito. Sem isso, o
         `s.*` traz stations.id e stations.created_at com os MESMOS nomes de
         devices.id e devices.created_at, e o pg mantém só a última coluna de
         cada nome: req.device.id viraria o id da estação, e o UPDATE abaixo
         atualizaria a placa errada. */
      const { rows } = await db.query(
        `SELECT d.id   AS dev_id,
                d.tipo AS dev_tipo,
                d.nome AS dev_nome,
                d.fw   AS dev_fw,
                s.*
           FROM devices d
           JOIN stations s ON s.id = d.station_id
          WHERE d.key_hash = $1`,
        [hashChave(chave)]
      );

      const linha = rows[0];
      if (!linha || linha.dev_tipo !== tipo) {
        return res.status(401).json({ error: "Chave de dispositivo inválida" });
      }

      req.device = { id: linha.dev_id, station_id: linha.id, tipo: linha.dev_tipo, nome: linha.dev_nome };
      req.station = linha; // as colunas de stations vêm intactas no mesmo SELECT

      /* last_seen e fw são atualizados aqui, antes do handler, para valerem
         também quando o corpo for inválido: a placa falou com o servidor, e é
         isso que o campo "online" do app precisa saber. O fw vem do payload
         (telemetria) ou do header X-Fw (foto). */
      const fw = (req.body && req.body.fw) || req.headers["x-fw"] || null;
      await db.query(
        `UPDATE devices SET last_seen = now(), fw = COALESCE($2, fw) WHERE id = $1`,
        [req.device.id, fw]
      );

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireDevice, hashChave };
