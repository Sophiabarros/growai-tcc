(function () {
  "use strict";

  // Theme toggle, persisted across the whole site via js/theme.js.
  var page = document.getElementById("sobrePage");
  initThemeToggle({
    pageIds: ["sobrePage", "mSobrePage"],
    toggleIds: ["themeToggle", "mThemeToggle"],
    wrapperSelectors: [".sobre-wrapper", ".m-sobre-wrapper"],
  });

  // No site publicado (Vercel) chama a serverless function /api/contact do
  // próprio domínio (api/contact.js). Fora dele (localhost, Live Server, IP
  // da rede) não existe /api/contact — e o backend/ Express não roda mais na
  // porta 3000 (ver js/api.js) —, então aponta pra função já publicada, que
  // libera CORS pra essas origens. Sem isso o formulário só dava "Failed to
  // fetch" no ambiente local.
  var PRODUCTION_ORIGIN = "https://growai-xi.vercel.app";
  var isProductionHost = /\.vercel\.app$/.test(window.location.hostname) || window.location.hostname === "growai-xi.vercel.app";
  var CONTACT_ENDPOINT = (isProductionHost ? "" : PRODUCTION_ORIGIN) + "/api/contact";

  // Wires the "Contate-nos" form (desktop and mobile) to POST /api/contact,
  // which sends the message through Resend (api/contact.js).
  function wireContactForm(formId) {
    var form = document.getElementById(formId);
    if (!form) return;

    var submitBtn = form.querySelector("[type=submit]");
    var submitLabel = submitBtn.textContent;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = "Enviando...";

      try {
        var res = await fetch(CONTACT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: form.nome.value,
            email: form.email.value,
            mensagem: form.mensagem.value,
          }),
        });

        var body = await res.json().catch(function () {
          return null;
        });

        if (!res.ok) {
          throw new Error((body && body.error) || "Não foi possível enviar sua mensagem.");
        }

        showToast("Mensagem enviada! Retornaremos em breve.");
        form.reset();
      } catch (err) {
        // "Failed to fetch" / "Load failed" = sem rede ou bloqueio de CORS
        var isNetworkError = err instanceof TypeError;
        showToast(
          isNetworkError
            ? "Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente."
            : err.message || "Não foi possível enviar sua mensagem.",
          "error"
        );
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      }
    });
  }

  wireContactForm("sobreContactForm");
  wireContactForm("mSobreContactForm");

  // Scales the fixed 1440px desktop canvas down to fit tablet-width
  // viewports, same approach as js/bibliografia.js. Below the mobile
  // breakpoint, css/sobre.css's .m-sobre stacked layout takes over and
  // this scaling turns off.
  var DESIGN_WIDTH = 1440;
  var MOBILE_BREAKPOINT = 768;

  var wrapper = document.querySelector(".sobre-wrapper");
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
