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

const { montarPromptFoto, montarPromptRotina, ESQUEMA_RESPOSTA } = require("./iaPrompt");
const { LIMITES } = require("./configDispositivo");

const TIMEOUT_MS = Number(process.env.IA_TIMEOUT_MS || 25000);
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
  "ph_target",
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
        if (campo === "vent_min_por_hora" || campo === "nutri_s" || campo === "water_interval_h") cfg[campo] = Math.round(v);
        else if (campo === "ph_target") cfg[campo] = Math.round(v * 10) / 10;
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

  return { health_status: status, analysis_text: texto, suggestion: sugestao };
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

async function postJson(url, headers, corpo) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), TIMEOUT_MS);
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
async function chamarGemini({ jpegBuffer, prompt }) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) return { erro: "GEMINI_API_KEY não configurada" };
  const modelo = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
  // Sem jpegBuffer (modo rotina) vai só o texto.
  const parts = [];
  if (jpegBuffer) parts.push({ inline_data: { mime_type: "image/jpeg", data: jpegBuffer.toString("base64") } });
  parts.push({ text: prompt });

  const base = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: paraGemini(ESQUEMA_RESPOSTA),
      temperature: 0.2,
      /* 4096 para um JSON de ~150 caracteres parece exagero, mas os modelos
         Gemini 3.x gastam orçamento de SAÍDA com raciocínio interno antes de
         escrever a resposta. Com 800 o modelo era cortado no meio e voltava
         finishReason MAX_TOKENS, sem JSON nenhum. Só o que ele realmente
         escreve é cobrado, então o teto alto não custa nada. */
      maxOutputTokens: 4096,
    },
  };

  let r = await postJson(url, { "x-goog-api-key": chave }, base);

  /* 503 "high demand" (e 500/502/504) é sobrecarga momentânea do Gemini, não
     erro nosso, e não gasta cota. Visto várias vezes no mesmo dia com o
     gemini-3.6-flash: sem repetir, o aviso de rotina inadequada sumia em
     silêncio sempre que o Gemini estava cheio. O 503 volta em ~2 s, então
     duas novas tentativas (após 2 s e 5 s) cabem no tempo de uma chamada
     normal. 429 (cota) não repete: só pioraria. */
  for (const espera of [2000, 5000]) {
    if (r.ok || ![500, 502, 503, 504].includes(r.status)) break;
    await new Promise((ok) => setTimeout(ok, espera));
    r = await postJson(url, { "x-goog-api-key": chave }, base);
  }

  /* Se o esquema for recusado (o dialeto aceito pelo Gemini muda entre
     versões), tenta de novo só com responseMimeType: o prompt já descreve o
     JSON e validarResposta() confere tudo do lado do servidor. Assim uma
     mudança no esquema deles não transforma toda foto em 'indefinido'. */
  if (!r.ok && r.status === 400) {
    const semEsquema = { ...base, generationConfig: { ...base.generationConfig } };
    delete semEsquema.generationConfig.responseSchema;
    const r2 = await postJson(url, { "x-goog-api-key": chave }, semEsquema);
    if (r2.ok) r = r2;
    else return { erro: `Gemini ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.texto.slice(0, 300)}`, raw: r.json || r.texto };
  }

  if (!r.ok) {
    return { erro: `Gemini ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.texto.slice(0, 300)}`, raw: r.json || r.texto };
  }

  const cand = r.json && r.json.candidates && r.json.candidates[0];
  if (cand && cand.finishReason && cand.finishReason !== "STOP") {
    return { erro: `Gemini encerrou com ${cand.finishReason}`, raw: r.json };
  }
  const partes = (cand && cand.content && cand.content.parts) || [];
  const texto = partes.map((p) => p.text).filter(Boolean).join("");
  return { texto, raw: r.json, modelo };
}

// ------------------------------------------------------------------- Claude
async function chamarClaude({ jpegBuffer, prompt }) {
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
  conteudoClaude.push({ type: "text", text: prompt });

  const r = await postJson(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": chave, "anthropic-version": "2023-06-01" },
    {
      model: modelo,
      max_tokens: 2000,
      messages: [{ role: "user", content: conteudoClaude }],
      output_config: {
        format: { type: "json_schema", schema: paraClaude(ESQUEMA_RESPOSTA) },
        // Classificar sinais visuais numa foto não precisa de raciocínio
        // longo, e o timeout aqui é de 25 s.
        effort: "low",
      },
    }
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
async function analisar({ modo = "foto", jpegBuffer, estacao, leitura, config }) {
  const nome = provedor();

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

  const imagem = modo === "foto" ? jpegBuffer : null;
  const prompt =
    modo === "rotina"
      ? montarPromptRotina({ estacao, leitura, config })
      : montarPromptFoto({ estacao, leitura, config });

  let r;
  try {
    if (nome === "claude") r = await chamarClaude({ jpegBuffer: imagem, prompt });
    else if (nome === "gemini") r = await chamarGemini({ jpegBuffer: imagem, prompt });
    else return { ok: false, motivo: `IA_PROVIDER desconhecido: ${nome}`, raw: null, provider: nome, model: null };
  } catch (err) {
    const motivo = err.name === "AbortError" ? `IA não respondeu em ${TIMEOUT_MS} ms` : `falha de rede: ${err.message}`;
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

module.exports = { analisar, avaliarRotina, validarResposta, extrairJson, paraGemini, paraClaude, habilitada, provedor };
