const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Nome, e-mail e senha são obrigatórios" });
    }

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

module.exports = { register, login, me, updateMe };
