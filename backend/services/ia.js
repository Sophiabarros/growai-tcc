// Chamadas de IA. Dois provedores, escolhidos por IA_PROVIDER.
// Usa o fetch nativo do Node 22 — nenhum SDK instalado.
//
// Dois modos, mesma validação e mesmo formato de retorno:
//   modo "foto"   - analisa a imagem (sinais visuais). Precisa de jpegBuffer.
//   modo "rotina" - avalia os números da rotina contra a espécie e a
//                   finalidade. NÃO manda imagem, então é mais rápido e barato.
//
// Interface única:
//   analisar({ modo, jpegBuffer, estacao, leitura, config })
//     -> { ok: true,  health_status, analysis_text, suggestion, raw, provider, model }
//     -> { ok: false, motivo, raw, provider, model }
//
// Falha é caminho esperado, não exceção: quem chama grava a foto como
// 'indefinido' e responde 200 de qualquer jeito. A placa não reenvia foto, e
// perder o diagnóstico é melhor que perder a imagem.

const { montarPromptFoto, montarPromptRotina, ESQUEMA_RESPOSTA, ESQUEMA_ROTINA, ESQUEMA_FOTO, ESQUEMA_FOTO_LUZ } = require("./iaPrompt");
const { LIMITES } = require("./configDispositivo");
const { temperaturaSaoPaulo } = require("./temperaturaExterna");

const TIMEOUT_MS = Number(process.env.IA_TIMEOUT_MS || 25000);
/* A avaliação de rotina devolve a rotina inteira (7 campos) e leva mais que a
   foto: medido em ~24 s, colado no limite de 25. Quem espera é o usuário com
   o app aberto, e o Render não corta a requisição, então ela tem folga própria. */
const TIMEOUT_ROTINA_MS = Number(process.env.IA_TIMEOUT_ROTINA_MS || 45000);
const MAX_TEXTO = 200;
const MAX_PCT = 30;
// Campos que a IA pode propor em suggestion.config.
const CAMPOS_SUGESTAO = [
  "humidity_target",
  "light_hours",
  "vent_min_por_hora",
  "temp_max",
  "nutri_s",
  "water_interval_h",
  "uv_min_dia",
];

function habilitada() {
  return String(process.env.IA_HABILITADA || "true").toLowerCase() !== "false";
}

function provedor() {
  return (process.env.IA_PROVIDER || "gemini").toLowerCase();
}

// ------------------------------------------------------ esquemas por provedor
/* O mesmo esquema lógico, em dois dialetos.
   Gemini usa o subconjunto OpenAPI: `type` é uma string só e nulo se marca com
   `nullable: true`; ele não conhece `additionalProperties`.
   Claude usa JSON Schema: nulo se expressa com `anyOf`. */
function paraGemini(no) {
  if (!no || typeof no !== "object") return no;
  const saida = {};
  for (const [k, v] of Object.entries(no)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      saida.type = v.find((t) => t !== "null") || "string";
      if (v.includes("null")) saida.nullable = true;
      continue;
    }
    if (k === "properties") {
      saida.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, paraGemini(pv)]));
      continue;
    }
    saida[k] = v && typeof v === "object" && !Array.isArray(v) ? paraGemini(v) : v;
  }
  return saida;
}

function paraClaude(no) {
  if (!no || typeof no !== "object") return no;
  if (Array.isArray(no.type) && no.type.includes("null")) {
    const semNulo = { ...no, type: no.type.find((t) => t !== "null") || "string" };
    return { anyOf: [paraClaude(semNulo), { type: "null" }] };
  }
  const saida = {};
  for (const [k, v] of Object.entries(no)) {
    if (k === "properties") {
      saida.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, paraClaude(pv)]));
      continue;
    }
    saida[k] = v && typeof v === "object" && !Array.isArray(v) ? paraClaude(v) : v;
  }
  return saida;
}

// ---------------------------------------------------------------- validação
function corta(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/* Nada que a IA devolve entra no banco sem passar por aqui. JSON fora do
   formato conta como falha da IA; valor fora do limite é cortado para o
   limite (não recusado), porque a intenção do modelo ainda é aproveitável. */
function validarResposta(obj) {
  if (!obj || typeof obj !== "object") return { erro: "resposta não é objeto" };

  const status = String(obj.health_status || "").toLowerCase();
  if (status !== "saudavel" && status !== "atencao") {
    return { erro: `health_status inválido: ${JSON.stringify(obj.health_status)}` };
  }

  let texto = obj.analysis_text;
  if (typeof texto !== "string" || !texto.trim()) return { erro: "analysis_text vazio" };
  texto = texto.trim();
  if (texto.length > MAX_TEXTO) texto = texto.slice(0, MAX_TEXTO - 1).trimEnd() + "…";

  let sugestao = null;
  const s = obj.suggestion;
  if (s && typeof s === "object") {
    const msg = typeof s.message === "string" ? s.message.trim() : "";
    if (msg) {
      const cfg = {};
      const origem = s.config && typeof s.config === "object" ? s.config : {};
      for (const campo of CAMPOS_SUGESTAO) {
        if (origem[campo] === undefined || origem[campo] === null) continue;
        const v = corta(origem[campo], LIMITES[campo][0], LIMITES[campo][1]);
        if (v === null) continue;
        if (campo === "vent_min_por_hora" || campo === "nutri_s" || campo === "water_interval_h" || campo === "uv_min_dia") cfg[campo] = Math.round(v);
        else cfg[campo] = v;
      }
      sugestao = {
        message: msg.length > 300 ? msg.slice(0, 299) + "…" : msg,
        growth_pct: corta(s.growth_pct, 0, MAX_PCT) ?? 0,
        health_pct: corta(s.health_pct, 0, MAX_PCT) ?? 0,
      };
      // Sugestão sem nenhum ajuste de config vira só um recado; ainda vale
      // guardar, mas não há o que aplicar.
      if (Object.keys(cfg).length) sugestao.config = cfg;
    }
  }

  /* Anti-pragas (só no modo foto). Valor fora do esperado vira null: não dá
     para afirmar praga a partir de uma resposta quebrada. */
  let pragas = String(obj.pragas || "").toLowerCase();
  if (pragas === "não") pragas = "nao";
  if (!["sim", "nao", "incerto"].includes(pragas)) pragas = null;
  let pragasDescricao = typeof obj.pragas_descricao === "string" ? obj.pragas_descricao.trim() : "";
  if (pragas !== "sim" || !pragasDescricao) pragasDescricao = null;
  else if (pragasDescricao.length > 120) pragasDescricao = pragasDescricao.slice(0, 119) + "…";

  // Iluminação (só quando foi mandado o quadro da luz).
  let luzNivel = String(obj.luz_nivel || "").toLowerCase();
  if (!["pouca", "boa", "muita", "incerto"].includes(luzNivel)) luzNivel = null;
  let luzDescricao = typeof obj.luz_descricao === "string" ? obj.luz_descricao.trim() : "";
  if (!luzNivel || !luzDescricao) luzDescricao = null;
  else if (luzDescricao.length > 120) luzDescricao = luzDescricao.slice(0, 119) + "…";

  return {
    health_status: status, analysis_text: texto, suggestion: sugestao,
    pragas, pragas_descricao: pragasDescricao,
    luz_nivel: luzNivel, luz_descricao: luzDescricao,
  };
}

// Tira o JSON de um texto que pode vir embrulhado em ```json ... ```
function extrairJson(texto) {
  if (typeof texto !== "string") return null;
  let t = texto.trim();
  const cerca = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (cerca) t = cerca[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // Última tentativa: o primeiro objeto balanceado do texto.
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    try {
      return JSON.parse(t.slice(i, j + 1));
    } catch {
      return null;
    }
  }
}

async function postJson(url, headers, corpo, timeoutMs = TIMEOUT_MS) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(corpo),
      signal: controle.signal,
    });
    const texto = await res.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {
      /* deixa null: o corpo de erro nem sempre é JSON */
    }
    return { status: res.status, ok: res.ok, json, texto };
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------- Gemini
/* Modelo principal seguido dos de reserva. No plano gratuito o Google atende
   primeiro quem paga, e o 503 "high demand" vem em rajadas que duram minutos:
   repetir no MESMO modelo não resolvia, e o app vivia mostrando "IA
   sobrecarregada". Outro modelo quase sempre está livre, e cada um tem a sua
   cota de 20/dia, então a reserva também multiplica a cota.
   Nada de modelo -lite aqui: eles alucinam em foto escura (ver README). */
function modelosGemini() {
  const principal = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const reserva = (process.env.GEMINI_MODELOS_RESERVA ?? "gemini-3.5-flash,gemini-3.7-flash")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== principal);
  return [principal, ...reserva];
}

// Falha que outro modelo pode não ter: sobrecarga, cota esgotada ou demora.
function falhaPassageira(r) {
  return r.timeout || [429, 500, 502, 503, 504].includes(r.status);
}

async function chamarGemini({ jpegBuffer, luzBuffer, prompt, esquema, timeoutMs }) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) return { erro: "GEMINI_API_KEY não configurada" };

  /* Orçamento total da cadeia: um modelo que estourou o tempo já gastou
     timeoutMs, e quem espera é o usuário com o app aberto. Só passa para o
     próximo modelo se ainda sobra pelo menos metade de uma chamada. */
  /* 2,2x: se o principal estoura o tempo inteiro (visto com o 3.6-flash
     sob carga), ainda sobra ~1 timeout para o modelo de reserva. Com 1,5x
     não sobrava e a análise falhava sem tentar a reserva. */
  const prazo = Date.now() + timeoutMs * 2.2;
  const erros = [];
  let ultimo = null;
  for (const modelo of modelosGemini()) {
    const restante = prazo - Date.now();
    if (erros.length && restante < timeoutMs / 2) break;
    let r;
    try {
      r = await chamarModeloGemini({ modelo, chave, jpegBuffer, luzBuffer, prompt, esquema, timeoutMs: Math.min(timeoutMs, restante) });
    } catch (err) {
      if (err.name !== "AbortError") throw err;
      r = { erro: `Gemini ${modelo} não respondeu a tempo`, timeout: true };
    }
    if (!r.erro) {
      if (erros.length) console.warn(`[ia] ${modelo} respondeu depois de: ${erros.join(" | ")}`);
      return r;
    }
    erros.push(r.erro);
    ultimo = r;
    if (!falhaPassageira(r)) break;
  }
  return { erro: erros.join(" | "), raw: ultimo && ultimo.raw, modelo: ultimo && ultimo.modelo, passageira: falhaPassageira(ultimo) };
}

async function chamarModeloGemini({ modelo, chave, jpegBuffer, luzBuffer, prompt, esquema, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
  // Sem jpegBuffer (modo rotina) vai só o texto.
  const parts = [];
  if (jpegBuffer) parts.push({ inline_data: { mime_type: "image/jpeg", data: jpegBuffer.toString("base64") } });
  // IMAGEM 2: o quadro da iluminação (sem flash, luz de cultivo acesa).
  if (luzBuffer) parts.push({ inline_data: { mime_type: "image/jpeg", data: luzBuffer.toString("base64") } });
  parts.push({ text: prompt });

  /* esquema === false: resposta em TEXTO livre (chat da Vera), sem JSON. */
  const emTexto = esquema === false;
  const base = {
    contents: [{ parts }],
    generationConfig: {
      ...(emTexto
        ? {}
        : { responseMimeType: "application/json", responseSchema: paraGemini(esquema || ESQUEMA_RESPOSTA) }),
      temperature: emTexto ? 0.5 : 0.2,
      /* 4096 para um JSON de ~150 caracteres parece exagero, mas os modelos
         Gemini 3.x gastam orçamento de SAÍDA com raciocínio interno antes de
         escrever a resposta. Com 800 o modelo era cortado no meio e voltava
         finishReason MAX_TOKENS, sem JSON nenhum. Só o que ele realmente
         escreve é cobrado, então o teto alto não custa nada. */
      maxOutputTokens: 4096,
    },
  };

  let r = await postJson(url, { "x-goog-api-key": chave }, base, timeoutMs);

  /* 503 "high demand" (e 500/502/504) é sobrecarga do Gemini, não erro
     nosso, e não gasta cota. Uma nova tentativa após 2 s pega os soluços
     curtos; se persistir, chamarGemini() passa para o modelo de reserva.
     429 (cota) não repete: só pioraria. */
  if (!r.ok && [500, 502, 503, 504].includes(r.status)) {
    await new Promise((ok) => setTimeout(ok, 2000));
    r = await postJson(url, { "x-goog-api-key": chave }, base, timeoutMs);
  }

  /* Se o esquema for recusado (o dialeto aceito pelo Gemini muda entre
     versões), tenta de novo só com responseMimeType: o prompt já descreve o
     JSON e validarResposta() confere tudo do lado do servidor. Assim uma
     mudança no esquema deles não transforma toda foto em 'indefinido'. */
  if (!r.ok && r.status === 400) {
    const semEsquema = { ...base, generationConfig: { ...base.generationConfig } };
    delete semEsquema.generationConfig.responseSchema;
    const r2 = await postJson(url, { "x-goog-api-key": chave }, semEsquema, timeoutMs);
    if (r2.ok) r = r2;
    else return { erro: `Gemini ${modelo} ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.texto.slice(0, 300)}`, status: r.status, raw: r.json || r.texto, modelo };
  }

  if (!r.ok) {
    return { erro: `Gemini ${modelo} ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.texto.slice(0, 300)}`, status: r.status, raw: r.json || r.texto, modelo };
  }

  const cand = r.json && r.json.candidates && r.json.candidates[0];
  if (cand && cand.finishReason && cand.finishReason !== "STOP") {
    return { erro: `Gemini ${modelo} encerrou com ${cand.finishReason}`, raw: r.json, modelo };
  }
  const partes = (cand && cand.content && cand.content.parts) || [];
  const texto = partes.map((p) => p.text).filter(Boolean).join("");
  return { texto, raw: r.json, modelo };
}

// ------------------------------------------------------------------- Claude
async function chamarClaude({ jpegBuffer, luzBuffer, prompt, esquema, timeoutMs }) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return { erro: "ANTHROPIC_API_KEY não configurada" };
  const modelo = process.env.CLAUDE_MODEL || "claude-opus-5";

  // Sem jpegBuffer (modo rotina) vai só o texto.
  const conteudoClaude = [];
  if (jpegBuffer) {
    conteudoClaude.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: jpegBuffer.toString("base64") },
    });
  }
  if (luzBuffer) {
    conteudoClaude.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: luzBuffer.toString("base64") },
    });
  }
  conteudoClaude.push({ type: "text", text: prompt });

  const r = await postJson(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": chave, "anthropic-version": "2023-06-01" },
    {
      model: modelo,
      max_tokens: 2000,
      messages: [{ role: "user", content: conteudoClaude }],
      output_config: {
        format: { type: "json_schema", schema: paraClaude(esquema || ESQUEMA_RESPOSTA) },
        // Classificar sinais visuais numa foto não precisa de raciocínio
        // longo, e o timeout aqui é curto (TIMEOUT_MS / TIMEOUT_ROTINA_MS).
        effort: "low",
      },
    },
    timeoutMs
  );

  if (!r.ok) {
    return { erro: `Claude ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.texto.slice(0, 300)}`, raw: r.json || r.texto };
  }
  // Recusa por segurança vem com HTTP 200 e stop_reason "refusal".
  if (r.json && r.json.stop_reason === "refusal") {
    return { erro: "Claude recusou a requisição (stop_reason: refusal)", raw: r.json };
  }

  // Com thinking adaptativo a resposta pode ter blocos antes do texto.
  const blocos = (r.json && r.json.content) || [];
  const texto = blocos.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { texto, raw: r.json, modelo };
}

// -------------------------------------------------------------------- fachada
/* luzBuffer (opcional, só modo foto): quadro da iluminação, tirado ~20 s
   antes da foto, sem flash, com a luz de cultivo acesa e exposição travada.
   Com ele, a resposta traz luz_nivel/luz_descricao na mesma chamada. */
async function analisar({ modo = "foto", jpegBuffer, luzBuffer = null, estacao, leitura, config }) {
  let nome = provedor();

  if (!habilitada()) {
    return { ok: false, motivo: "IA desligada (IA_HABILITADA=false)", raw: null, provider: nome, model: null };
  }
  if (modo !== "foto" && modo !== "rotina") {
    return { ok: false, motivo: `modo desconhecido: ${modo}`, raw: null, provider: nome, model: null };
  }
  // Só o modo foto precisa de imagem; o modo rotina julga apenas os números.
  if (modo === "foto" && (!jpegBuffer || !jpegBuffer.length)) {
    return { ok: false, motivo: "imagem vazia", raw: null, provider: nome, model: null };
  }

  // Sensor de temperatura sem leitura: a IA recebe a de São Paulo, marcada.
  if (!leitura || leitura.temperature === null || leitura.temperature === undefined) {
    const externa = await temperaturaSaoPaulo();
    if (externa) leitura = { ...(leitura || {}), temperatura_externa: externa.temperatura };
  }

  const imagem = modo === "foto" ? jpegBuffer : null;
  const luz = modo === "foto" && luzBuffer && luzBuffer.length ? luzBuffer : null;
  const prompt =
    modo === "rotina"
      ? montarPromptRotina({ estacao, leitura, config })
      : montarPromptFoto({ estacao, leitura, config, comLuz: !!luz });

  const timeoutMs = modo === "rotina" ? TIMEOUT_ROTINA_MS : TIMEOUT_MS;
  let r;
  try {
    // A rotina usa um esquema que obriga a config completa (ver iaPrompt.js).
    const esquema = modo === "rotina" ? ESQUEMA_ROTINA : luz ? ESQUEMA_FOTO_LUZ : ESQUEMA_FOTO;
    if (nome === "claude") r = await chamarClaude({ jpegBuffer: imagem, luzBuffer: luz, prompt, esquema, timeoutMs });
    else if (nome === "gemini") {
      r = await chamarGemini({ jpegBuffer: imagem, luzBuffer: luz, prompt, esquema, timeoutMs });
      /* Todos os Gemini cheios ou sem cota: se houver chave da Anthropic, o
         Claude é a última reserva. Sem a chave, nada muda. */
      if (r.erro && r.passageira && process.env.ANTHROPIC_API_KEY) {
        const rc = await chamarClaude({ jpegBuffer: imagem, luzBuffer: luz, prompt, esquema, timeoutMs });
        if (!rc.erro) {
          console.warn(`[ia] Claude respondeu depois de: ${r.erro}`);
          r = rc;
          nome = "claude";
        } else r = { ...rc, erro: `${r.erro} | ${rc.erro}` };
      }
    } else return { ok: false, motivo: `IA_PROVIDER desconhecido: ${nome}`, raw: null, provider: nome, model: null };
  } catch (err) {
    const motivo = err.name === "AbortError" ? `IA não respondeu em ${timeoutMs} ms` : `falha de rede: ${err.message}`;
    return { ok: false, motivo, raw: null, provider: nome, model: null };
  }

  if (r.erro) return { ok: false, motivo: r.erro, raw: r.raw || null, provider: nome, model: r.modelo || null };

  const bruto = extrairJson(r.texto);
  if (!bruto) {
    return { ok: false, motivo: "resposta da IA não é JSON válido", raw: r.raw, provider: nome, model: r.modelo };
  }

  const validado = validarResposta(bruto);
  if (validado.erro) {
    return { ok: false, motivo: `resposta da IA inválida: ${validado.erro}`, raw: r.raw, provider: nome, model: r.modelo };
  }

  return { ok: true, ...validado, raw: r.raw, provider: nome, model: r.modelo, modo };
}

// Atalho: avalia só a rotina, sem foto.
function avaliarRotina({ estacao, leitura, config }) {
  return analisar({ modo: "rotina", estacao, leitura, config });
}

/* Vera: uma pergunta em texto livre, com o contexto da horta já no prompt
   (montado em controllers/veraController.js). Só Gemini, com os modelos de
   reserva. Devolve { ok, texto } ou { ok: false, motivo }. */
async function perguntarTexto(prompt) {
  if (!habilitada()) return { ok: false, motivo: "IA desligada (IA_HABILITADA=false)" };
  try {
    const r = await chamarGemini({ prompt, esquema: false, timeoutMs: TIMEOUT_MS });
    if (r.erro) return { ok: false, motivo: r.erro, modelo: r.modelo };
    const texto = String(r.texto || "").trim();
    if (!texto) return { ok: false, motivo: "resposta vazia" };
    return { ok: true, texto, modelo: r.modelo };
  } catch (err) {
    return { ok: false, motivo: err.name === "AbortError" ? "a IA não respondeu a tempo" : err.message };
  }
}

module.exports = { analisar, avaliarRotina, perguntarTexto, validarResposta, extrairJson, paraGemini, paraClaude, habilitada, provedor };
