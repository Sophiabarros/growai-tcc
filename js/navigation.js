(function () {
  "use strict";

  // Aparece logo depois de descer um pouco (120px). Em páginas curtas, onde 120px
  // já seria quase o fim, usa 35% da rolagem total. Se a página quase não rola
  // (menos de 40px), o botão nem faz sentido e fica escondido.
  var SHOW_AFTER_PX = 120;
  var SHOW_AFTER_RATIO = 0.35;
  var MIN_SCROLLABLE_PX = 40;
  var buttons = [];

  function wireScrollTop(id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    buttons.push(btn);
    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  // O botão é position: fixed (css/footer.css e css/responsive.css): depois de
  // aparecer, fica flutuando no canto da tela durante toda a rolagem.
  function updateVisibility() {
    var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    var threshold = Math.min(SHOW_AFTER_PX, maxScroll * SHOW_AFTER_RATIO);
    var show = maxScroll > MIN_SCROLLABLE_PX && window.scrollY > threshold;
    buttons.forEach(function (btn) {
      btn.classList.toggle("is-visible", show);
    });
  }

  wireScrollTop("scrollTop");
  wireScrollTop("mScrollTop");
  window.addEventListener("scroll", updateVisibility, { passive: true });
  window.addEventListener("resize", updateVisibility);
  window.addEventListener("load", updateVisibility);
  updateVisibility();
})();
