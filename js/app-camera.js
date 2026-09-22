(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  var HEALTH_LABEL = { saudavel: "Saudável", atencao: "Atenção" };

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

  // Um card por estação (desktop e mobile), mais o card de adicionar.
  function render(stations, photos) {
    grid.innerHTML =
      stations
        .map(function (station, i) {
          return '<div class="cam-card">' + cardHtml(station, photos[i], CHECK_ICON, AVISO_ICON, true) + "</div>";
        })
        .join("") + ADD_CARD_HTML;
    mList.innerHTML =
      stations
        .map(function (station, i) {
          return '<div class="cam-m-card">' + cardHtml(station, photos[i], CHECK_ICON, AVISO_ICON, false) + "</div>";
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
      render([], []);
      updateMobileTabbar();
      return;
    }
    setStatus(appStatus, "", false);
    setStatus(mStatus, "", false);

    var photos = await Promise.all(
      stations.map(function (s) {
        return GrowAI.getLatestPhoto(s.id).catch(function () {
          return null;
        });
      })
    );

    render(stations, photos);
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

  // ---- canvas scaling ----
  var applyScale = initResponsiveCanvas({
    desktopPageId: "appCameraPage",
    desktopWrapperSelector: ".app-camera-wrapper",
    mobilePageId: "mAppCameraPage",
    mobileWrapperSelector: ".m-app-camera-wrapper",
  });

  load();
})();
