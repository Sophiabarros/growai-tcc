(function () {
  "use strict";

  // Tema claro/escuro, compartilhado com o resto do site (js/theme.js). O
  // #jogarRoot envolve a página toda, então as variáveis --dm-* do tema
  // escolhido valem para o header, o palco e os avisos.
  initThemeToggle({
    pageIds: ["jogarRoot"],
    toggleIds: ["themeToggle", "mThemeToggle"],
  });

  var DESIGN_WIDTH = 1440;
  var MOBILE_BREAKPOINT = 768;
  var FIT_MARGIN = 16; // respiro acima e abaixo do card quando ele está centralizado na tela, em px
  var MIN_STAGE_W = 480; // em telas muito baixas o palco não encolhe mais que isso
  var MAX_STAGE_W = 1600; // em monitores enormes o palco para de crescer aqui

  var root = document.getElementById("jogarRoot");
  var head = document.getElementById("jogarHead");
  var main = document.getElementById("jogarMain");
  var card = document.querySelector(".jogar-card");
  var screen = document.querySelector(".jogar-stage__screen");

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // ---- Header + tamanho do palco ----
  // Header: mesma lógica do js/game.js - o canvas de 1440px acompanha a
  // largura da janela (cresce e encolhe). Palco: o maior 16:9 que cabe na
  // altura da tela (com o card centralizado nela).
  function layout() {
    if (fullscreenElement()) return; // em tela cheia o CSS cuida do tamanho
    var width = window.innerWidth;

    if (width < MOBILE_BREAKPOINT) {
      head.style.transform = "";
      root.style.removeProperty("--jogar-head-h");
      root.style.removeProperty("--jogar-stage-w");
    } else {
      var designWidth = head.offsetWidth || DESIGN_WIDTH;
      var scale = width / designWidth;
      head.style.transform = "scale(" + scale + ")";
      root.style.setProperty("--jogar-head-h", Math.round(head.offsetHeight * scale) + "px");

      // O palco usa a largura toda do conteúdo, desde que o card inteiro
      // (palco + barrinha) caiba na altura da tela. Ao iniciar o jogo a
      // página rola até o card, e aí o jogo fica todo à vista.
      var screenRect = screen.getBoundingClientRect();
      var cardExtraW = card.offsetWidth - screenRect.width;
      var cardExtraH = card.offsetHeight - screenRect.height;
      var styles = getComputedStyle(main);
      var maxW = main.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - cardExtraW;
      var fitW = ((window.innerHeight - cardExtraH - 2 * FIT_MARGIN) * 16) / 9;
      var stageW = Math.max(Math.min(MIN_STAGE_W, maxW), Math.min(maxW, fitW, MAX_STAGE_W));
      root.style.setProperty("--jogar-stage-w", Math.floor(stageW) + "px");
    }

    // a faixa curva do topo termina mais ou menos no meio do palco
    var rect = screen.getBoundingClientRect();
    root.style.setProperty(
      "--jogar-band-h",
      Math.round(rect.top + window.scrollY + rect.height * 0.45) + "px"
    );
  }

  window.addEventListener("resize", layout);
  layout();
  // a fonte (Lexend / Syne Mono) chega depois: recalcula quando carregar
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(layout);
  }

  // ---- Iniciar o jogo ----
  // O iframe só ganha o src no clique: os ~54 MB do jogo não pesam na
  // abertura da página, e o clique libera o áudio do jogo.
  var stage = document.getElementById("jogarStage");
  var frame = document.getElementById("jogarFrame");
  var cover = document.getElementById("jogarCover");
  var playBtn = document.getElementById("jogarPlay");
  var playText = document.getElementById("jogarPlayText");

  playBtn.addEventListener("click", function () {
    if (frame.getAttribute("src")) return;
    playBtn.disabled = true;
    playText.textContent = "Carregando…";
    frame.addEventListener(
      "load",
      function () {
        cover.hidden = true;
        stage.classList.add("is-playing");
        try {
          frame.focus();
        } catch (e) {}
      },
      { once: true }
    );
    frame.src = frame.getAttribute("data-src");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ---- Tela cheia ----
  var fsBtn = document.getElementById("jogarFs");
  var fsText = document.getElementById("jogarFsText");
  var fsHint = document.getElementById("jogarFsHint");
  var hintTimer = null;

  fsBtn.addEventListener("click", function () {
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      var req = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (req) req.call(stage);
    }
  });

  function onFullscreenChange() {
    var on = fullscreenElement() === stage;
    stage.classList.toggle("is-fullscreen", on);
    fsText.textContent = on ? "Sair da tela cheia" : "Tela cheia";
    clearTimeout(hintTimer);
    fsHint.classList.toggle("is-visible", on);
    if (on) {
      hintTimer = setTimeout(function () {
        fsHint.classList.remove("is-visible");
      }, 3000);
      try {
        frame.focus();
      } catch (e) {}
    } else {
      layout();
    }
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
})();
