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

    // ---- Desempenho ----
    // O arquivo original tinha 46 MB (1080p) e era baixado por inteiro junto
    // com a página, o que travava a Game em máquinas e conexões fracas. Agora:
    //  1. o vídeo só começa a carregar depois do `load` da página;
    //  2. há 3 qualidades (720p / 480p / 360p) e a escolhida depende do
    //     aparelho, da tela e da conexão (pickTier);
    //  3. em alguns casos nem baixa: fica a foto de fundo (pickTier -> null);
    //  4. enquanto toca, vigia os quadros perdidos e, se engasgar, cai para
    //     uma qualidade menor - e, no limite, volta para a foto (watchPlayback).
    var TIERS = ["720", "480", "360"]; // do mais pesado ao mais leve
    var TIER_KEY = "tracklink_trailer_tier";
    var connection = navigator.connection || {};
    var smallScreen = window.matchMedia && window.matchMedia("(max-width: 767px)").matches;
    var reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var tier = null; // qualidade em uso; null = sem vídeo (só a foto de fundo)
    var guardTimer = null;

    // Lembra, só nesta sessão, que o vídeo engasgou (ou foi desligado), para
    // um reload não tentar de novo a qualidade que já deu problema.
    var readSavedTier = function () {
      try {
        return sessionStorage.getItem(TIER_KEY);
      } catch (e) {
        return null;
      }
    };
    var writeSavedTier = function (value) {
      try {
        sessionStorage.setItem(TIER_KEY, value);
      } catch (e) {}
    };

    // Decide se o vídeo toca e em qual qualidade (null = não toca).
    var pickTier = function () {
      if (reduceMotion && reduceMotion.matches) return null; // pediu menos movimento
      if (connection.saveData) return null; // economia de dados
      if (/2g$/.test(connection.effectiveType || "")) return null; // slow-2g / 2g

      var memory = navigator.deviceMemory; // GB aproximados (só Chromium)
      var cores = navigator.hardwareConcurrency;
      if ((memory && memory <= 2) || (cores && cores <= 2)) return null; // aparelho fraco

      var picked = smallScreen ? "480" : "720";
      if ((memory && memory <= 4) || (cores && cores <= 4) || connection.effectiveType === "3g") {
        picked = "360";
      }

      var saved = readSavedTier();
      if (saved === "off") return null;
      if (saved && TIERS.indexOf(saved) > TIERS.indexOf(picked)) picked = saved;
      return picked;
    };

    var safePlay = function () {
      if (!started) return;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    };

    // Volta para a foto de fundo: solta o vídeo (libera rede, memória e
    // decodificador) e, se estava no modo cinema, devolve o conteúdo.
    var stopTrailer = function (remember) {
      if (remember) writeSavedTier("off");
      started = false;
      tier = null;
      cinema = false;
      clearTimeout(idleTimer);
      clearInterval(guardTimer);
      body.classList.remove("is-cinema", "trailer-ready");
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (soundBtn) soundBtn.hidden = true;
    };

    // Troca para outra qualidade continuando do ponto em que estava.
    var switchTier = function (next) {
      var resumeAt = video.currentTime || 0;
      tier = next;
      writeSavedTier(next);
      video.addEventListener("loadedmetadata", function onMeta() {
        video.removeEventListener("loadedmetadata", onMeta);
        try {
          video.currentTime = resumeAt;
        } catch (e) {}
        safePlay();
      });
      video.src = video.getAttribute("data-src-" + next);
      video.load();
    };

    var degrade = function () {
      var next = TIERS[TIERS.indexOf(tier) + 1];
      if (next) {
        switchTier(next);
        watchPlayback();
      } else {
        stopTrailer(true);
      }
    };

    // Vigia o vídeo por ~50 s (o custo/engasgo aparece logo no começo): a cada
    // 2,5 s compara quadros mostrados e perdidos; 2 janelas seguidas com mais
    // de 25% perdidos = máquina não dá conta, então rebaixa a qualidade.
    var watchPlayback = function () {
      clearInterval(guardTimer);
      if (!video.getVideoPlaybackQuality) return;
      var last = video.getVideoPlaybackQuality();
      var strikes = 0;
      var rounds = 0;
      guardTimer = setInterval(function () {
        if (video.paused || document.hidden) return;
        var q = video.getVideoPlaybackQuality();
        var frames = q.totalVideoFrames - last.totalVideoFrames;
        var dropped = q.droppedVideoFrames - last.droppedVideoFrames;
        last = q;
        strikes = frames >= 20 && dropped / frames > 0.25 ? strikes + 1 : 0;
        if (strikes >= 2) degrade();
        else if (++rounds >= 20) clearInterval(guardTimer);
      }, 2500);
    };

    // Travadas de buffer ("waiting") repetidas também rebaixam a qualidade.
    var waitingAt = [];
    video.addEventListener("waiting", function () {
      if (!started) return;
      var now = Date.now();
      waitingAt = waitingAt.filter(function (t) {
        return now - t < 30000;
      });
      waitingAt.push(now);
      if (waitingAt.length >= 4) {
        waitingAt = [];
        degrade();
      }
    });

    // Se a pessoa ligar "reduzir movimento" no sistema com a página aberta, o
    // vídeo sai de cena na hora (sem gravar a escolha para a próxima visita).
    if (reduceMotion && reduceMotion.addEventListener) {
      reduceMotion.addEventListener("change", function (event) {
        if (event.matches && started) stopTrailer(false);
      });
    }

    var startTrailer = function () {
      if (started) return;
      tier = pickTier();
      if (!tier) return; // nenhum byte de vídeo é baixado: fica a foto de fundo
      started = true;
      video.src = video.getAttribute("data-src-" + tier);
      safePlay();
      resetIdle();
      watchPlayback();
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
      if (!started || cinema || document.hidden) return;
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
