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
    var lastIdleReset = 0;
    var cinema = false;
    var started = false;

    // Desempenho: o arquivo original tinha 46 MB (1080p, 4 Mbps) e era
    // baixado por inteiro (`preload="auto"`) junto com o resto da página, o
    // que travava a Game. Agora são versões H.264 leves (720p ≈ 6,6 MB, 480p
    // ≈ 3,2 MB) e o vídeo só começa a carregar depois do `load` da página.
    // Com "economia de dados" ligada nem baixa: fica a foto de fundo.
    var connection = navigator.connection || {};
    var smallScreen = window.matchMedia && window.matchMedia("(max-width: 767px)").matches;

    var safePlay = function () {
      if (!started) return;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    };

    var startTrailer = function () {
      if (started || connection.saveData) return;
      started = true;
      video.src = smallScreen ? video.getAttribute("data-src-mobile") : video.getAttribute("data-src-desktop");
      safePlay();
      resetIdle();
    };

    var syncSoundButton = function () {
      if (soundBtn) soundBtn.hidden = !(cinema && video.muted);
    };

    var enterCinema = function () {
      cinema = true;
      moveOrigin = null;
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

    // Qualquer interação (clique, tecla, scroll, toque ou o mouse andando de
    // verdade) durante o cinema interrompe o trailer e traz o conteúdo de
    // volta, pra ninguém ficar preso na tela. O clique no "Ativar som" não
    // conta, senão não haveria como ligar o som.
    var MOVE_TOLERANCE = 24; // px que o mouse precisa andar (evita tremida da mesa)
    var moveOrigin = null;

    var onActivity = function (e) {
      if (!cinema) {
        // mousemove/wheel/scroll disparam dezenas de vezes por segundo: não
        // precisa rearmar o timer de 20s a cada evento
        var now = Date.now();
        if (now - lastIdleReset > 400) {
          lastIdleReset = now;
          resetIdle();
        }
        return;
      }
      if (e && e.target && soundBtn && soundBtn.contains(e.target)) return;
      if (e && e.type === "mousemove") {
        if (!moveOrigin) {
          moveOrigin = { x: e.clientX, y: e.clientY };
          return;
        }
        if (Math.hypot(e.clientX - moveOrigin.x, e.clientY - moveOrigin.y) < MOVE_TOLERANCE) return;
      }
      moveOrigin = null;
      exitCinema();
    };

    ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "pointerdown"].forEach(function (ev) {
      window.addEventListener(ev, onActivity, { passive: true });
    });
    document.addEventListener("scroll", onActivity, { passive: true, capture: true });
    // aba em segundo plano: pausa o vídeo (não gasta CPU/GPU/bateria à toa)
    // e retoma quando ela volta
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearTimeout(idleTimer);
        if (started) video.pause();
      } else {
        safePlay();
        resetIdle();
      }
    });

    if (document.readyState === "complete") startTrailer();
    else window.addEventListener("load", startTrailer, { once: true });
  }
})();
