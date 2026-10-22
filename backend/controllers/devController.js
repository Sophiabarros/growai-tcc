// Painel de desenvolvedor (Configurações > Desenvolvedor > Uso da IA).
//
// Mostra quanto da cota gratuita do Gemini já foi hoje, por modelo, o que
// ainda dá para fazer e por que a IA falhou — porque o "erro sem motivo" quase
// sempre é cota esgotada (429), e o Gemini não informa o saldo: os números
// saem do registro de chamadas (services/iaUso.js).
//
// Protegido por login E pela senha de desenvolvedor, conferida AQUI (nunca no
// navegador). O código guarda só o sha256 da senha; DEV_SENHA_HASH no
// ambiente troca a senha sem mexer no código.

const crypto = require("crypto");
const db = require("../config/db");
const iaUso = require("../services/iaUso");
const ia = require("../services/ia");

const HASH_PADRAO = "26e9845e7132421f2b39b96a2b1760ceac0ddfcb0ded33e3359d92065b75d79c";
const LIMITE_DIA = Number(process.env.IA_LIMITE_DIA_MODELO) || 20; // cota gratuita do Gemini por modelo
const TZ_COTA = "America/Los_Angeles"; // a cota do Gemini vira à meia-noite do Pacífico
const TZ_SP = "America/Sao_Paulo";

// Senha errada demais: espera (por usuário, em memória).
const tentativas = new Map();
function bloqueado(userId) {
  const t = tentativas.get(userId);
  return t && t.n >= 5 && Date.now() - t.em < 5 * 60 * 1000;
}
function errou(userId) {
  const t = tentativas.get(userId);
  if (!t || Date.now() - t.em > 5 * 60 * 1000) tentativas.set(userId, { n: 1, em: Date.now() });
  else t.n += 1;
}

function senhaConfere(senha) {
  const esperado = Buffer.from(process.env.DEV_SENHA_HASH || HASH_PADRAO, "hex");
  const recebido = crypto.createHash("sha256").update(String(senha || ""), "utf8").digest();
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

// Middleware: login já passou (requireAuth); aqui só a senha.
function exigirSenha(req, res, next) {
  if (bloqueado(req.user.id)) {
    return res.status(429).json({ error: "Muitas tentativas erradas. Espere 5 minutos." });
  }
  if (!senhaConfere(req.headers["x-dev-senha"])) {
    errou(req.user.id);
    return res.status(403).json({ error: "Senha de desenvolvedor incorreta." });
  }
  tentativas.delete(req.user.id);
  next();
}

/* Traduz o erro cru do provedor para o que a pessoa precisa saber. */
function explicarErro(status, erro) {
  const t = String(erro || "");
  if (status === 429 && /per ?day|PerDay|daily/i.test(t)) return "Cota do dia esgotada neste modelo";
  if (status === 429 && /per ?minute|PerMinute/i.test(t)) return "Muitas chamadas no mesmo minuto (passa em segundos)";
  if (status === 429) return "Cota esgotada (429)";
  if (status === 503 || /high demand|overloaded/i.test(t)) return "Servidor da IA sobrecarregado (não gasta cota)";
  if (status === 0 || /tempo|timeout|abort/i.test(t)) return "A IA não respondeu a tempo";
  if (status === 400) return "Pedido recusado pela IA (400)";
  if (status === 401 || status === 403) return "Chave da API inválida ou sem permissão";
  if (status >= 500) return "Erro no servidor da IA (" + status + ")";
  return t.slice(0, 120) || "Erro " + status;
}

// Próxima virada da cota (meia-noite do Pacífico), em ISO.
function proximaVirada() {
  const agora = new Date();
  const pt = new Date(agora.toLocaleString("en-US", { timeZone: TZ_COTA }));
  const diff = agora.getTime() - pt.getTime(); // deslocamento PT -> UTC
  const meia = new Date(pt);
  meia.setHours(24, 0, 0, 0);
  return new Date(meia.getTime() + diff).toISOString();
}

// GET /api/dev/ia-uso
async function usoIa(req, res, next) {
  try {
    await iaUso.garantirTabela();
    const modelos = ia.modelosGemini();
    const [porModelo, porModo, erros, semana, vera] = await Promise.all([
      db.query(
        `SELECT modelo, provedor,
                count(*) FILTER (WHERE ok)::int                AS usadas,
                count(*)::int                                  AS tentativas,
                count(*) FILTER (WHERE status = 429)::int      AS cota,
                coalesce(sum(tokens) FILTER (WHERE ok), 0)::int AS tokens,
                max(em) FILTER (WHERE status = 429)            AS ultima_429,
                max(em) FILTER (WHERE ok)                      AS ultima_ok
           FROM ia_uso
          WHERE (em AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
          GROUP BY modelo, provedor`,
        [TZ_COTA]
      ),
      db.query(
        `SELECT coalesce(modo, 'outro') AS modo, count(*) FILTER (WHERE ok)::int AS usadas, count(*)::int AS tentativas
           FROM ia_uso
          WHERE (em AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
          GROUP BY 1`,
        [TZ_COTA]
      ),
      db.query(
        `SELECT em, modo, modelo, status, erro FROM ia_uso WHERE NOT ok ORDER BY em DESC LIMIT 12`
      ),
      db.query(
        `SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia,
                count(u.id) FILTER (WHERE u.ok)::int          AS usadas,
                count(u.id) FILTER (WHERE u.status = 429)::int AS cota,
                count(u.id) FILTER (WHERE NOT u.ok)::int      AS falhas,
                coalesce(sum(u.tokens) FILTER (WHERE u.ok), 0)::int AS tokens
           FROM generate_series((now() AT TIME ZONE $1)::date - 6, (now() AT TIME ZONE $1)::date, interval '1 day') AS d(dia)
           LEFT JOIN ia_uso u ON (u.em AT TIME ZONE $1)::date = d.dia::date
          GROUP BY d.dia ORDER BY d.dia`,
        [TZ_COTA]
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE ok)::int AS minhas
           FROM vera_perguntas
          WHERE user_id = $1 AND (criado_em AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
        [req.user.id, TZ_SP]
      ),
    ]);

    const linha = (m) => porModelo.rows.find((r) => r.modelo === m) || {};
    const lista = modelos.map((m, i) => {
      const r = linha(m);
      const usadas = r.usadas || 0;
      // 429 de cota diária depois do último sucesso = este modelo acabou hoje.
      const esgotado =
        usadas >= LIMITE_DIA ||
        (!!r.ultima_429 && (!r.ultima_ok || new Date(r.ultima_429) > new Date(r.ultima_ok)));
      return {
        modelo: m,
        papel: i === 0 ? "principal" : "reserva",
        usadas,
        limite: LIMITE_DIA,
        restantes: esgotado ? 0 : Math.max(0, LIMITE_DIA - usadas),
        tentativas: r.tentativas || 0,
        erros_cota: r.cota || 0,
        tokens: r.tokens || 0,
        esgotado,
      };
    });
    // Claude como última reserva (só se houver chave).
    const claude = porModelo.rows.filter((r) => r.provedor === "claude");

    const restantes = lista.reduce((a, m) => a + m.restantes, 0);
    const temChave = !!process.env.GEMINI_API_KEY || (ia.provedor() === "claude" && !!process.env.ANTHROPIC_API_KEY);
    let status = "ok";
    if (!ia.habilitada()) status = "desligada";
    else if (!temChave) status = "sem_chave";
    else if (restantes === 0) status = "esgotada";
    else if (lista[0] && lista[0].restantes === 0) status = "reserva";
    else if (restantes <= 5) status = "pouca";

    const intervaloFoto = Number(process.env.IA_FOTO_INTERVALO_MIN || 180);
    const { rows: est } = await db.query("SELECT count(*)::int AS n FROM devices WHERE tipo = 'cam' AND last_seen > now() - interval '1 day'");
    const camsAtivas = est[0] ? est[0].n : 0;

    res.json({
      status,
      provedor: ia.provedor(),
      restantes,
      limite_total: lista.length * LIMITE_DIA,
      virada_em: proximaVirada(),
      modelos: lista,
      claude: claude.length ? { usadas: claude.reduce((a, r) => a + r.usadas, 0), tokens: claude.reduce((a, r) => a + r.tokens, 0) } : null,
      claude_reserva: !!process.env.ANTHROPIC_API_KEY,
      hoje: {
        por_modo: Object.fromEntries(porModo.rows.map((r) => [r.modo, { usadas: r.usadas, tentativas: r.tentativas }])),
        tokens: lista.reduce((a, m) => a + m.tokens, 0),
      },
      // O que ainda dá para fazer hoje com o que sobra (1 chamada cada).
      capacidade: {
        analises_foto: restantes,
        avaliacoes_rotina: restantes,
        perguntas_vera: restantes,
        automaticas_restantes_hoje: camsAtivas * Math.ceil((24 * 60) / intervaloFoto),
      },
      config: {
        intervalo_foto_min: intervaloFoto,
        cameras_ativas: camsAtivas,
        vera_limite: Number(process.env.VERA_LIMITE_DIARIO) || 3,
        vera_minhas_hoje: vera.rows[0] ? vera.rows[0].minhas : 0,
      },
      erros: erros.rows.map((e) => ({ em: e.em, modo: e.modo, modelo: e.modelo, status: e.status, motivo: explicarErro(e.status, e.erro), detalhe: e.erro })),
      semana: semana.rows,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/dev/ia-teste — uma pergunta mínima, para ver se a IA responde agora.
async function testarIa(req, res, next) {
  try {
    const inicio = Date.now();
    const r = await ia.perguntarTexto("Responda apenas com a palavra: ok", "teste");
    res.json({
      ok: !!r.ok,
      modelo: r.modelo || null,
      ms: Date.now() - inicio,
      resposta: r.ok ? String(r.texto).slice(0, 40) : null,
      motivo: r.ok ? null : explicarErro(/\b429\b/.test(r.motivo || "") ? 429 : /\b503\b/.test(r.motivo || "") ? 503 : 0, r.motivo),
      detalhe: r.ok ? null : r.motivo,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { exigirSenha, usoIa, testarIa };
