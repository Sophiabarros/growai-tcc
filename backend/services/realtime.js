// WebSocket em /ws, no mesmo servidor HTTP (e na mesma porta) da API.
//
// Biblioteca "ws" e não Socket.IO: o ESP32 usa arduinoWebSockets, que fala
// WebSocket puro e não entende o protocolo próprio do Socket.IO.
//
// Quem conecta precisa se identificar ANTES do upgrade, senão qualquer um
// abriria uma conexão:
//   - placa:     header X-Device-Key (ou ?key=), a mesma chave do HTTP;
//   - navegador: ?token=<JWT> (a API WebSocket do navegador não manda header).
//
// A API HTTP continua sendo o caminho oficial de telemetria e foto; isto aqui
// é o canal para o servidor AVISAR quem está conectado (enviarParaEstacao /
// enviarParaUsuario), sem esperar o próximo polling.

const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { hashChave } = require("../middleware/deviceAuth");

const CAMINHO = "/ws";
const PING_MS = Number(process.env.WS_PING_MS) || 30000;

let wss = null;

async function identificar(req, url) {
  const chave = req.headers["x-device-key"] || url.searchParams.get("key");
  if (chave) {
    const { rows } = await db.query(
      "SELECT id, station_id, tipo FROM devices WHERE key_hash = $1",
      [hashChave(chave)]
    );
    if (!rows[0]) return null;
    return { tipo: "placa", deviceId: rows[0].id, stationId: rows[0].station_id, placa: rows[0].tipo };
  }

  const auth = req.headers.authorization;
  const token = url.searchParams.get("token") || (auth && auth.split(" ")[1]);
  if (token) {
    try {
      const user = jwt.verify(token, process.env.JWT_SECRET);
      return { tipo: "usuario", userId: user.id };
    } catch {
      return null;
    }
  }
  return null;
}

function recusar(socket, status, texto) {
  socket.write(`HTTP/1.1 ${status} ${texto}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function anexar(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return recusar(socket, 400, "Bad Request");
    }
    if (url.pathname !== CAMINHO) return recusar(socket, 404, "Not Found");

    try {
      const cliente = await identificar(req, url);
      if (!cliente) return recusar(socket, 401, "Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.cliente = cliente;
        wss.emit("connection", ws, req);
      });
    } catch (err) {
      console.error("[ws] falha ao autenticar conexão:", err);
      recusar(socket, 500, "Internal Server Error");
    }
  });

  wss.on("connection", (ws) => {
    ws.vivo = true;
    ws.on("pong", () => {
      ws.vivo = true;
    });
    ws.on("message", (dados) => {
      let msg;
      try {
        msg = JSON.parse(dados.toString());
      } catch {
        return;
      }
      // Ping de aplicação, para clientes que não respondem ao ping do protocolo.
      if (msg && msg.tipo === "ping") ws.send(JSON.stringify({ tipo: "pong" }));
    });
    ws.on("error", (err) => console.error("[ws] erro na conexão:", err.message));

    const c = ws.cliente;
    ws.send(JSON.stringify({ tipo: "ola", cliente: c.tipo, station_id: c.stationId || undefined }));
  });

  /* Ping/pong do protocolo: quem não respondeu ao ping anterior é derrubado.
     Sem isso, uma placa que perdeu o Wi-Fi no meio da conexão ficaria
     registrada para sempre (o TCP não avisa que o outro lado sumiu). */
  const intervalo = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.vivo) return ws.terminate();
      ws.vivo = false;
      ws.ping();
    });
  }, PING_MS);
  wss.on("close", () => clearInterval(intervalo));

  return wss;
}

function enviar(filtro, payload) {
  if (!wss) return 0;
  const texto = JSON.stringify(payload);
  let n = 0;
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && filtro(ws.cliente)) {
      ws.send(texto);
      n++;
    }
  });
  return n;
}

// Placas conectadas de uma estação.
function enviarParaEstacao(stationId, payload) {
  return enviar((c) => c.tipo === "placa" && Number(c.stationId) === Number(stationId), payload);
}

// Abas/apps abertos de um usuário.
function enviarParaUsuario(userId, payload) {
  return enviar((c) => c.tipo === "usuario" && Number(c.userId) === Number(userId), payload);
}

function fechar() {
  if (!wss) return;
  wss.clients.forEach((ws) => ws.close(1001, "servidor reiniciando"));
  wss.close();
}

module.exports = { anexar, enviarParaEstacao, enviarParaUsuario, fechar, CAMINHO };
