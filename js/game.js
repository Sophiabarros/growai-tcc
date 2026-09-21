(function () {
  "use strict";

  // Theme toggle, persisted across the whole site via js/theme.js. The
  // Game page itself has no light-mode design in Figma, so this mostly
  // just keeps the toggle button icon and stored preference consistent
  // with whatever the user picked on another page.
  var page = document.getElementById("gamePage");
  initThemeToggle({
    pageIds: ["gamePage", "mGamePage"],
    toggleIds: ["themeToggle", "mThemeToggle"],
  });

  // Escala o canvas fixo de 1440px pra acompanhar a largura da janela: a
  // foto e a página crescem quando a tela é maior que 1440 e encolhem
  // quando é menor. Abaixo do breakpoint mobile, o layout .m-game do
  // css/game.css assume e a escala desliga.
  var DESIGN_WIDTH = 1440;
  var MOBILE_BREAKPOINT = 768;

  var wrapper = document.querySelector(".game-wrapper");
  var naturalHeight = page.scrollHeight;

  function applyScale() {
    var width = window.innerWidth;

    if (width < MOBILE_BREAKPOINT) {
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

  // ---- Trailer de fundo ----
  // Fase "fundo": vídeo mudo e escurecido atrás da página (o escurecimento é
  // a camada .game-trailer__shade). Depois de IDLE_MS sem nenhuma interação
  // entra a fase "cinema" (body.is-cinema): o conteúdo dissolve, a camada
  // escura some e o trailer passa do começo, com som se o navegador deixar.
  // Quando o trailer termina, o conteúdo volta com a mesma transição e o
  // vídeo recomeça mudo no fundo. Se o vídeo não carregar/tocar, nada disso
  // dispara e a página continua com a foto de fundo normal.
  var IDLE_MS = 20000;
  var video = document.getElementById("gameTrailer");
  var soundBtn = document.getElementById("gameTrailerSound");

  if (video) {
    var body = document.body;
    var idleTimer = null;
    var cinema = false;

    var safePlay = function () {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    };

    var syncSoundButton = function () {
      if (soundBtn) soundBtn.hidden = !(cinema && video.muted);
    };

    var enterCinema = function () {
      cinema = true;
      body.classList.add("is-cinema");
      video.currentTime = 0;
      video.muted = false;
      var p = video.play();
      if (p && p.catch) {
        p.catch(function () {
          // sem interação prévia o navegador barra o som (e pausa o vídeo):
          // segue mudo e deixa o botão "Ativar som" à mostra
          video.muted = true;
          safePlay();
        }).then(syncSoundButton);
      }
      syncSoundButton();
    };

    var exitCinema = function () {
      cinema = false;
      body.classList.remove("is-cinema");
      video.muted = true;
      video.currentTime = 0;
      safePlay();
      syncSoundButton();
      resetIdle();
    };

    var resetIdle = function () {
      clearTimeout(idleTimer);
      if (cinema || document.hidden) return;
      if (video.paused) safePlay(); // ex.: economia de bateria pausou o fundo
      idleTimer = setTimeout(function () {
        if (body.classList.contains("trailer-ready")) enterCinema();
        else resetIdle();
      }, IDLE_MS);
    };

    // só troca a foto pelo vídeo quando ele realmente começou a tocar
    video.addEventListener("playing", function () {
      body.classList.add("trailer-ready");
    });
    video.addEventListener("volumechange", syncSoundButton);
    video.addEventListener("ended", function () {
      if (cinema) exitCinema();
      else {
        video.currentTime = 0; // fundo em loop enquanto o conteúdo está visível
        safePlay();
      }
    });

    if (soundBtn) {
      soundBtn.addEventListener("click", function () {
        video.muted = false;
        safePlay();
        syncSoundButton();
      });
    }

    ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "pointerdown"].forEach(function (ev) {
      window.addEventListener(ev, resetIdle, { passive: true });
    });
    document.addEventListener("scroll", resetIdle, { passive: true, capture: true });
    document.addEventListener("visibilitychange", resetIdle);

    safePlay();
    resetIdle();
  }
})();
