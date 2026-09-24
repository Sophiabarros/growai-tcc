const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { validatePassword } = require("../services/passwordPolicy");
const passwordReset = require("../services/passwordReset");
const mailer = require("../services/mailer");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Nome, e-mail e senha são obrigatórios" });
    }
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Informe um e-mail válido." });
    }
    // Política de senha (mín. 8 caracteres + 1 caractere especial). É a
    // validação que vale de verdade: a do navegador é só feedback visual.
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email, avatar_url`,
      [name, email, hash]
    );
    const user = rows[0];

    await db.query(
      `INSERT INTO notification_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    res.status(201).json({ user, token: signToken(user.id) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "E-mail já cadastrado" });
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    res.json({
      user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url },
      token: signToken(user.id),
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT id, name, email, avatar_url, created_at FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// Atualiza o perfil: nome e, opcionalmente, a foto (campo multipart "avatar").
// Sem storage de arquivos na Vercel (filesystem somente-leitura), a foto
// - já reduzida pelo front para ~256px - é guardada no próprio banco como
// data URL em users.avatar_url, e o front usa esse valor direto no <img>.
async function updateMe(req, res, next) {
  try {
    const { name } = req.body;
    const avatarUrl = req.file
      ? `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`
      : null;

    const { rows } = await db.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           avatar_url = COALESCE($2, avatar_url)
       WHERE id = $3
       RETURNING id, name, email, avatar_url`,
      [name || null, avatarUrl, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/forgot-password  { email }
// Envia por e-mail um link com token de uso único e prazo de validade. A
// resposta é SEMPRE a mesma, exista ou não uma conta com esse e-mail, para
// ninguém descobrir quem é cliente testando endereços.
async function forgotPassword(req, res, next) {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Informe um e-mail válido." });
    }
    // Falha de configuração do servidor (vale para qualquer e-mail, então não
    // revela nada sobre contas): melhor avisar do que fingir que enviou.
    if (!mailer.isConfigured()) {
      console.error("RESEND_API_KEY não configurada: não é possível enviar e-mails de redefinição");
      return res.status(503).json({ error: "Serviço de e-mail indisponível no momento. Tente mais tarde." });
    }

    const { rows } = await db.query(
      "SELECT id, name, email FROM users WHERE lower(email) = lower($1)",
      [email]
    );
    const user = rows[0];
    if (user) {
      try {
        const token = await passwordReset.createToken(user.id);
        if (token) {
          await mailer.sendPasswordResetEmail({
            to: user.email,
            name: user.name,
            token,
            ttlMinutes: passwordReset.TTL_MINUTES,
          });
        }
      } catch (err) {
        // Não vaza o erro para o cliente (mesma resposta de sempre), mas fica no log.
        console.error("Falha ao enviar e-mail de redefinição:", err);
      }
    }

    res.json({
      message: "Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha.",
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/reset-password  { token, password }
// Troca a senha usando o token do e-mail. O token é consumido na mesma
// transação da troca: se algo falhar, ele continua válido.
async function resetPassword(req, res, next) {
  const { token, password } = req.body;
  if (typeof token !== "string" || token.length < 32) {
    return res.status(400).json({ error: "Link inválido ou expirado. Solicite um novo." });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  let client;
  try {
    await passwordReset.ensureTable();
    client = await db.pool.connect();
    await client.query("BEGIN");

    const userId = await passwordReset.consumeToken(client, token);
    if (!userId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Link inválido ou expirado. Solicite um novo." });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING name, email",
      [hash, userId]
    );
    // qualquer outro link ainda aberto para esta conta deixa de valer
    await client.query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [userId]);
    await client.query("COMMIT");

    // E-mail de confirmação: se falhar, a senha já foi trocada e isso não
    // deve virar erro para o usuário.
    if (mailer.isConfigured() && rows[0]) {
      mailer
        .sendPasswordChangedEmail({ to: rows[0].email, name: rows[0].name })
        .catch((err) => console.error("Falha ao enviar confirmação de senha alterada:", err));
    }

    res.json({ message: "Senha redefinida com sucesso. Você já pode entrar." });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
}

module.exports = { register, login, me, updateMe, forgotPassword, resetPassword };
