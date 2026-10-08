#!/usr/bin/env node
// Finge as duas placas ESP32 contra o backend, para testar o app inteiro sem
// hardware ligado.
//
//   DEVICE_KEY_MAIN=... DEVICE_KEY_CAM=... node scripts/simular-horta.js
//   npm run simular
//
// Variáveis:
//   API_BASE          padrão http://localhost:3000/api
//   DEVICE_KEY_MAIN   chave da placa 'main' (obrigatória)
//   DEVICE_KEY_CAM    chave da placa 'cam'  (opcional; sem ela, não manda foto)
//
// Opções:
//   --foto-a-cada N   manda uma foto a cada N minutos (padrão 5; 0 desliga)
//   --ciclos N        para depois de N telemetrias (padrão: roda até Ctrl+C)
//   --intervalo N     segundos entre telemetrias (padrão: o proxima_em_s da resposta)
//
// A umidade cai devagar e sobe quando a "bomba" liga, então dá para ver a
// histerese funcionando de verdade: a config que vem do backend é obedecida.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const API_BASE = (process.env.API_BASE || "http://localhost:3000/api").replace(/\/$/, "");
const CHAVE_MAIN = process.env.DEVICE_KEY_MAIN;
const CHAVE_CAM = process.env.DEVICE_KEY_CAM;
const DIR_AMOSTRAS = path.join(__dirname, "amostras");

function arg(nome, padrao) {
  const i = process.argv.indexOf(nome);
  if (i < 0 || i + 1 >= process.argv.length) return padrao;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : padrao;
}
const FOTO_A_CADA_MIN = arg("--foto-a-cada", 5);
const MAX_CICLOS = arg("--ciclos", Infinity);
const INTERVALO_FIXO = arg("--intervalo", 0);

/* Espelha os tempos de rega do firmware (firmware/esp32-main/src/main.cpp).
   REGA_MIN_MS é o tempo mínimo ligada, em que a umidade NÃO desliga a bomba:
   cobre encher os canos (o sensor molha antes da planta receber água) mais a
   dose em si. MAX_BOMBA_MS é o teto duro por acionamento. */
const REGA_ENCHE_MS = 20000;
const REGA_DOSE_MS = 15000;
const REGA_MIN_MS = REGA_ENCHE_MS + REGA_DOSE_MS;
const MAX_BOMBA_MS = REGA_ENCHE_MS + 2 * REGA_DOSE_MS;

// ------------------------------------------------- estado da "placa main"
const placa = {
  fw: "main-1.0.0-sim",
  cfg_versao: 0,
  cfg: { umid_liga: 40, umid_desliga: 60, luz_on: "06:00", luz_off: "18:00",
         vent_min_por_hora: 10, temp_max: 30, nutri_hora: "08:00", nutri_s: 8 },
  umidade: 55,
  temp: 24.5,
  estado: "MONITORANDO",
  reles: { bomba: 0, nutri: 0, luz: 1, vent: 0 },
  manual: {},              // rele -> segundos restantes
  nutri_s_hoje: 0,
  idsVistos: new Set(),
  acks: [],
  erro_cfg: null,
  t0: Date.now(),
};

function horaParaMin(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function dentroFotoperiodo() {
  const agora = new Date();
  const min = agora.getHours() * 60 + agora.getMinutes();
  const on = horaParaMin(placa.cfg.luz_on);
  const off = horaParaMin(placa.cfg.luz_off);
  if (on === off) return true;
  return on < off ? min >= on && min < off : min >= on || min < off;
}

// Um passo do controle local, simplificado mas com a mesma histerese e os
// mesmos limites duros do firmware.
function passoLocal(segundos) {
  // umidade: cai devagar; sobe rápido com a bomba ligada
  placa.umidade += placa.reles.bomba ? 1.6 * segundos / 15 : -0.45 * segundos / 15;
  placa.umidade = Math.max(5, Math.min(98, placa.umidade));
  placa.temp += (Math.random() - 0.5) * 0.3;
  placa.temp = Math.max(16, Math.min(38, placa.temp));

  // máquina de estados da irrigação
  if (placa.estado === "MONITORANDO" && placa.umidade < placa.cfg.umid_liga) {
    placa.estado = "REGANDO";
    placa.tEstado = Date.now();
  } else if (placa.estado === "REGANDO") {
    const ligadaMs = Date.now() - (placa.tEstado || Date.now());
    const deuOMinimo = ligadaMs >= REGA_MIN_MS;
    if ((deuOMinimo && placa.umidade >= placa.cfg.umid_desliga) || ligadaMs >= MAX_BOMBA_MS) {
      placa.estado = "ABSORVENDO";
      placa.tEstado = Date.now();
    }
  } else if (placa.estado === "ABSORVENDO" && Date.now() - (placa.tEstado || 0) >= 300000) {
    placa.estado = "MONITORANDO";
  }

  // relés no automático
  const quer = {
    bomba: placa.estado === "REGANDO" ? 1 : 0,
    nutri: 0,
    luz: dentroFotoperiodo() ? 1 : 0,
    vent: placa.temp > placa.cfg.temp_max || new Date().getMinutes() < placa.cfg.vent_min_por_hora ? 1 : 0,
  };

  // sobreposição manual + expiração
  for (const [rele, resta] of Object.entries(placa.manual)) {
    const novo = resta - segundos;
    if (novo <= 0) {
      delete placa.manual[rele];
      console.log(`    [manual] ${rele} expirou, volta ao automático`);
    } else {
      placa.manual[rele] = novo;
      quer[rele] = 1;
    }
  }

  // limites duros que nenhum comando fura
  if (quer.nutri && placa.nutri_s_hoje >= 30) {
    quer.nutri = 0;
    delete placa.manual.nutri;
  }
  if (quer.nutri) placa.nutri_s_hoje = Math.min(30, placa.nutri_s_hoje + segundos);

  placa.reles = quer;
}

function aplicarComandos(comandos) {
  for (const c of comandos || []) {
    if (placa.idsVistos.has(c.id)) {
      placa.acks.push(c.id); // reack: o servidor não registrou o anterior
      continue;
    }
    placa.idsVistos.add(c.id);
    placa.acks.push(c.id);

    if (c.acao === "desligar") {
      delete placa.manual[c.rele];
      console.log(`    [cmd ${c.id}] ${c.rele} volta ao automático`);
      continue;
    }
    let dur = Math.min(Number(c.dur_s) || 60, 3600);
    if (c.rele === "bomba") dur = Math.min(dur, MAX_BOMBA_MS / 1000);  // MAX_BOMBA
    if (c.rele === "nutri") dur = Math.min(dur, 30 - placa.nutri_s_hoje);
    if (dur <= 0) {
      console.log(`    [cmd ${c.id}] ${c.rele} sem margem no limite, ignorado`);
      continue;
    }
    placa.manual[c.rele] = dur;
    console.log(`    [cmd ${c.id}] ${c.rele} ligado por ${dur}s` + (dur !== c.dur_s ? ` (pedido ${c.dur_s}s, cortado)` : ""));
  }
}

function validarConfig(c) {
  if (!(c.umid_liga >= 15 && c.umid_liga <= 80)) return "umid_liga fora de 15..80";
  if (!(c.umid_desliga >= c.umid_liga + 5 && c.umid_desliga <= 95)) return "umid_desliga precisa ser >= umid_liga+5 e <= 95";
  for (const h of ["luz_on", "luz_off", "nutri_hora"]) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(c[h]))) return `${h} inválido: ${c[h]}`;
  }
  if (!(c.vent_min_por_hora >= 0 && c.vent_min_por_hora <= 60)) return "vent_min_por_hora fora de 0..60";
  if (!(c.temp_max >= 15 && c.temp_max <= 45)) return "temp_max fora de 15..45";
  if (!(c.nutri_s >= 0 && c.nutri_s <= 30)) return "nutri_s fora de 0..30";
  return null;
}

async function telemetria() {
  const corpo = {
    fw: placa.fw,
    cfg_versao: placa.cfg_versao,
    umidade: Math.round(placa.umidade),
    umidade_bruto: Math.round(3200 - (placa.umidade / 100) * (3200 - 1350)),
    temp_c: Number(placa.temp.toFixed(1)),
    estado: placa.estado,
    reles: placa.reles,
    manual: placa.manual,
    nutri_s_hoje: Math.round(placa.nutri_s_hoje),
    hora_valida: true,
    rssi: -55 - Math.round(Math.random() * 15),
    uptime_s: Math.round((Date.now() - placa.t0) / 1000),
    acks: placa.acks.slice(),
    erro: null,
    erro_cfg: placa.erro_cfg,
  };

  const res = await fetch(`${API_BASE}/device/telemetria`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-key": CHAVE_MAIN },
    body: JSON.stringify(corpo),
  });

  const texto = await res.text();
  if (!res.ok) {
    console.log(`  ! telemetria HTTP ${res.status}: ${texto.slice(0, 200)}`);
    if (res.status === 401) console.log("    (DEVICE_KEY_MAIN errada, ou é a chave da placa 'cam')");
    return 15;
  }

  let r = {};
  try { r = JSON.parse(texto); } catch { console.log("  ! resposta não é JSON"); return 15; }

  // acks entregues
  placa.acks = [];

  if (r.config) {
    const erro = validarConfig(r.config);
    if (erro) {
      placa.erro_cfg = erro;
      console.log(`    [cfg] RECUSADA: ${erro}`);
    } else {
      placa.cfg = r.config;
      placa.cfg_versao = r.cfg_versao;
      placa.erro_cfg = null;
      console.log(`    [cfg] aceita v${r.cfg_versao}: umid ${r.config.umid_liga}/${r.config.umid_desliga}` +
        `  luz ${r.config.luz_on}-${r.config.luz_off}  vent ${r.config.vent_min_por_hora}min/h` +
        `  temp_max ${r.config.temp_max}  nutri ${r.config.nutri_hora}x${r.config.nutri_s}s`);
    }
  } else if (r.cfg_versao !== undefined && !placa.erro_cfg) {
    placa.cfg_versao = r.cfg_versao;
  }

  aplicarComandos(r.comandos);
  return Math.max(1, Number(r.proxima_em_s) || 15);
}

function escolherAmostra() {
  if (!fs.existsSync(DIR_AMOSTRAS)) return null;
  const jpgs = fs.readdirSync(DIR_AMOSTRAS).filter((f) => /\.jpe?g$/i.test(f));
  if (!jpgs.length) return null;
  return path.join(DIR_AMOSTRAS, jpgs[Math.floor(Math.random() * jpgs.length)]);
}

async function foto() {
  if (!CHAVE_CAM) return;
  const arquivo = escolherAmostra();
  if (!arquivo) {
    console.log(`  (sem foto: ponha um .jpg em scripts/amostras/ — ver LEIA-ME.txt)`);
    return;
  }
  const jpeg = fs.readFileSync(arquivo);
  const t = Date.now();
  const res = await fetch(`${API_BASE}/device/foto`, {
    method: "POST",
    headers: {
      "content-type": "image/jpeg",
      "x-device-key": CHAVE_CAM,
      "x-captured-at": String(Math.floor(Date.now() / 1000)),
      "x-fw": "cam-1.0.0-sim",
    },
    body: jpeg,
  });
  const texto = await res.text();
  const seg = ((Date.now() - t) / 1000).toFixed(1);
  if (res.ok) {
    console.log(`  [foto] ${path.basename(arquivo)} ${(jpeg.length / 1024).toFixed(1)} kB enviada em ${seg}s -> ${texto.trim()}`);
    console.log(`         (o diagnóstico da IA aparece na tela Câmera do app)`);
  } else {
    console.log(`  ! foto HTTP ${res.status} em ${seg}s: ${texto.slice(0, 200)}`);
    if (res.status === 401) console.log("    (DEVICE_KEY_CAM errada, ou é a chave da placa 'main')");
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHAVE_MAIN) {
    console.error("DEVICE_KEY_MAIN não definida.");
    console.error("Gere as chaves com: npm run criar-dispositivo -- <station_id> main");
    console.error("Depois:  DEVICE_KEY_MAIN=... DEVICE_KEY_CAM=... npm run simular");
    process.exit(1);
  }

  console.log("");
  console.log(`Simulador GrowAI -> ${API_BASE}`);
  console.log(`  placa main: chave ...${CHAVE_MAIN.slice(-6)}`);
  console.log(`  placa cam:  ${CHAVE_CAM ? "chave ..." + CHAVE_CAM.slice(-6) : "não configurada (sem fotos)"}`);
  console.log(`  foto a cada: ${FOTO_A_CADA_MIN > 0 && CHAVE_CAM ? FOTO_A_CADA_MIN + " min" : "desligada"}`);
  console.log(`  ciclos: ${MAX_CICLOS === Infinity ? "até Ctrl+C" : MAX_CICLOS}`);
  console.log("");

  let ciclo = 0;
  let proximaFoto = FOTO_A_CADA_MIN > 0 ? Date.now() : Infinity; // a primeira sai já
  let intervalo = 15;

  while (ciclo < MAX_CICLOS) {
    ciclo++;
    passoLocal(intervalo);

    const hora = new Date().toLocaleTimeString("pt-BR");
    const manual = Object.keys(placa.manual).length
      ? "  manual " + Object.entries(placa.manual).map(([k, v]) => `${k}:${Math.round(v)}s`).join(",")
      : "";
    console.log(
      `[${hora}] #${ciclo}  umid ${Math.round(placa.umidade)}%  temp ${placa.temp.toFixed(1)}C  ` +
        `${placa.estado}  B${placa.reles.bomba} N${placa.reles.nutri} L${placa.reles.luz} V${placa.reles.vent}  ` +
        `cfg v${placa.cfg_versao}${manual}`
    );

    try {
      // A telemetria SEMPRE é enviada; --intervalo só sobrepõe o proxima_em_s
      // que veio na resposta. (Escrito como `INTERVALO_FIXO || await ...` o
      // curto-circuito pulava a requisição inteira quando --intervalo era
      // passado, e nada chegava ao backend.)
      const sugerido = await telemetria();
      intervalo = INTERVALO_FIXO || sugerido;
    } catch (err) {
      console.log(`  ! rede: ${err.message}`);
      console.log(`    (o backend está rodando em ${API_BASE}?)`);
      intervalo = 15;
    }

    if (Date.now() >= proximaFoto) {
      try {
        await foto();
      } catch (err) {
        console.log(`  ! foto: ${err.message}`);
      }
      proximaFoto = Date.now() + FOTO_A_CADA_MIN * 60000;
    }

    if (ciclo < MAX_CICLOS) await dormir(intervalo * 1000);
  }
  console.log(`\nFim: ${MAX_CICLOS} ciclo(s).`);
}

main().catch((err) => {
  console.error("Falhou:", err);
  process.exit(1);
});
