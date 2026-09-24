// Política de senha do GrowAI. Aplicada ao CRIAR ou REDEFINIR uma senha
// (cadastro e "esqueci minha senha"); o login não revalida, para não trancar
// para fora quem já tem uma senha antiga.
//
// Regras:
//   - mínimo de 8 caracteres;
//   - pelo menos 1 caractere especial (qualquer símbolo que não seja letra,
//     dígito ou espaço - letras acentuadas como "ç" NÃO contam como especial);
//   - máximo de 72 caracteres: o bcrypt ignora o que passa de 72 bytes, então
//     aceitar mais que isso daria uma falsa sensação de segurança.
//
// A mesma regra existe no navegador em js/password-policy.js (feedback
// visual). Mantenha os dois arquivos em sincronia.

const MIN_LENGTH = 8;
const MAX_LENGTH = 72;
const SPECIAL_CHAR_RE = /[^\p{L}\p{N}\s]/u;

/**
 * @param {unknown} password
 * @returns {string|null} mensagem de erro em português, ou null se a senha é válida
 */
function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return "Informe uma senha.";
  }
  if (password.length < MIN_LENGTH) {
    return `A senha deve ter no mínimo ${MIN_LENGTH} caracteres.`;
  }
  if (password.length > MAX_LENGTH) {
    return `A senha deve ter no máximo ${MAX_LENGTH} caracteres.`;
  }
  if (!SPECIAL_CHAR_RE.test(password)) {
    return "A senha deve ter pelo menos 1 caractere especial (ex.: ! @ # $ % &).";
  }
  return null;
}

module.exports = { validatePassword, MIN_LENGTH, MAX_LENGTH };
