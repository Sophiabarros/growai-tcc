(function () {
  "use strict";

  // Modal "Esqueceu a senha?" da página de login (desktop e mobile).
  //
  // Pede o e-mail, chama POST /api/auth/forgot-password (GrowAI.forgotPassword)
  // e mostra a confirmação. Por segurança o backend responde sempre a mesma
  // coisa, exista ou não uma conta com aquele e-mail - então a mensagem aqui
  // também é neutra ("se estiver cadastrado, enviaremos...").
  //
  // Os links "Esqueceu a senha?" (.login-form__forgot e .m-login-forgot)
  // abrem este modal. O markup é injetado uma única vez, na primeira abertura.

  var MARKUP =
    '<div class="auth-modal" id="forgotModal" role="dialog" aria-modal="true" aria-labelledby="forgotTitle">' +
    '  <div class="auth-modal__backdrop" data-close></div>' +
    '  <form class="auth-card" id="forgotForm" novalidate>' +
    '    <h2 class="auth-card__title" id="forgotTitle">Esqueceu a senha?</h2>' +
    '    <p class="auth-card__text" id="forgotText">Informe o e-mail da sua conta. Enviaremos um link para você criar uma nova senha.</p>' +
    '    <div class="auth-card__field" id="forgotField">' +
    '      <label for="forgotEmail">E-mail</label>' +
    '      <input type="email" id="forgotEmail" name="email" placeholder="Digite seu e-mail..." autocomplete="email" required />' +
    "    </div>" +
    '    <p class="auth-card__error" id="forgotError" role="alert" hidden></p>' +
    '    <p class="auth-card__success" id="forgotSuccess" role="status" hidden></p>' +
    '    <div class="auth-card__actions">' +
    '      <button type="button" class="auth-card__btn" data-close id="forgotCancel">Cancelar</button>' +
    '      <button type="submit" class="auth-card__btn auth-card__btn--primary" id="forgotSubmit">Enviar link</button>' +
    "    </div>" +
    "  </form>" +
    "</div>";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var modal = null;
  var form = null;
  var lastFocus = null;

  function $(id) {
    return document.getElementById(id);
  }

  function ensureModal() {
    if (modal) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    modal = $("forgotModal");
    form = $("forgotForm");

    modal.addEventListener("click", function (event) {
      if (event.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && modal.classList.contains("is-open")) close();
    });
    form.addEventListener("submit", onSubmit);
  }

  function open(prefillEmail) {
    ensureModal();
    lastFocus = document.activeElement;

    // usa o mesmo tema (claro/escuro) da página de login
    var themed = document.querySelector("[data-theme]");
    form.setAttribute("data-theme", themed ? themed.getAttribute("data-theme") : "dark");

    form.reset();
    $("forgotEmail").value = prefillEmail || "";
    $("forgotError").hidden = true;
    $("forgotSuccess").hidden = true;
    $("forgotField").hidden = false;
    $("forgotText").hidden = false;
    $("forgotSubmit").hidden = false;
    $("forgotSubmit").disabled = false;
    $("forgotSubmit").textContent = "Enviar link";
    $("forgotCancel").textContent = "Cancelar";

    modal.classList.add("is-open");
    window.setTimeout(function () {
      $("forgotEmail").focus();
    }, 50);
  }

  function close() {
    modal.classList.remove("is-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function onSubmit(event) {
    event.preventDefault();
    var errorEl = $("forgotError");
    var submit = $("forgotSubmit");
    var email = $("forgotEmail").value.trim();

    errorEl.hidden = true;
    if (!EMAIL_RE.test(email)) {
      errorEl.textContent = "Informe um e-mail válido.";
      errorEl.hidden = false;
      $("forgotEmail").focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = "Enviando...";
    try {
      var data = await GrowAI.forgotPassword(email);
      // troca o formulário pela confirmação
      $("forgotField").hidden = true;
      $("forgotText").hidden = true;
      submit.hidden = true;
      $("forgotCancel").textContent = "Fechar";
      var success = $("forgotSuccess");
      success.textContent =
        ((data && data.message) || "Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha.") +
        " O link vale por 30 minutos; confira também a caixa de spam.";
      success.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Enviar link";
    }
  }

  function currentEmail(link) {
    var scope = link.closest("form");
    var input = scope && scope.querySelector('input[type="email"]');
    return input ? input.value.trim() : "";
  }

  var links = document.querySelectorAll(".login-form__forgot, .m-login-forgot");
  links.forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      open(currentEmail(link));
    });
  });

  // login.html#esqueci-senha abre o modal direto (usado pelo botão "Solicitar
  // novo link" de redefinir-senha.html quando o link do e-mail expirou).
  if (window.location.hash === "#esqueci-senha") {
    var visible = Array.prototype.filter.call(links, function (l) {
      return l.offsetParent !== null;
    })[0];
    open(visible ? currentEmail(visible) : "");
  }
})();
