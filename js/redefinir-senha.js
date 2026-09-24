(function () {
  "use strict";

  // Página aberta pelo link do e-mail de "esqueci minha senha":
  //   redefinir-senha.html?token=<token de uso único, válido por 30 min>
  // Mostra o formulário de nova senha e envia token + senha para
  // POST /api/auth/reset-password (GrowAI.resetPassword). Se não houver token,
  // ou se o backend disser que ele expirou/já foi usado, mostra o aviso com o
  // botão "Solicitar novo link".

  var page = document.getElementById("authPage");
  var form = document.getElementById("resetForm");
  var done = document.getElementById("resetDone");
  var invalid = document.getElementById("resetInvalid");
  var errorEl = document.getElementById("resetError");
  var submit = document.getElementById("resetSubmit");
  var senha = document.getElementById("resetSenha");
  var confirma = document.getElementById("resetConfirma");

  // tema escolhido no site
  var theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  page.setAttribute("data-theme", theme);
  document.querySelectorAll(".auth-card").forEach(function (card) {
    card.setAttribute("data-theme", theme);
  });

  function show(section) {
    [form, done, invalid].forEach(function (el) {
      el.hidden = el !== section;
    });
  }

  // O token vem na URL; guarda em memória e limpa a barra de endereço para
  // ele não ficar no histórico/compartilhamento de tela.
  var token = new URLSearchParams(window.location.search).get("token");
  if (window.history && history.replaceState) {
    history.replaceState(null, "", window.location.pathname);
  }

  if (!token) {
    show(invalid);
    return;
  }
  show(form);

  PasswordPolicy.attach(senha, document.getElementById("resetSenhaHint"));

  function checkConfirmation() {
    confirma.setCustomValidity(confirma.value && confirma.value !== senha.value ? "As senhas não conferem." : "");
  }
  senha.addEventListener("input", checkConfirmation);
  confirma.addEventListener("input", checkConfirmation);

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    checkConfirmation();
    errorEl.hidden = true;

    submit.disabled = true;
    submit.textContent = "Salvando...";
    try {
      await GrowAI.resetPassword(token, senha.value);
      show(done);
    } catch (err) {
      // 400 com link inválido/expirado: não adianta tentar de novo com este token
      if (err.status === 400 && /inv[aá]lido ou expirado/i.test(err.message)) {
        show(invalid);
        return;
      }
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Salvar nova senha";
    }
  });
})();
