(function () {
  "use strict";

  // Menu hamburguer. Na versao mobile o .is-open (painel) e o .is-menu-open no
  // header (fundo escurecido) sao animados por css/responsive.css. Fecha ao
  // escolher um link, tocar fora do menu ou apertar Esc.
  function wireMenu(toggleId, navId) {
    var toggle = document.getElementById(toggleId);
    var nav = document.getElementById(navId);
    if (!toggle || !nav) return;
    var header = nav.closest(".m-header");

    function setOpen(open) {
      nav.classList.toggle("is-open", open);
      if (header) header.classList.toggle("is-menu-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
    }

    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("is-open"));
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        setOpen(false);
      });
    });

    document.addEventListener("click", function (event) {
      if (!nav.classList.contains("is-open")) return;
      if (nav.contains(event.target) || toggle.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  wireMenu("menuToggle", "headerNav");
  wireMenu("mMenuToggle", "mHeaderNav");
})();
