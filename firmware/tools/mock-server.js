#!/usr/bin/env node
/* GrowAI - servidor mock das rotas de dispositivo.
   Node puro, sem npm install. Serve para testar o firmware na rede local
   antes das rotas existirem no backend de verdade.

   Rodar:   node firmware/tools/mock-server.js
   Chaves:  DEVICE_KEY_MAIN=abc DEVICE_KEY_CAM=xyz node firmware/tools/mock-server.js
   Porta:   PORT=3002 node firmware/tools/mock-server.js

   Rotas de dispositivo (as do contrato, ver PROTOCOLO.md):
     POST /api/device/telemetria
     POST /api/device/foto
   Rotas de controle, para abrir no navegador:
     GET /mock/estado
     GET /mock/cmd?rele=vent&acao=ligar&dur_s=60
     GET /mock/config?umid_liga=50&umid_desliga=70
*/

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 3001);

/* Uma chave por placa, como em producao: no backend a telemetria aceita so a
   placa 'main' e a foto so a 'cam'. Se o mock aceitasse uma chave unica, trocar
   as chaves no secrets.h passaria batido aqui e dava 401 so na Vercel.
   DEVICE_KEY sozinha ainda funciona para as duas, para teste rapido. */
const CHAVE_MAIN = process.env.DEVICE_KEY_MAIN || process.env.DEVICE_KEY || "teste123-main";
const CHAVE_CAM = process.env.DEVICE_KEY_CAM || process.env.DEVICE_KEY || "teste123-cam";

const DIR_FOTOS = path.join(__dirname, "fotos");

// 2 MB: o mesmo limite do express.raw() da rota de foto no backend. Uma foto
// SVGA com qualidade 12 da 40-90 kB, entao cabe de sobra.
const MAX_CORPO = 2 * 1024 * 1024;

// ------------------------------------------------------------- estado
const estado = {
  cfg_versao: 1,
  config: {
    umid_liga: 40,
    umid_desliga: 60,
    luz_on: "06:00",
    luz_off: "18:00",
    vent_min_por_hora: 10,
    temp_max: 30,
    nutri_hora: "08:00",
    nutri_s: 8,
  },
  proxima_em_s: 15,
  ultimaTelemetria: null,
  ultimaTelemetriaEm: null,
  fila: [], // { id, rele, acao, dur_s, status: pendente|enviado|confirmado }
  proximoId: 1,
  fotos: [],
};

// Campos numericos da config e o intervalo aceito pelo firmware. O mock valida
// igual para eu descobrir o erro aqui, no navegador, e nao no Serial da placa.
const LIMITES = {
  umid_liga: [15, 80],
  umid_desliga: [0, 95],
  vent_min_por_hora: [0, 60],
  temp_max: [15, 45],
  nutri_s: [0, 30],
};
const HORAS = ["luz_on", "luz_off", "nutri_hora"];

function horaValida(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// ------------------------------------------------------------- helpers
function json(res, code, obj) {
  const corpo = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(corpo),
  });
  res.end(corpo);
}

function leCorpo(req, limite, cb) {
  const partes = [];
  let total = 0;
  let cortado = false;
  req.on("data", (c) => {
    total += c.length;
    if (total > limite) {
      cortado = true;
      req.destroy();
      return;
    }
    partes.push(c);
  });
  req.on("end", () => cb(null, Buffer.concat(partes)));
  req.on("error", (e) => cb(cortado ? new Error("corpo maior que o limite") : e, null));
}

// tipo: "main" (telemetria) ou "cam" (foto). Chave da placa errada = 401.
function autorizado(req, tipo) {
  const k = req.headers["x-device-key"];
  return k === (tipo === "cam" ? CHAVE_CAM : CHAVE_MAIN);
}

function hhmm(d) {
  return d.toTimeString().slice(0, 8);
}

// Aceita /api/device/... e /device/..., para eu nao errar a API_BASE na placa.
function rota(pathname) {
  return pathname.replace(/^\/api(?=\/)/, "");
}

// ------------------------------------------------------- /device/telemetria
function telemetria(req, res, corpo) {
  let t;
  try {
    t = JSON.parse(corpo.toString("utf8"));
  } catch (e) {
    console.log("  !! JSON invalido:", e.message);
    return json(res, 400, { erro: "json invalido" });
  }

  estado.ultimaTelemetria = t;
  estado.ultimaTelemetriaEm = new Date().toISOString();

  const r = t.reles || {};
  const reles = ["bomba", "nutri", "luz", "vent"].map((k) => `${k[0].toUpperCase()}${r[k] ? 1 : 0}`).join(" ");
  const manual = Object.keys(t.manual || {}).length
    ? "  manual " + Object.entries(t.manual).map(([k, v]) => `${k}:${v}s`).join(",")
    : "";

  console.log(
    `[${hhmm(new Date())}] ${t.fw}  cfg v${t.cfg_versao}  ` +
      `umid ${t.umidade === null ? "NULL" : t.umidade + "%"} (${t.umidade_bruto})  ` +
      `temp ${t.temp_c === null ? "NULL" : t.temp_c + "C"}  ` +
      `${t.estado}  ${reles}  nutri ${t.nutri_s_hoje}s  ` +
      `rssi ${t.rssi}  up ${t.uptime_s}s  hora ${t.hora_valida ? "ok" : "--"}${manual}`
  );
  if (t.erro) console.log("           ERRO:", t.erro);
  if (t.erro_cfg) console.log("           ERRO CFG:", t.erro_cfg);

  // acks: fecha os comandos que a placa confirmou
  for (const id of t.acks || []) {
    const c = estado.fila.find((x) => x.id === id);
    if (c && c.status !== "confirmado") {
      c.status = "confirmado";
      c.confirmadoEm = new Date().toISOString();
      console.log(`           ack: comando ${id} (${c.rele} ${c.acao}) confirmado`);
    }
  }

  const resp = { cfg_versao: estado.cfg_versao, proxima_em_s: estado.proxima_em_s };

  // config so vai quando a versao da placa difere da nossa
  if (t.cfg_versao !== estado.cfg_versao) {
    resp.config = estado.config;
    console.log(`           -> mandando config v${estado.cfg_versao}`);
  }

  // reenvia todo comando ainda nao confirmado: a placa ignora id repetido
  const pendentes = estado.fila.filter((c) => c.status !== "confirmado");
  if (pendentes.length) {
    resp.comandos = pendentes.map(({ id, rele, acao, dur_s }) => ({ id, rele, acao, dur_s }));
    pendentes.forEach((c) => {
      if (c.status === "pendente") c.status = "enviado";
    });
    console.log(`           -> mandando ${pendentes.length} comando(s)`);
  }

  json(res, 200, resp);
}

// ------------------------------------------------------------- /device/foto
function foto(req, res, corpo) {
  const capturadaEm = Number(req.headers["x-captured-at"] || 0);
  const fw = req.headers["x-fw"] || "?";

  if (!corpo.length) return json(res, 400, { erro: "corpo vazio" });
  // JPEG comeca com FF D8 e termina com FF D9
  const ehJpeg = corpo[0] === 0xff && corpo[1] === 0xd8;

  fs.mkdirSync(DIR_FOTOS, { recursive: true });
  const nome = `${capturadaEm || Math.floor(Date.now() / 1000)}.jpg`;
  const destino = path.join(DIR_FOTOS, nome);
  fs.writeFileSync(destino, corpo);

  const quando = capturadaEm ? new Date(capturadaEm * 1000).toISOString() : "sem timestamp";
  console.log(
    `[${hhmm(new Date())}] foto ${fw}  ${(corpo.length / 1024).toFixed(1)} kB  ` +
      `${quando}  -> tools/fotos/${nome}${ehJpeg ? "" : "  !! nao parece JPEG"}`
  );

  estado.fotos.unshift({ nome, bytes: corpo.length, capturadaEm, fw });
  estado.fotos = estado.fotos.slice(0, 20);

  json(res, 200, { ok: true });
}

// ------------------------------------------------------------- /mock/*
function mockCmd(res, q) {
  const rele = q.get("rele");
  const acao = q.get("acao") || "ligar";
  const dur_s = Number(q.get("dur_s") || 60);

  if (!["bomba", "nutri", "luz", "vent"].includes(rele))
    return json(res, 400, { erro: "rele precisa ser bomba, nutri, luz ou vent" });
  if (!["ligar", "desligar"].includes(acao))
    return json(res, 400, { erro: "acao precisa ser ligar ou desligar" });

  const cmd = { id: estado.proximoId++, rele, acao, dur_s, status: "pendente", criadoEm: new Date().toISOString() };
  estado.fila.push(cmd);
  console.log(`[${hhmm(new Date())}] comando ${cmd.id} na fila: ${rele} ${acao} ${dur_s}s`);
  json(res, 200, { ok: true, comando: cmd });
}

function mockConfig(res, q) {
  const nova = { ...estado.config };
  const erros = [];
  let mudou = 0;

  for (const [k, v] of q) {
    if (k in LIMITES) {
      const n = Number(v);
      const [min, max] = LIMITES[k];
      if (!Number.isFinite(n)) erros.push(`${k}: nao e numero`);
      else if (n < min || n > max) erros.push(`${k}: fora de ${min}..${max}`);
      else {
        nova[k] = n;
        mudou++;
      }
    } else if (HORAS.includes(k)) {
      if (!horaValida(v)) erros.push(`${k}: precisa ser HH:MM`);
      else {
        nova[k] = v;
        mudou++;
      }
    } else {
      erros.push(`${k}: campo desconhecido`);
    }
  }

  // a mesma regra do firmware: o desliga tem que ficar 5 pontos acima do liga
  if (nova.umid_desliga < nova.umid_liga + 5)
    erros.push(`umid_desliga (${nova.umid_desliga}) precisa ser >= umid_liga+5 (${nova.umid_liga + 5})`);

  if (erros.length) return json(res, 400, { erro: "config recusada pelo mock", detalhes: erros });
  if (!mudou) return json(res, 400, { erro: "nada para mudar; ex: /mock/config?umid_liga=50" });

  estado.config = nova;
  estado.cfg_versao++;
  console.log(`[${hhmm(new Date())}] config v${estado.cfg_versao}:`, JSON.stringify(nova));
  json(res, 200, { ok: true, cfg_versao: estado.cfg_versao, config: nova });
}

function mockEstado(res) {
  json(res, 200, {
    cfg_versao: estado.cfg_versao,
    config: estado.config,
    proxima_em_s: estado.proxima_em_s,
    ultimaTelemetriaEm: estado.ultimaTelemetriaEm,
    ultimaTelemetria: estado.ultimaTelemetria,
    fila: estado.fila,
    fotos: estado.fotos,
  });
}

// ------------------------------------------------------------- servidor
const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = rota(url.pathname);

  if (req.method === "GET") {
    if (p === "/mock/estado") return mockEstado(res);
    if (p === "/mock/cmd") return mockCmd(res, url.searchParams);
    if (p === "/mock/config") return mockConfig(res, url.searchParams);
    if (p === "/health" || p === "/") return json(res, 200, { ok: true, mock: "growai" });
  }

  if (req.method === "POST" && (p === "/device/telemetria" || p === "/device/foto")) {
    const tipo = p === "/device/foto" ? "cam" : "main";
    if (!autorizado(req, tipo)) {
      console.log(
        `[${hhmm(new Date())}] 401 em ${p} (esperava a chave da placa '${tipo}'; ` +
          `veio ${req.headers["x-device-key"] ? "outra chave" : "nenhuma"})`
      );
      return json(res, 401, { erro: "chave invalida", esperado: tipo });
    }
    return leCorpo(req, MAX_CORPO, (err, corpo) => {
      if (err) {
        console.log("  !! corpo:", err.message);
        return json(res, 413, { erro: err.message });
      }
      if (p === "/device/telemetria") telemetria(req, res, corpo);
      else foto(req, res, corpo);
    });
  }

  json(res, 404, { erro: "rota nao encontrada", path: url.pathname });
});

servidor.listen(PORT, "0.0.0.0", () => {
  const ips = [];
  for (const lista of Object.values(os.networkInterfaces()))
    for (const i of lista || []) if (i.family === "IPv4" && !i.internal) ips.push(i.address);

  console.log("GrowAI mock na porta " + PORT);
  console.log("Chave da placa main (telemetria): " + CHAVE_MAIN);
  console.log("Chave da placa cam  (foto):       " + CHAVE_CAM);
  console.log("");
  console.log("Use um destes em API_BASE (secrets.h das DUAS placas):");
  if (ips.length) ips.forEach((ip) => console.log(`  http://${ip}:${PORT}/api`));
  else console.log("  (nenhum IPv4 externo encontrado; esta maquina esta na rede?)");
  console.log("");
  console.log("Painel:  http://localhost:" + PORT + "/mock/estado");
  console.log("Fotos:   " + DIR_FOTOS);
  console.log("");
});
