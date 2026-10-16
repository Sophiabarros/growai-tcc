// Notificações do app (o sino). Tabela notificacoes, migração 007.
//
// criar() respeita as preferências de Configurações (notification_settings):
//   health_alerts    -> saude, praga, luz, ajuste, sensor, placa
//   watering_updates -> rega
//   weekly_reports   -> relatorio
// e não repete o mesmo aviso (mesmo tipo, mesma estação) dentro de
// semRepetirMin. Cada notificação nova também vai na hora pelo WebSocket,
// para o sino acender sem recarregar a página.

const db = require("../config/db");
const realtime = require("./realtime");

const PREFERENCIA = {
  saude: "health_alerts",
  praga: "health_alerts",
  luz: "health_alerts",
  ajuste: "health_alerts",
  sensor: "health_alerts",
  placa: "health_alerts",
  rega: "watering_updates",
  aparelho: "watering_updates",
  manual: "watering_updates",
  analise: "health_alerts",
  relatorio: "weekly_reports",
};
// Padrões das colunas de notification_settings (schema.sql).
const PADRAO = { health_alerts: true, watering_updates: true, weekly_reports: false };

async function preferencias(userId) {
  const { rows } = await db.query("SELECT * FROM notification_settings WHERE user_id = $1", [userId]);
  return rows[0] || PADRAO;
}

/* Cria a notificação se a preferência deixa e se não é repetida.
   Nunca lança: notificação é extra, não pode derrubar quem chamou. */
/* mesmoTitulo: o "não repetir" vale só para avisos com o MESMO título
   (ex.: luz e ventilação são do mesmo tipo, mas não se bloqueiam). */
async function criar({ userId, stationId = null, tipo, titulo, mensagem = null, semRepetirMin = 60, mesmoTitulo = false }) {
  try {
    if (!userId || !tipo || !titulo) return null;
    const pref = PREFERENCIA[tipo];
    if (pref) {
      const p = await preferencias(userId);
      if (p[pref] === false) return null;
    }
    if (semRepetirMin > 0) {
      const { rows } = await db.query(
        `SELECT 1 FROM notificacoes
          WHERE user_id = $1 AND tipo = $2 AND station_id IS NOT DISTINCT FROM $3
            AND criado_em > now() - ($4 || ' minutes')::interval
            AND ($5::text IS NULL OR titulo = $5)
          LIMIT 1`,
        [userId, tipo, stationId, String(semRepetirMin), mesmoTitulo ? String(titulo).slice(0, 140) : null]
      );
      if (rows.length) return null;
    }
    const { rows } = await db.query(
      `INSERT INTO notificacoes (user_id, station_id, tipo, titulo, mensagem)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, stationId, tipo, String(titulo).slice(0, 140), mensagem ? String(mensagem).slice(0, 400) : null]
    );
    realtime.enviarParaUsuario(userId, { tipo: "notificacao", notificacao: rows[0] });
    return rows[0];
  } catch (err) {
    console.error("[notificacoes] falha ao criar:", err.message);
    return null;
  }
}

/* Toda análise de foto concluída vira UM aviso, com o resumo (saúde,
   pragas, luz) e o título pelo que for mais importante. A pessoa fica
   sabendo de cada análise, não só das ruins. */
async function daAnalise(station, r) {
  if (!r || !r.ok || !station) return;
  const nome = station.name || station.plant || "estação";
  const planta = station.plant || nome;
  const resumo = [
    r.health_status === "atencao" ? "precisa de atenção" : "saudável",
    r.pragas === "sim" ? "praga detectada" : r.pragas === "nao" ? "sem pragas" : null,
    r.luz_nivel === "boa" ? "luz boa" : r.luz_nivel === "pouca" ? "pouca luz" : r.luz_nivel === "muita" ? "luz demais" : null,
  ].filter(Boolean).join(" · ");
  const mensagem = resumo + (r.analysis_text ? " — " + r.analysis_text : "");

  let tipo = "analise";
  let titulo = `Nova análise de ${nome}: ${r.health_status === "atencao" ? "atenção" : "saudável"}`;
  if (r.pragas === "sim") {
    tipo = "praga";
    titulo = `Praga detectada em ${nome}`;
  } else if (r.health_status === "atencao") {
    tipo = "saude";
    titulo = `${planta} precisa de atenção`;
  } else if (r.luz_nivel === "pouca" || r.luz_nivel === "muita") {
    tipo = "luz";
    titulo = r.luz_nivel === "pouca" ? `Pouca luz em ${nome}` : `Luz demais em ${nome}`;
  }
  // Cada análise é um aviso (o botão "Analisar agora" já limita 1 por minuto).
  await criar({ userId: station.user_id, stationId: station.id, tipo, semRepetirMin: 0, titulo, mensagem });
}

/* Aparelhos ligando (telemetria). Compara o estado anterior (memória) com o
   novo: relé que acendeu pela rotina vira um aviso com o motivo; relé que
   entrou no modo manual vira outro. Sem estado anterior (servidor acabou de
   reiniciar) não avisa nada, para não disparar uma rajada. */
const APARELHOS = {
  luz: { nome: "Luz de cultivo", ligou: "acesa", manual: "acesa manualmente", repetir: 60 },
  vent: { nome: "Ventilação + luz UV", ligou: "ligada", manual: "ligada manualmente", repetir: 30 },
  bomba: { nome: "Bomba d'água", ligou: "ligada (rega)", manual: "ligada manualmente", repetir: 20 },
  nutri: { nome: "Nutriente", ligou: "sendo dosado", manual: "dosado manualmente", repetir: 60 },
};

function duracao(seg) {
  const s = Math.max(0, Math.round(Number(seg) || 0));
  if (s < 90) return s + " s";
  const m = Math.round(s / 60);
  return m < 90 ? m + " min" : Math.round(m / 60) + " h";
}

function porqueLigou(rele, station, t) {
  if (rele === "luz") return "Horário de luz da rotina.";
  if (rele === "bomba") return `O solo chegou a ${t.umidade ?? "?"}% de umidade.`;
  if (rele === "nutri") return "Dose diária de nutriente da rotina.";
  if (rele === "vent") {
    const tmax = Number(station.temp_max);
    if (t.temp_c != null && Number.isFinite(tmax) && Number(t.temp_c) > tmax) {
      return `Temperatura de ${t.temp_c} °C, acima do limite de ${tmax} °C.`;
    }
    return "Ciclo de ventilação e luz UV da rotina.";
  }
  return null;
}

async function daTelemetria(station, anterior, t) {
  if (!station || !anterior || !t || !t.reles) return;
  const nome = station.name || station.plant || "estação";
  const relesAntes = anterior.reles || {};
  const manualAntes = anterior.manual || {};
  const manualAgora = t.manual || {};
  for (const [rele, info] of Object.entries(APARELHOS)) {
    const ligou = Number(relesAntes[rele]) === 0 && Number(t.reles[rele]) === 1;
    const entrouManual = manualAntes[rele] == null && manualAgora[rele] != null;
    if (entrouManual) {
      await criar({
        userId: station.user_id, stationId: station.id, tipo: "manual", semRepetirMin: 1, mesmoTitulo: true,
        titulo: `${info.nome} ${info.manual} em ${nome}`,
        mensagem: `Comando do app, por ${duracao(manualAgora[rele])}. Depois volta para a rotina.`,
      });
    } else if (ligou && manualAgora[rele] == null) {
      await criar({
        userId: station.user_id, stationId: station.id, tipo: rele === "bomba" ? "rega" : "aparelho",
        semRepetirMin: info.repetir, mesmoTitulo: true,
        titulo: `${info.nome} ${info.ligou} em ${nome}`,
        mensagem: porqueLigou(rele, station, t) + " Ligado automaticamente pela rotina.",
      });
    }
  }
}

/* Rodada do agendador (services/relatorios.js, a cada 10 min):
   - placa que parou de falar com o servidor;
   - relatório semanal pronto (segunda-feira, a partir das 8 h). */
async function rodada() {
  // Placa offline: falou nas últimas 2 h, mas não nos últimos 10 min. Um
  // aviso por queda (dedupe pelo último contato).
  const { rows: caidas } = await db.query(
    `SELECT d.id, d.tipo, d.last_seen, s.id AS station_id, s.name, s.user_id
       FROM devices d JOIN stations s ON s.id = d.station_id
      WHERE d.last_seen < now() - interval '10 minutes'
        AND d.last_seen > now() - interval '2 hours'`
  );
  for (const d of caidas) {
    const { rows: ja } = await db.query(
      `SELECT 1 FROM notificacoes WHERE user_id = $1 AND station_id = $2 AND tipo = 'placa'
          AND criado_em > $3 AND titulo LIKE $4 LIMIT 1`,
      [d.user_id, d.station_id, d.last_seen, d.tipo === "cam" ? "Câmera%" : "Placa%"]
    );
    if (ja.length) continue;
    await criar({
      userId: d.user_id, stationId: d.station_id, tipo: "placa", semRepetirMin: 0,
      titulo: (d.tipo === "cam" ? "Câmera" : "Placa principal") + ` de ${d.name} desconectada`,
      mensagem: "Sem contato com o servidor há mais de 10 minutos. Confira a energia e o Wi-Fi.",
    });
  }

  // Relatório semanal: segunda, a partir das 8 h (São Paulo), um por semana.
  const agora = new Date();
  const dia = agora.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const hora = Number(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }));
  if (dia === "Mon" && hora >= 8) {
    const { rows: usuarios } = await db.query("SELECT DISTINCT user_id FROM stations");
    for (const { user_id } of usuarios) {
      const { rows: resumo } = await db.query(
        `SELECT round(avg(r.saude_pct))::int AS saude, round(avg(r.umidade_media))::int AS umidade
           FROM relatorio_diario r JOIN stations s ON s.id = r.station_id
          WHERE s.user_id = $1 AND r.dia >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 7
            AND r.dia < (now() AT TIME ZONE 'America/Sao_Paulo')::date`,
        [user_id]
      );
      const r = resumo[0] || {};
      const partes = [];
      if (r.saude != null) partes.push(`saúde média ${r.saude}%`);
      if (r.umidade != null) partes.push(`umidade média ${r.umidade}%`);
      await criar({
        userId: user_id, tipo: "relatorio", semRepetirMin: 6 * 24 * 60,
        titulo: "Seu relatório semanal está pronto",
        mensagem: (partes.length ? "Semana passada: " + partes.join(", ") + ". " : "") + "Veja em Relatórios.",
      });
    }
  }
}

module.exports = { criar, daAnalise, daTelemetria, rodada };
