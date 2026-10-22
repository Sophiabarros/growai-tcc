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
  // 256 kB: cabe um quadro JPEG da câmera ao vivo (VGA dá 15-40 kB).
  /* 1 MB: o quadro do ao vivo é ~15-40 kB em VGA, mas um sensor que não
     aceita a resolução manda o quadro cheio. Com 256 kB a conexão caía no
     primeiro quadro e o ao vivo nunca começava; a CAM (cam-2.2.1) já pula
     quadros acima de 200 kB. */
  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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
    ws.on("message", (dados, binario) => {
      // Quadro da câmera ao vivo: JPEG cru, repassado a quem está assistindo.
      if (binario) {
        if (ws.cliente.tipo === "placa" && ws.cliente.placa === "cam") repassarQuadro(ws.cliente.stationId, dados);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(dados.toString());
      } catch {
        return;
      }
      // Ping de aplicação, para clientes que não respondem ao ping do protocolo.
      if (msg && msg.tipo === "ping") ws.send(JSON.stringify({ tipo: "pong" }));
      if (msg && msg.tipo === "ao_vivo" && ws.cliente.tipo === "usuario") {
        pedidoAoVivo(ws, msg).catch((err) => console.error("[ws] ao vivo:", err.message));
      }
    });
    ws.on("error", (err) => console.error("[ws] erro na conexão:", err.message));
    ws.on("close", (codigo, motivo) => {
      // Câmera caindo é o que mata o ao vivo: o log diz por quê (1009 = quadro grande demais).
      if (ws.cliente && ws.cliente.placa === "cam") {
        console.warn(`[ws] câmera da estação ${ws.cliente.stationId} saiu: código ${codigo} ${String(motivo || "")}`);
      }
      aoFechar(ws);
    });

    const c = ws.cliente;
    ws.send(JSON.stringify({ tipo: "ola", cliente: c.tipo, station_id: c.stationId || undefined }));
    if (c.tipo === "placa") placaConectou(ws);
  });

  // Faxina do ao vivo: tira quem parou de renovar e mantém a câmera avisada.
  const intervaloAoVivo = setInterval(manterAoVivo, AO_VIVO_RENOVA_MS);
  wss.on("close", () => clearInterval(intervaloAoVivo));

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

// Só as câmeras de uma estação (o pedido de trocar o Wi-Fi vai só para ela).
function enviarParaCamera(stationId, payload) {
  return enviar((c) => c.tipo === "placa" && c.placa === "cam" && Number(c.stationId) === Number(stationId), payload);
}

// Abas/apps abertos de um usuário.
function enviarParaUsuario(userId, payload) {
  return enviar((c) => c.tipo === "usuario" && Number(c.userId) === Number(userId), payload);
}

/* ------------------------------------------------------------ ao vivo
   A câmera fica conectada aqui (WebSocket com a chave dela) e só manda
   imagem quando alguém está assistindo:

     app  -> {tipo:"ao_vivo", station_id, ligar:true}   a cada ~15 s
     aqui -> câmera {tipo:"ao_vivo", ligar:true}         a cada 10 s
     câmera -> quadros JPEG binários (~2 por segundo)
     aqui -> repassa os quadros a quem pediu aquela estação

   Ninguém renovou em AO_VIVO_PRAZO_MS? Sai da lista. Lista vazia? A câmera
   recebe ligar:false. Ela também para sozinha se não ouvir nada em ~25 s,
   para o caso de este servidor reiniciar no meio. */
const AO_VIVO_PRAZO_MS = 30000;
const AO_VIVO_RENOVA_MS = 10000;

function camerasDa(stationId) {
  const lista = [];
  if (!wss) return lista;
  wss.clients.forEach((ws) => {
    const c = ws.cliente;
    if (ws.readyState === ws.OPEN && c.tipo === "placa" && c.placa === "cam" && Number(c.stationId) === Number(stationId)) {
      lista.push(ws);
    }
  });
  return lista;
}

function espectadoresDa(stationId) {
  const lista = [];
  if (!wss) return lista;
  const agora = Date.now();
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws.cliente.tipo === "usuario" &&
        Number(ws.aoVivo) === Number(stationId) && ws.aoVivoAte > agora) {
      lista.push(ws);
    }
  });
  return lista;
}

function avisarCamera(stationId, ligar) {
  const texto = JSON.stringify({ tipo: "ao_vivo", ligar });
  camerasDa(stationId).forEach((ws) => ws.send(texto));
}

function avisarEspectadores(stationId, payload) {
  const texto = JSON.stringify(payload);
  espectadoresDa(stationId).forEach((ws) => ws.send(texto));
}

function repassarQuadro(stationId, quadro) {
  espectadoresDa(stationId).forEach((ws) => {
    // Conexão lenta acumulando? Pula este quadro em vez de empilhar atraso.
    if (ws.bufferedAmount < 512 * 1024) ws.send(quadro, { binary: true });
  });
}

async function pedidoAoVivo(ws, msg) {
  const stationId = Number(msg.station_id);
  if (!msg.ligar) {
    const antes = ws.aoVivo;
    ws.aoVivo = null;
    if (antes && !espectadoresDa(antes).length) avisarCamera(antes, false);
    return;
  }
  // Só o dono da estação assiste a câmera dela.
  if (ws.aoVivo !== stationId) {
    const { rows } = await db.query("SELECT 1 FROM stations WHERE id = $1 AND user_id = $2", [stationId, ws.cliente.userId]);
    if (!rows[0]) return;
  }
  ws.aoVivo = stationId;
  ws.aoVivoAte = Date.now() + AO_VIVO_PRAZO_MS;
  const cams = camerasDa(stationId);
  ws.send(JSON.stringify({ tipo: "ao_vivo_status", station_id: stationId, cam_online: cams.length > 0 }));
  avisarCamera(stationId, true);
}

function manterAoVivo() {
  if (!wss) return;
  const comEspectador = new Set();
  wss.clients.forEach((ws) => {
    if (ws.cliente.tipo !== "usuario" || !ws.aoVivo) return;
    if (ws.aoVivoAte > Date.now()) comEspectador.add(Number(ws.aoVivo));
    else ws.aoVivo = null;
  });
  wss.clients.forEach((ws) => {
    const c = ws.cliente;
    if (c.tipo !== "placa" || c.placa !== "cam" || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ tipo: "ao_vivo", ligar: comEspectador.has(Number(c.stationId)) }));
  });
}

async function marcarVista(deviceId) {
  try {
    await db.query("UPDATE devices SET last_seen = now() WHERE id = $1", [deviceId]);
  } catch (err) {
    console.error("[ws] last_seen:", err.message);
  }
}

function placaConectou(ws) {
  const c = ws.cliente;
  /* Conectada por WebSocket = online, mesmo sem mandar foto: a câmera agora
     fica acordada esperando pedido de ao vivo. */
  marcarVista(c.deviceId);
  ws.vistaTimer = setInterval(() => marcarVista(c.deviceId), 60000);
  if (c.placa === "cam") {
    avisarEspectadores(c.stationId, { tipo: "ao_vivo_status", station_id: c.stationId, cam_online: true });
    if (espectadoresDa(c.stationId).length) avisarCamera(c.stationId, true);
  }
}

function aoFechar(ws) {
  const c = ws.cliente;
  if (ws.vistaTimer) clearInterval(ws.vistaTimer);
  if (c.tipo === "placa" && c.placa === "cam") {
    avisarEspectadores(c.stationId, { tipo: "ao_vivo_status", station_id: c.stationId, cam_online: false });
  }
  if (c.tipo === "usuario" && ws.aoVivo) {
    const st = ws.aoVivo;
    ws.aoVivo = null;
    if (!espectadoresDa(st).length) avisarCamera(st, false);
  }
}

// Há alguma aba/app deste usuário aberta agora?
function usuarioConectado(userId) {
  if (!wss) return false;
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.cliente.tipo === "usuario" && Number(ws.cliente.userId) === Number(userId)) {
      return true;
    }
  }
  return false;
}

function fechar() {
  if (!wss) return;
  wss.clients.forEach((ws) => ws.close(1001, "servidor reiniciando"));
  wss.close();
}

module.exports = { anexar, enviarParaEstacao, enviarParaCamera, enviarParaUsuario, usuarioConectado, fechar, CAMINHO };
