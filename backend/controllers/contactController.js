const RESEND_API_URL = "https://api.resend.com/emails";

// Mantido igual a api/contact.js (função da Vercel que serve o site).
const DEFAULT_FROM = "TrackLink <onboarding@resend.dev>";
const DEFAULT_TO = "tracklink.system@gmail.com";
const MAX_NOME = 100;
const MAX_EMAIL = 254;
const MAX_MENSAGEM = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendContactEmail(req, res) {
  const body = req.body || {};
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
    console.error("RESEND_API_KEY não configurada em backend/.env");
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
}

module.exports = { sendContactEmail };
