// Envio de e-mails transacionais (redefinição de senha) pela API do Resend.
// Usa o fetch nativo do Node 22, sem dependência extra.
//
// Variáveis de ambiente (projeto "growai-backend" na Vercel / backend/.env):
//   RESEND_API_KEY  chave da API do Resend (obrigatória para enviar)
//   MAIL_FROM       remetente, ex.: "TrackLink <no-reply@seudominio.com>".
//                   Padrão: o remetente de teste do Resend, que SÓ entrega
//                   para o e-mail dono da conta Resend - para enviar a
//                   qualquer usuário é preciso verificar um domínio lá.
//   FRONTEND_URL    endereço público do site, usado no link do e-mail.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "TrackLink <onboarding@resend.dev>";
const DEFAULT_FRONTEND_URL = "https://growai-xi.vercel.app";

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL).replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendMail({ to, subject, html, text }) {
  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || DEFAULT_FROM,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend recusou o envio (${res.status}): ${detail}`);
  }
}

// Layout simples e compatível com clientes de e-mail (tabelas/estilos inline).
function layout(title, bodyHtml) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#0f1a17;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#182825;border-radius:16px;padding:32px;color:#e7f2eb;">
      <tr><td style="font-size:22px;font-weight:700;color:#5da578;padding-bottom:16px;">TRACKLINK</td></tr>
      <tr><td style="font-size:20px;font-weight:700;padding-bottom:12px;">${title}</td></tr>
      <tr><td style="font-size:15px;line-height:1.6;color:#cde3d5;">${bodyHtml}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendPasswordResetEmail({ to, name, token, ttlMinutes }) {
  const link = `${frontendUrl()}/redefinir-senha.html?token=${encodeURIComponent(token)}`;
  const hello = name ? `Olá, ${escapeHtml(name)}!` : "Olá!";
  await sendMail({
    to,
    subject: "Redefinição de senha - TrackLink",
    html: layout(
      "Redefina sua senha",
      `<p>${hello}</p>
       <p>Recebemos um pedido para redefinir a senha da sua conta. Clique no botão abaixo para escolher uma nova senha. O link vale por <strong>${ttlMinutes} minutos</strong> e só pode ser usado uma vez.</p>
       <p style="margin:24px 0;"><a href="${link}" style="background:#5da578;color:#0f1a17;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:10px;display:inline-block;">Redefinir senha</a></p>
       <p style="font-size:13px;color:#8fb5a0;">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all;">${link}</span></p>
       <p style="font-size:13px;color:#8fb5a0;">Se você não pediu isso, ignore este e-mail: sua senha continua a mesma.</p>`
    ),
    text: `${name ? `Olá, ${name}!` : "Olá!"}\n\nAbra o link para redefinir sua senha (vale por ${ttlMinutes} minutos e só pode ser usado uma vez):\n${link}\n\nSe você não pediu isso, ignore este e-mail.`,
  });
}

async function sendPasswordChangedEmail({ to, name }) {
  const hello = name ? `Olá, ${escapeHtml(name)}!` : "Olá!";
  await sendMail({
    to,
    subject: "Sua senha foi alterada - TrackLink",
    html: layout(
      "Senha alterada com sucesso",
      `<p>${hello}</p>
       <p>A senha da sua conta TrackLink acabou de ser alterada. Se foi você, não precisa fazer nada.</p>
       <p style="color:#e8a5a5;">Se não foi você, redefina a senha imediatamente em <a href="${frontendUrl()}/login.html" style="color:#5da578;">${frontendUrl()}/login.html</a> (opção "Esqueceu a senha?").</p>`
    ),
    text: `${name ? `Olá, ${name}!` : "Olá!"}\n\nA senha da sua conta TrackLink foi alterada. Se não foi você, redefina-a imediatamente em ${frontendUrl()}/login.html (opção "Esqueceu a senha?").`,
  });
}

module.exports = { isConfigured, sendPasswordResetEmail, sendPasswordChangedEmail };
