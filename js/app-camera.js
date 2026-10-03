(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  // 'indefinido' = a IA nao analisou (desligada, falhou ou deu timeout). E
  // neutro: a foto esta la, so nao tem diagnostico. Sem icone de alerta.
  var HEALTH_LABEL = { saudavel: "Saudável", atencao: "Atenção", indefinido: "Sem análise" };

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (minutes < 1) return "agora mesmo";
    if (minutes < 60) return minutes + " min atrás";
    return Math.round(minutes / 60) + "h atrás";
  }

  function setStatus(el, message, isError) {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("app-camera__status--error", !!isError);
    el.classList.toggle("m-app-camera__status--error", !!isError);
  }

  function cardHtml(station, photo, checkIcon, avisoIcon, hasBullet) {
    var titleRow = hasBullet
      ? '<div class="cam-card__title-row-left"><p class="cam-card__name">' +
        escapeHtml(station.name) +
        '</p><p class="cam-card__plant">' +
        escapeHtml(station.plant) +
        "</p></div>"
      : '<p class="cam-m-card__name">' +
        escapeHtml(station.name) +
        '</p><p class="cam-m-card__plant">' +
        escapeHtml(station.plant) +
        "</p>";

    if (!photo) {
      var emptyClass = hasBullet ? "cam-card__empty" : "cam-m-card__empty";
      if (hasBullet) {
        return (
          '<div class="cam-card__body"><div class="cam-card__title-row">' +
          titleRow +
          '</div><p class="' + emptyClass + '">Nenhuma imagem registrada ainda.</p></div>'
        );
      }
      return '<div class="cam-m-card__body">' + titleRow + '<p class="' + emptyClass + '">Nenhuma imagem registrada ainda.</p></div>';
    }

    var healthClass = photo.health_status === "atencao" ? "health--warn" : "health--ok";
    var healthIcon = photo.health_status === "atencao" ? avisoIcon : checkIcon;
    var healthLabel = HEALTH_LABEL[photo.health_status] || photo.health_status;

    if (hasBullet) {
      return (
        '<img class="cam-card__photo" alt="' + escapeHtml(station.name) + '" src="' + escapeHtml(photo.image_url) + '" />' +
        '<span class="cam-card__time">' + timeAgo(photo.captured_at) + "</span>" +
        '<div class="cam-card__body">' +
        '<div class="cam-card__title-row">' + titleRow +
        '<div class="cam-card__health cam-card__' + healthClass + '"><img alt="" src="' + healthIcon + '" />' + healthLabel + "</div>" +
        "</div>" +
        '<div class="cam-card__analysis"><p class="cam-card__analysis-label">Análise visual</p><p class="cam-card__analysis-text">' +
        escapeHtml(photo.analysis_text) +
        "</p></div>" +
        '<button type="button" class="cam-card__btn">Ver histórico de imagens</button>' +
        "</div>"
      );
    }

    return (
      '<img class="cam-m-card__photo" alt="' + escapeHtml(station.name) + '" src="' + escapeHtml(photo.image_url) + '" />' +
      '<span class="cam-m-card__time">' + timeAgo(photo.captured_at) + "</span>" +
      '<div class="cam-m-card__body">' +
      titleRow +
      '<div class="cam-m-card__health cam-m-card__' + healthClass + '"><img alt="" src="' + healthIcon + '" />' + healthLabel + "</div>" +
      '<div class="cam-m-card__analysis"><p class="cam-m-card__analysis-label">Análise visual</p><p class="cam-m-card__analysis-text">' +
      escapeHtml(photo.analysis_text) +
      "</p></div>" +
      '<button type="button" class="cam-m-card__btn">Ver histórico de imagens</button>' +
      "</div>"
    );
  }

  var CHECK_ICON = "assets/icons/app/icon-app-cam-check.svg";
  var AVISO_ICON = "assets/icons/app/icon-app-cam-aviso.svg";
  var ADD_STAR_ICON = "assets/icons/app/icon-app-star-sparkle.svg";

  var grid = document.getElementById("camGrid");
  var mList = document.getElementById("camMList");

  // Card "adicionar estação": sempre o último do grid/lista. Abre o mesmo
  // modal de nova estação da página Estações (js/station-modal.js).
  var ADD_CARD_HTML =
    '<button type="button" class="cam-add-card" data-action="add-station" aria-label="Adicionar estação">' +
    '<img alt="" src="' + ADD_STAR_ICON + '" /></button>';
  var M_ADD_CARD_HTML =
    '<button type="button" class="cam-m-add-card" data-action="add-station" aria-label="Adicionar estação">' +
    '<img alt="" src="' + ADD_STAR_ICON + '" /></button>';

  // O que está na tela agora, para o visor achar a estação pelo data-idx.
  var atual = { stations: [], photos: [], cams: [] };

  // Um card por estação (desktop e mobile), mais o card de adicionar.
  function render(stations, photos, cams) {
    atual = { stations: stations, photos: photos, cams: cams || [] };
    grid.innerHTML =
      stations
        .map(function (station, i) {
          return (
            '<div class="cam-card" data-action="open-cam" data-idx="' + i + '" role="button" tabindex="0"' +
            ' aria-label="Abrir câmera de ' + escapeHtml(station.name) + '">' +
            cardHtml(station, photos[i], CHECK_ICON, AVISO_ICON, true) +
            "</div>"
          );
        })
        .join("") + ADD_CARD_HTML;
    mList.innerHTML =
      stations
        .map(function (station, i) {
          return (
            '<div class="cam-m-card" data-action="open-cam" data-idx="' + i + '" role="button" tabindex="0"' +
            ' aria-label="Abrir câmera de ' + escapeHtml(station.name) + '">' +
            cardHtml(station, photos[i], CHECK_ICON, AVISO_ICON, false) +
            "</div>"
          );
        })
        .join("") + M_ADD_CARD_HTML;
  }

  function clearCards() {
    grid.innerHTML = "";
    mList.innerHTML = "";
  }

  // A altura da lista mobile varia com o número de estações e com o texto
  // de cada análise, então a altura da página é medida depois de renderizar.
  function updateMobileTabbar() {
    positionMobileTabbar({
      mobilePageId: "mAppCameraPage",
      contentSelectors: ["#mAppCameraStatus", "#camMList"],
    });
    applyScale();
  }

  async function load() {
    var appStatus = document.getElementById("appCameraStatus");
    var mStatus = document.getElementById("mAppCameraStatus");
    setStatus(appStatus, "Carregando câmeras...", false);
    setStatus(mStatus, "Carregando câmeras...", false);

    GrowAI.syncProfile();

    var stations;
    try {
      stations = await GrowAI.getStations();
    } catch (err) {
      clearCards();
      setStatus(appStatus, err.message, true);
      setStatus(mStatus, err.message, true);
      updateMobileTabbar();
      return;
    }

    if (stations.length === 0) {
      var emptyMsg = "Você ainda não tem estações. Crie a primeira no card abaixo!";
      setStatus(appStatus, emptyMsg, false);
      setStatus(mStatus, emptyMsg, false);
      render([], [], []);
      updateMobileTabbar();
      return;
    }
    setStatus(appStatus, "", false);
    setStatus(mStatus, "", false);

    /* Foto e estado das placas, em paralelo. O estado vem de /devices, onde o
       backend já usa o prazo certo para cada tipo: a 'cam' vive em deep sleep
       e só acorda a cada 30 min, então o prazo dela é de ~95 min, não 60 s. */
    var detalhes = await Promise.all(
      stations.map(function (s) {
        return Promise.all([
          GrowAI.getLatestPhoto(s.id).catch(function () { return null; }),
          GrowAI.getDevices(s.id).catch(function () { return []; }),
        ]);
      })
    );
    var photos = detalhes.map(function (d) { return d[0]; });
    var cams = detalhes.map(function (d) {
      var lista = d[1] || [];
      for (var i = 0; i < lista.length; i++) if (lista[i].tipo === "cam") return lista[i];
      return null; // nenhuma placa cam cadastrada nesta estação
    });

    render(stations, photos, cams);
    updateMobileTabbar();
  }

  document.addEventListener("click", function (event) {
    if (!event.target.closest('[data-action="add-station"]')) return;
    StationModal.open("create", null, function () {
      return load();
    });
  });

  function wireRefresh(btnId) {
    var btn = document.getElementById(btnId);
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      await load();
      btn.disabled = false;
    });
  }
  wireRefresh("cameraRefreshBtn");
  wireRefresh("mCameraRefreshBtn");


  /* ================= VISOR DA CÂMERA =================
     Abre ao clicar num card e mostra a foto grande.

     IMPORTANTE: não é vídeo ao vivo, e não dá para ser com este hardware. A
     ESP32-CAM tira UMA foto, manda e volta para o deep sleep — ela fica
     dormindo ~29 dos 30 minutos de cada ciclo. Não existe stream para abrir.
     Por isso o visor sempre mostra a hora da captura: o usuário precisa saber
     que está vendo a última foto, não a horta neste instante. */

  var viewer = document.getElementById("camViewer");
  var viewerStage = document.getElementById("camViewerStage");
  var viewerName = document.getElementById("camViewerName");
  var viewerHealth = document.getElementById("camViewerHealth");
  var viewerMeta = document.getElementById("camViewerMeta");
  var viewerAnalysis = document.getElementById("camViewerAnalysis");
  var ultimoFoco = null;

  var OFFLINE_ICON = "assets/icons/app/icon-app-cam-aviso.svg";

  // A foto tem quantos minutos? Serve para avisar que está velha.
  function minutosDe(iso) {
    if (!iso) return null;
    return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  }

  function abrirVisor(idx) {
    var station = atual.stations[idx];
    if (!station) return;
    var photo = atual.photos[idx];
    var cam = atual.cams[idx];

    // Sem placa cadastrada e sem placa online contam como não conectada. São
    // casos diferentes, então a dica embaixo é diferente também.
    var conectada = !!(cam && cam.online);
    var temPlaca = !!cam;

    viewerName.textContent = station.name + " · " + station.plant;

    /* Sem foto nenhuma: não há o que mostrar, então o palco inteiro vira a
       mensagem. É o caso de câmera recém-instalada ou que nunca enviou. */
    if (!photo || !photo.image_url) {
      viewerStage.innerHTML =
        '<div class="cam-viewer__offline">' +
        '<img class="cam-viewer__offline-icon" alt="" src="' + OFFLINE_ICON + '" />' +
        '<p class="cam-viewer__offline-title">Câmera não conectada</p>' +
        '<p class="cam-viewer__offline-hint">' +
        (temPlaca
          ? "A placa está cadastrada, mas ainda não enviou nenhuma foto. Confira a alimentação e o Wi-Fi 2,4 GHz dela."
          : "Nenhuma ESP32-CAM foi cadastrada nesta estação ainda.") +
        "</p></div>";
      viewerHealth.textContent = "";
      viewerHealth.classList.remove("cam-viewer__health--warn");
      viewerMeta.textContent = temPlaca ? "Nenhuma imagem recebida." : "Sem câmera nesta estação.";
      viewerAnalysis.textContent = "";
    } else {
      /* Tem foto. Mesmo com a placa offline a foto é mostrada — ela é o último
         retrato real da planta, e esconder isso só tiraria informação. O aviso
         por cima deixa claro que é antiga. */
      var min = minutosDe(photo.captured_at);
      var html =
        '<img alt="Última foto de ' + escapeHtml(station.name) + '" src="' + escapeHtml(photo.image_url) + '" />';
      if (!conectada) {
        html +=
          '<p class="cam-viewer__stale">Câmera não conectada — esta é a última imagem recebida' +
          (min !== null ? " (" + timeAgo(photo.captured_at) + ")" : "") +
          ".</p>";
      }
      viewerStage.innerHTML = html;

      var st = photo.health_status;
      viewerHealth.innerHTML =
        '<img alt="" src="' + (st === "atencao" ? AVISO_ICON : CHECK_ICON) + '" />' +
        (HEALTH_LABEL[st] || st);
      viewerHealth.classList.toggle("cam-viewer__health--warn", st === "atencao");

      viewerMeta.textContent =
        "Foto de " + timeAgo(photo.captured_at) +
        (conectada ? " · câmera conectada" : " · câmera não conectada");
      viewerAnalysis.textContent = photo.analysis_text || "";
    }

    ultimoFoco = document.activeElement;
    viewer.hidden = false;
    viewer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Força um frame antes de animar, senão a transição não roda.
    requestAnimationFrame(function () {
      viewer.classList.add("cam-viewer--open");
    });
    document.getElementById("camViewerClose").focus();
  }

  function fecharVisor() {
    if (viewer.hidden) return;
    viewer.classList.remove("cam-viewer--open");
    viewer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    // Espera a animação de saída antes de esconder de verdade.
    setTimeout(function () {
      viewer.hidden = true;
      viewerStage.innerHTML = ""; // solta a data URL da memória
    }, 180);
    if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
    ultimoFoco = null;
  }

  document.getElementById("camViewerClose").addEventListener("click", fecharVisor);

  document.addEventListener("click", function (event) {
    if (event.target.closest('[data-action="close-cam"]')) {
      fecharVisor();
      return;
    }
    var card = event.target.closest('[data-action="open-cam"]');
    if (card) abrirVisor(Number(card.dataset.idx));
  });

  // Teclado: Enter/Espaço abre o card (ele é role="button"), Esc fecha o visor.
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      fecharVisor();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    var card = event.target.closest && event.target.closest('[data-action="open-cam"]');
    if (!card) return;
    event.preventDefault();
    abrirVisor(Number(card.dataset.idx));
  });

  // ---- canvas scaling ----
  var applyScale = initResponsiveCanvas({
    desktopPageId: "appCameraPage",
    desktopWrapperSelector: ".app-camera-wrapper",
    mobilePageId: "mAppCameraPage",
    mobileWrapperSelector: ".m-app-camera-wrapper",
  });

  load();
})();
