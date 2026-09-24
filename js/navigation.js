(function () {
  "use strict";

  var SHOW_AFTER_PX = 300;
  var buttons = [];

  function wireScrollTop(id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    buttons.push(btn);
    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  // O botao e position: fixed (css/footer.css e css/responsive.css); fica
  // escondido no topo e aparece depois de rolar um pouco.
  function updateVisibility() {
    var show = window.scrollY > SHOW_AFTER_PX;
    buttons.forEach(function (btn) {
      btn.classList.toggle("is-visible", show);
    });
  }

  wireScrollTop("scrollTop");
  wireScrollTop("mScrollTop");
  window.addEventListener("scroll", updateVisibility, { passive: true });
  updateVisibility();
})();
