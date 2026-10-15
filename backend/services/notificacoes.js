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
async function criar({ userId, stationId = null, tipo, titulo, mensagem = null, semRepetirMin = 60 }) {
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
          LIMIT 1`,
        [userId, tipo, stationId, String(semRepetirMin)]
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

/* Avisos que saem da análise de uma foto (saúde, praga, luz). */
async function daAnalise(station, r) {
  if (!r || !r.ok || !station) return;
  const nome = station.name || station.plant || "estação";
  if (r.pragas === "sim") {
    await criar({
      userId: station.user_id, stationId: station.id, tipo: "praga", semRepetirMin: 180,
      titulo: `Praga detectada em ${nome}`,
      mensagem: r.pragas_descricao || r.analysis_text,
    });
  } else if (r.health_status === "atencao") {
    await criar({
      userId: station.user_id, stationId: station.id, tipo: "saude", semRepetirMin: 180,
      titulo: `${station.plant || nome} precisa de atenção`,
      mensagem: r.analysis_text,
    });
  }
  if (r.luz_nivel === "pouca" || r.luz_nivel === "muita") {
    await criar({
      userId: station.user_id, stationId: station.id, tipo: "luz", semRepetirMin: 360,
      titulo: r.luz_nivel === "pouca" ? `Pouca luz em ${nome}` : `Luz demais em ${nome}`,
      mensagem: r.luz_descricao,
    });
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

module.exports = { criar, daAnalise, rodada };
