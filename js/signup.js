(function () {
  "use strict";

  // Theme toggle, persisted across the whole site via js/theme.js.
  var page = document.getElementById("signupPage");
  initThemeToggle({
    pageIds: ["signupPage", "mSignupPage"],
    toggleIds: ["themeToggle", "mThemeToggle"],
    wrapperSelectors: [".signup-wrapper", ".m-signup-wrapper"],
  });

  // Wires both the desktop and mobile forms to the GrowAI API (js/api.js).
  // The backend only stores a single "name" field, so nome+sobrenome are
  // joined before sending.
  function wireSignupForm(formId, errorId) {
    var form = document.getElementById(formId);
    var errorEl = document.getElementById(errorId);
    var submitBtn = form.querySelector("[type=submit]");
    var submitLabel = submitBtn.textContent;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      errorEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Criando conta...";

      var fullName = (form.nome.value + " " + form.sobrenome.value).trim();

      try {
        await GrowAI.register(fullName, form.email.value, form.senha.value);
        window.location.href = "app-home.html";
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      }
    });
  }

  wireSignupForm("signupForm", "signupError");
  wireSignupForm("mSignupForm", "mSignupError");

  // Regras da senha (mín. 8 caracteres + 1 caractere especial): lista de
  // requisitos que acende enquanto a pessoa digita e bloqueia o envio até a
  // senha valer (js/password-policy.js). O backend valida de novo.
  PasswordPolicy.attach(document.getElementById("signupSenha"), document.getElementById("signupSenhaHint"));
  PasswordPolicy.attach(document.getElementById("mSignupSenha"), document.getElementById("mSignupSenhaHint"));

  // Scales the fixed 1440px desktop canvas down to fit tablet-width
  // viewports, same approach as js/sistema.js.
  var DESIGN_WIDTH = 1440;
  var MOBILE_BREAKPOINT = 768;

  var wrapper = document.querySelector(".signup-wrapper");
  var naturalHeight = page.scrollHeight;

  function applyScale() {
    var width = window.innerWidth;

    if (width >= DESIGN_WIDTH || width < MOBILE_BREAKPOINT) {
      page.style.transform = "";
      wrapper.style.height = "";
      return;
    }

    var scale = width / DESIGN_WIDTH;
    page.style.transform = "scale(" + scale + ")";
    wrapper.style.height = Math.round(naturalHeight * scale) + "px";
  }

  window.addEventListener("resize", applyScale);
  applyScale();
})();
