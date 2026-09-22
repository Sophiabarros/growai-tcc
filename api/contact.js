// Vercel Serverless Function (Node runtime) — independente do backend/
// Express (que não está deployado aqui). Usada por js/sobre.js no
// formulário "Contate-nos" da página sobre.html.
//
// Precisa da variável de ambiente RESEND_API_KEY no projeto da Vercel que
// serve o site (Settings -> Environment Variables, ambiente Production).
// Opcionais: CONTACT_TO_EMAIL (destino) e CONTACT_FROM_EMAIL (remetente).
const RESEND_API_URL = "https://api.resend.com/emails";

// Sem domínio verificado no Resend só o remetente de teste funciona — e ele
// só entrega para o e-mail dono da conta Resend.
const DEFAULT_FROM = "TrackLink <onboarding@resend.dev>";
const DEFAULT_TO = "tracklink.system@gmail.com";

const MAX_NOME = 100;
const MAX_EMAIL = 254;
const MAX_MENSAGEM = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Em produção o formulário chama /api/contact no mesmo domínio (sem CORS).
// Estas origens só existem pra permitir testar o formulário de um servidor
// local (localhost:5050, Live Server, IP da rede) contra a função publicada.
const ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$|^https:\/\/growai[a-z0-9-]*\.vercel\.app$/;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN_RE.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

// req.body já vem parseado quando o Content-Type é JSON, mas vira string
// se o cliente mandar outro tipo — tenta o JSON antes de desistir.
function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const body = readBody(req);
  const nome = clean(body.nome);
  const email = clean(body.email);
  const mensagem = clean(body.mensagem);

  if (!nome || !email || !mensagem) {
    return res.status(400).json({ error: "Preencha nome, email e mensagem." });
  }

  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
    return res.status(400).json({ error: "Informe um e-mail válido." });
  }

  if (nome.length > MAX_NOME || mensagem.length > MAX_MENSAGEM) {
    return res.status(400).json({ error: "Nome ou mensagem muito longos." });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY não configurada nas variáveis de ambiente da Vercel");
    return res.status(500).json({ error: "Serviço de e-mail não configurado." });
  }

  const to = process.env.CONTACT_TO_EMAIL || DEFAULT_TO;
  const from = process.env.CONTACT_FROM_EMAIL || DEFAULT_FROM;

  let resendRes;
  try {
    resendRes = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: `Novo contato pelo site - ${nome.replace(/[\r\n]+/g, " ")}`,
        html:
          `<p><strong>Nome:</strong> ${escapeHtml(nome)}</p>` +
          `<p><strong>Email:</strong> ${escapeHtml(email)}</p>` +
          `<p><strong>Mensagem:</strong></p><p>${escapeHtml(mensagem).replace(/\n/g, "<br>")}</p>`,
      }),
    });
  } catch (err) {
    console.error("Erro de rede ao chamar a API do Resend:", err);
    return res.status(502).json({ error: "Falha ao enviar e-mail. Tente novamente." });
  }

  const data = await resendRes.json().catch(() => null);

  if (!resendRes.ok) {
    console.error("Resend recusou o envio:", data);
    return res.status(502).json({ error: "Falha ao enviar e-mail. Tente novamente." });
  }

  res.status(200).json({ ok: true, id: data && data.id });
};
