// Traduz a estação (como o app a edita) para a config que o firmware entende,
// e centraliza o versionamento dessa config.
//
// O app só edita humidity_target e light_hours. A faixa de umidade e o horário
// de fim da luz são DERIVADOS aqui, para não existir campo novo na interface.
//
// Todo limite aqui é o mesmo que o firmware valida (firmware/PROTOCOLO.md).
// Isso não é redundância boba: se o backend mandar algo fora da faixa, a placa
// recusa a config INTEIRA e continua com a antiga, e o usuário vê a mudança
// "não pegar" sem explicação. Então o backend corta antes de mandar.

const db = require("../config/db");

const LIMITES = {
  umid_liga: [15, 80],
  umid_desliga: [0, 95], // o piso real é umid_liga + 5, aplicado depois
  vent_min_por_hora: [0, 60],
  temp_max: [15, 45],
  nutri_s: [0, 30],
  light_hours: [0, 24],
  humidity_target: [0, 100],
};

function corta(valor, [min, max]) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// "06:00:00" (TIME do Postgres) ou "06:00" -> minutos desde a meia-noite.
function horaParaMin(valor) {
  if (valor == null) return 0;
  const m = String(valor).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return 0;
  return ((h * 60 + min) % 1440 + 1440) % 1440;
}

/* Minutos -> "HH:MM", sempre dentro de 00:00..23:59.
   O módulo 1440 não é enfeite: luz_off = luz_inicio + light_hours estoura as
   24 h com facilidade (18:00 + 10 h daria "28:00"), e o firmware RECUSA a
   config inteira quando a hora é inválida. Reduzido, "04:00" é entendido como
   fotoperíodo que atravessa a meia-noite, que é exatamente o desejado. */
function minParaHora(minutos) {
  const m = ((Math.round(Number(minutos) || 0) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// A config exatamente como a placa espera (firmware/PROTOCOLO.md, seção 6).
function montarConfig(station) {
  const alvo = corta(station.humidity_target, LIMITES.humidity_target);

  const umid_liga = Math.round(corta(alvo - 10, LIMITES.umid_liga));
  // O firmware exige umid_desliga >= umid_liga + 5 e <= 95.
  const umid_desliga = Math.round(
    corta(Math.max(alvo + 5, umid_liga + 5), [umid_liga + 5, LIMITES.umid_desliga[1]])
  );

  const luzOnMin = horaParaMin(station.luz_inicio);
  const horasLuz = corta(station.light_hours, LIMITES.light_hours);

  return {
    umid_liga,
    umid_desliga,
    luz_on: minParaHora(luzOnMin),
    luz_off: minParaHora(luzOnMin + horasLuz * 60),
    vent_min_por_hora: Math.round(corta(station.vent_min_por_hora, LIMITES.vent_min_por_hora)),
    temp_max: Number(corta(station.temp_max, LIMITES.temp_max).toFixed(1)),
    nutri_hora: minParaHora(horaParaMin(station.nutri_hora)),
    nutri_s: Math.round(corta(station.nutri_s, LIMITES.nutri_s)),
  };
}

/* Sobe a versão da config da estação. A placa compara a versão que ela tem com
   esta; se diferir, a próxima telemetria já volta com a config nova.
   Aceita um client de transação para poder rodar junto com o UPDATE que causou
   a mudança (ver suggestionsController.apply). */
async function incrementarVersao(stationId, executor = db) {
  const { rows } = await executor.query(
    "UPDATE stations SET cfg_versao = cfg_versao + 1 WHERE id = $1 RETURNING cfg_versao",
    [stationId]
  );
  return rows[0] ? rows[0].cfg_versao : null;
}

/* Campos que, ao mudar, exigem versão nova (porque a placa se comporta
   diferente por causa deles). water_interval_h e ph_target ficam de fora: o
   firmware não usa nenhum dos dois. */
const CAMPOS_DE_CONFIG = [
  "humidity_target",
  "light_hours",
  "luz_inicio",
  "vent_min_por_hora",
  "temp_max",
  "nutri_hora",
  "nutri_s",
];

/* Valida e corta o que veio do app antes de gravar. Devolve
   { valores, erros }: valores só com as chaves presentes no corpo. */
function sanearEntrada(body) {
  const valores = {};
  const erros = [];

  const num = (campo, limites, inteiro) => {
    if (body[campo] === undefined || body[campo] === null) return;
    const n = Number(body[campo]);
    if (!Number.isFinite(n)) {
      erros.push(`${campo} precisa ser número`);
      return;
    }
    const cortado = corta(n, limites);
    if (cortado !== n) erros.push(`${campo} ajustado para ${cortado} (limite ${limites[0]}–${limites[1]})`);
    valores[campo] = inteiro ? Math.round(cortado) : cortado;
  };

  const hora = (campo) => {
    if (body[campo] === undefined || body[campo] === null) return;
    if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(body[campo]))) {
      erros.push(`${campo} precisa ser "HH:MM"`);
      return;
    }
    valores[campo] = minParaHora(horaParaMin(body[campo]));
  };

  num("humidity_target", LIMITES.humidity_target, false);
  num("light_hours", LIMITES.light_hours, false);
  num("vent_min_por_hora", LIMITES.vent_min_por_hora, true);
  num("temp_max", LIMITES.temp_max, false);
  num("nutri_s", LIMITES.nutri_s, true);
  hora("luz_inicio");
  hora("nutri_hora");

  return { valores, erros };
}

module.exports = {
  montarConfig,
  incrementarVersao,
  sanearEntrada,
  CAMPOS_DE_CONFIG,
  LIMITES,
  minParaHora,
  horaParaMin,
};
