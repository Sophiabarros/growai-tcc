// V.E.R.A: o chat da IA do app, com 3 perguntas por dia por usuário.
//
// Ela responde sobre a horta DA PESSOA: o prompt leva as estações (planta,
// finalidade, rotina), a última análise de foto de cada uma (saúde, texto,
// pragas) e a última leitura. Assim "a IA disse deficiência de ferro, o que
// eu faço?" tem resposta ligada ao que o app já mostrou.
//
// O limite conta só perguntas respondidas (ok = true): se a IA falhou, a
// pessoa não perde a pergunta. O dia é o de São Paulo.

const db = require("../config/db");
const { perguntarTexto } = require("../services/ia");
const { temperaturaSaoPaulo } = require("../services/temperaturaExterna");

const LIMITE_DIARIO = Number(process.env.VERA_LIMITE_DIARIO) || 3;
const MAX_PERGUNTA = 500;
const TZ = "America/Sao_Paulo";

async function doDia(userId) {
  const { rows } = await db.query(
    `SELECT id, pergunta, resposta, ok, criado_em
       FROM vera_perguntas
      WHERE user_id = $1
        AND (criado_em AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
      ORDER BY criado_em`,
    [userId, TZ]
  );
  return rows;
}

function situacao(rows) {
  const usadas = rows.filter((r) => r.ok).length;
  return {
    limite: LIMITE_DIARIO,
    usadas,
    restantes: Math.max(0, LIMITE_DIARIO - usadas),
    conversa: rows.filter((r) => r.ok).map((r) => ({ pergunta: r.pergunta, resposta: r.resposta, criado_em: r.criado_em })),
  };
}

// GET /api/vera — perguntas restantes hoje e a conversa do dia.
async function estado(req, res, next) {
  try {
    res.json(situacao(await doDia(req.user.id)));
  } catch (err) {
    next(err);
  }
}

async function contextoDaHorta(userId) {
  const { rows: estacoes } = await db.query(
    "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at, id",
    [userId]
  );
  const externa = await temperaturaSaoPaulo();
  const blocos = await Promise.all(
    estacoes.slice(0, 5).map(async (s) => {
      const [{ rows: fotos }, { rows: leituras }] = await Promise.all([
        db.query(
          `SELECT health_status, analysis_text, pragas, pragas_descricao, captured_at
             FROM station_photos
            WHERE station_id = $1 AND health_status <> 'indefinido'
            ORDER BY captured_at DESC LIMIT 1`,
          [s.id]
        ),
        db.query("SELECT humidity, temperature, recorded_at FROM sensor_readings WHERE station_id = $1 ORDER BY recorded_at DESC LIMIT 1", [s.id]),
      ]);
      const f = fotos[0];
      const l = leituras[0];
      const linhas = [
        `### Estação "${s.name}": ${s.plant}${s.tag ? ` (finalidade: ${s.tag})` : ""}`,
        `- Rotina: luz ${s.light_hours} h/dia, umidade alvo ${s.humidity_target}%, rega a cada ${s.water_interval_h} h, ventila acima de ${s.temp_max} °C, nutriente ${s.nutri_s} s/dia, luz UV ${s.uv_min_dia ?? 30} min/dia`,
      ];
      if (f) {
        linhas.push(
          `- Última análise da foto (${new Date(f.captured_at).toLocaleString("pt-BR", { timeZone: TZ })}): ` +
            `${f.health_status === "atencao" ? "ATENÇÃO" : "saudável"} — "${f.analysis_text}"` +
            (f.pragas === "sim" ? ` · PRAGA: ${f.pragas_descricao || "detectada"}` : f.pragas === "nao" ? " · sem pragas" : "")
        );
      } else {
        linhas.push("- Ainda não há foto analisada.");
      }
      if (l) {
        const temp = l.temperature != null
          ? `${Number(l.temperature).toFixed(1)} °C`
          : externa ? `sensor sem leitura (São Paulo agora: ${externa.temperatura} °C)` : "sem leitura";
        linhas.push(`- Última leitura: umidade do solo ${l.humidity != null ? Math.round(l.humidity) + "%" : "sem leitura"}, temperatura ${temp}`);
      }
      return linhas.join("\n");
    })
  );
  return blocos.length ? blocos.join("\n\n") : "A pessoa ainda não cadastrou nenhuma estação.";
}

function montarPrompt({ pergunta, horta, conversa }) {
  const anteriores = conversa.length
    ? "## O que já foi conversado hoje\n" +
      conversa.map((c) => `Pessoa: ${c.pergunta}\nV.E.R.A: ${c.resposta}`).join("\n\n") + "\n\n"
    : "";
  return `Você é a V.E.R.A (escreve-se assim, com pontos), assistente da horta no app GrowAI: uma horta semi-hidropônica automatizada de plantas medicinais, com irrigação por sensor de umidade, luz de cultivo, ventiladores com luz UV, dosador de nutriente e uma câmera que a IA analisa.

## A horta desta pessoa
${horta}

${anteriores}## Pergunta
${pergunta}

## Como responder
- Português do Brasil, tom amigável e direto, como quem entende de horta.
- No máximo 120 palavras. Prefira passos práticos e curtos.
- Use os dados da horta acima quando ajudarem (planta, rotina, última análise).
  Se sugerir mudar a rotina, diga que dá para ajustar em "Configurar rotina".
- Não invente medições que não estão acima. O projeto NÃO tem pH (nem sensor, nem
  meta): não fale de pH.
- Não faça afirmações médicas ou terapêuticas (dose, cura, efeito no corpo).
- Se a pergunta não tiver relação com plantas, horta ou o app, diga com
  gentileza que você só ajuda com a horta.
- O que o app tem (cite pelo nome quando servir): em Câmera, abrir a foto
  mostra o ao vivo e o botão "Analisar saúde agora" (a IA reanalisa a última
  foto); em Estações, "Configurar rotina" (luz, umidade, rega, UV) e
  "Controlar placa" (ligar bomba, luz, ventilação manualmente); Relatórios
  mostra a saúde e a umidade da semana e do dia. Não invente outros botões.
- Pode usar **negrito** em uma ou duas palavras-chave; nada de títulos.
- Responda só o texto da resposta, sem título e sem assinar.`;
}

// POST /api/vera { pergunta }
async function perguntar(req, res, next) {
  try {
    const pergunta = String((req.body && req.body.pergunta) || "").trim();
    if (!pergunta) return res.status(400).json({ error: "Escreva sua pergunta." });
    if (pergunta.length > MAX_PERGUNTA) {
      return res.status(400).json({ error: `A pergunta pode ter no máximo ${MAX_PERGUNTA} caracteres.` });
    }

    const rows = await doDia(req.user.id);
    const sit = situacao(rows);
    if (sit.restantes <= 0) {
      return res.status(429).json({ error: `Você já fez as ${LIMITE_DIARIO} perguntas de hoje. A V.E.R.A volta amanhã!`, ...sit });
    }

    const horta = await contextoDaHorta(req.user.id);
    const r = await perguntarTexto(montarPrompt({ pergunta, horta, conversa: sit.conversa }));
    let resposta = r.ok ? r.texto : null;
    if (resposta && resposta.length > 1500) resposta = resposta.slice(0, 1499) + "…";

    await db.query("INSERT INTO vera_perguntas (user_id, pergunta, resposta, ok) VALUES ($1, $2, $3, $4)", [
      req.user.id,
      pergunta,
      resposta || r.motivo || null,
      !!r.ok,
    ]);

    if (!r.ok) {
      console.warn(`[vera] usuário ${req.user.id}: IA falhou — ${r.motivo}`);
      const cota = /429|quota/i.test(r.motivo || "");
      return res.status(503).json({
        error: cota
          ? "A IA atingiu o limite de hoje. Sua pergunta não foi descontada; tente amanhã."
          : "A V.E.R.A não conseguiu responder agora. Sua pergunta não foi descontada; tente de novo em alguns minutos.",
        ...situacao(await doDia(req.user.id)),
      });
    }

    res.json({ resposta, ...situacao(await doDia(req.user.id)) });
  } catch (err) {
    next(err);
  }
}

module.exports = { estado, perguntar, LIMITE_DIARIO };
