(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  var STATION_ICON = "assets/icons/app/icon-app-planta-station.svg";
  var EDIT_ICON = "assets/icons/app/icon-app-editar.svg";
  var DELETE_ICON = "assets/icons/app/icon-app-excluir.svg";
  var ADD_ICON = "assets/icons/app/icon-app-add.svg";

  var appGrid = document.getElementById("appEstacoesGrid");
  var appStatus = document.getElementById("appEstacoesStatus");
  var mList = document.getElementById("mAppEstacoesList");
  var mStatus = document.getElementById("mAppEstacoesStatus");
  var insights = document.getElementById("appInsights");
  var insightsList = document.getElementById("appInsightsList");
  var mPage = document.getElementById("mAppEstacoesPage");

  var newStationBtn = document.getElementById("newStationBtn");

  var stations = [];

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function statRow(label, value) {
    return (
      '<div class="est-card__stat"><p class="est-card__stat-label">' +
      label +
      '</p><p class="est-card__stat-value">' +
      escapeHtml(value) +
      "</p></div>"
    );
  }

  function desktopCardHtml(s) {
    return (
      '<div class="est-card" data-station-id="' +
      s.id +
      '">' +
      '<div class="est-card__top">' +
      '<div class="est-card__icon"><img alt="" src="' +
      STATION_ICON +
      '" /></div>' +
      '<button type="button" class="est-card__edit" data-action="edit"><img alt="Editar" src="' +
      EDIT_ICON +
      '" /></button>' +
      '<button type="button" class="est-card__delete" data-action="delete"><img alt="Excluir" src="' +
      DELETE_ICON +
      '" /></button>' +
      '<p class="est-card__name" title="' +
      escapeHtml(s.name) +
      '">' +
      escapeHtml(s.name) +
      "</p>" +
      '<p class="est-card__plant">' +
      escapeHtml(s.plant) +
      "</p>" +
      (s.tag ? '<p class="est-card__tag">' + escapeHtml(s.tag) + "</p>" : "") +
      "</div>" +
      '<div class="est-card__stats">' +
      statRow("Rega a cada", s.water_interval_h + "h") +
      statRow("Luz diária", s.light_hours + "h") +
      statRow("Umidade alvo", s.humidity_target + "%") +
      statRow("pH alvo", s.ph_target) +
      "</div>" +
      '<button type="button" class="est-card__btn" data-action="edit">Configurar rotina</button>' +
      "</div>"
    );
  }

  function mStatRow(label, value) {
    return (
      '<div class="m-est-card__stat"><p class="m-est-card__stat-label">' +
      label +
      '</p><p class="m-est-card__stat-value">' +
      escapeHtml(value) +
      "</p></div>"
    );
  }

  function mobileCardHtml(s) {
    return (
      '<div class="m-est-card" data-station-id="' +
      s.id +
      '">' +
      '<div class="m-est-card__top">' +
      '<div class="m-est-card__icon"><img alt="" src="' +
      STATION_ICON +
      '" /></div>' +
      '<button type="button" class="m-est-card__edit" data-action="edit"><img alt="Editar" src="' +
      EDIT_ICON +
      '" /></button>' +
      '<button type="button" class="m-est-card__delete" data-action="delete"><img alt="Excluir" src="' +
      DELETE_ICON +
      '" /></button>' +
      '<p class="m-est-card__name" title="' +
      escapeHtml(s.name) +
      '">' +
      escapeHtml(s.name) +
      "</p>" +
      '<p class="m-est-card__plant">' +
      escapeHtml(s.plant) +
      "</p>" +
      (s.tag ? '<p class="m-est-card__tag">' + escapeHtml(s.tag) + "</p>" : "") +
      "</div>" +
      '<div class="m-est-card__stats">' +
      mStatRow("Rega a cada", s.water_interval_h + "h") +
      mStatRow("Luz diária", s.light_hours + "h") +
      mStatRow("Umidade alvo", s.humidity_target + "%") +
      mStatRow("pH alvo", s.ph_target) +
      "</div>" +
      '<button type="button" class="m-est-card__btn" data-action="edit">Configurar rotina</button>' +
      "</div>"
    );
  }

  var ADD_TILE_HTML =
    '<button type="button" class="m-est-add-card" id="mNewStationBtn" aria-label="Nova estação">' +
    '<img alt="" src="' +
    ADD_ICON +
    '" />' +
    "</button>";

  // "Insights de Saúde" — real data only: a photo the backend flagged
  // "atencao" (with its analysis_text explaining what's wrong). No fake
  // fallback card, and the whole block stays out of the DOM flow (hidden,
  // not an empty placeholder) when nothing needs attention.
  function insightCardHtml(insight) {
    return (
      '<div class="app-insights__card">' +
      '<img alt="" src="assets/icons/app/icon-app-insights-warn.svg" />' +
      "<div>" +
      '<p class="app-insights__headline">' + escapeHtml(insight.headline) + "</p>" +
      '<p class="app-insights__desc">' + escapeHtml(insight.desc) + "</p>" +
      "</div></div>"
    );
  }
  function renderInsights(list) {
    if (!insights || !insightsList) return;
    if (!list.length) {
      insights.hidden = true;
      insightsList.innerHTML = "";
      return;
    }
    insights.hidden = false;
    insightsList.innerHTML = list.map(insightCardHtml).join("");
  }
  async function loadInsights() {
    var photos = await Promise.all(
      stations.map(function (s) {
        return GrowAI.getLatestPhoto(s.id).catch(function () {
          return null;
        });
      })
    );
    var list = [];
    stations.forEach(function (s, i) {
      var photo = photos[i];
      if (photo && photo.health_status === "atencao") {
        list.push({ headline: s.name + " precisa de atenção", desc: photo.analysis_text });
      }
    });
    renderInsights(list.slice(0, 4));
  }

  function setStatus(el, message, isError) {
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("app-estacoes__status--error", !!isError);
    el.classList.toggle("m-app-estacoes__status--error", !!isError);
  }

  function findStation(id) {
    return stations.filter(function (s) {
      return String(s.id) === String(id);
    })[0];
  }

  function render() {
    if (stations.length === 0) {
      setStatus(appStatus, "Você ainda não tem estações. Crie a primeira!", false);
      setStatus(mStatus, "Você ainda não tem estações. Crie a primeira!", false);
      appGrid.innerHTML = "";
      mList.innerHTML = ADD_TILE_HTML;
    } else {
      setStatus(appStatus, "", false);
      setStatus(mStatus, "", false);
      appGrid.innerHTML = stations.map(desktopCardHtml).join("");
      mList.innerHTML = stations.map(mobileCardHtml).join("") + ADD_TILE_HTML;
    }

    document.getElementById("mNewStationBtn").addEventListener("click", function () {
      openModal("create");
    });

    positionDependents();
    applyScale();
  }

  // Everything below the (variable-height) station grid/list has its
  // position recomputed after each render instead of relying on the
  // fixed Figma coordinates, which only account for exactly two cards. The
  // mobile tab bar itself is `position:fixed` (css/app-shell.css) and no
  // longer part of this — .m-app-estacoes's own `padding-bottom` reserves
  // its footprint instead.
  function positionDependents() {
    if (insights) {
      var gridBottomPx = appGrid.offsetTop + appGrid.offsetHeight;
      insights.style.top = gridBottomPx / 10 + 5.5 + "rem";
    }
    if (mPage) {
      var listBottomPx = mList.offsetTop + mList.offsetHeight;
      mPage.style.minHeight = listBottomPx / 10 + 1.2 + "rem";
    }
  }

  async function load() {
    setStatus(appStatus, "Carregando estações...", false);
    setStatus(mStatus, "Carregando estações...", false);
    try {
      stations = await GrowAI.getStations();
      render();
    } catch (err) {
      setStatus(appStatus, err.message, true);
      setStatus(mStatus, err.message, true);
      renderInsights([]);
      return;
    }
    loadInsights();
  }

  // ---- modal (js/station-modal.js, compartilhado com a página Câmera) ----
  function openModal(mode, station) {
    StationModal.open(mode, station, function (saved, savedMode) {
      if (savedMode === "edit") {
        stations = stations.map(function (s) {
          return s.id === saved.id ? saved : s;
        });
      } else {
        stations = stations.concat([saved]);
      }
      render();
      loadInsights();
    });
  }

  document.addEventListener("click", async function (event) {
    var target = event.target.closest("[data-action]");
    if (!target) return;

    if (target.dataset.action === "edit") {
      var card = target.closest("[data-station-id]");
      var station = card && findStation(card.dataset.stationId);
      if (station) openModal("edit", station);
      return;
    }
    if (target.dataset.action === "delete") {
      var delCard = target.closest("[data-station-id]");
      var delStation = delCard && findStation(delCard.dataset.stationId);
      if (!delStation) return;

      var confirmed = await showConfirm(
        'Excluir "' + delStation.name + '" (' + delStation.plant + ')? Essa ação não pode ser desfeita.',
        { confirmLabel: "Excluir" }
      );
      if (!confirmed) return;

      target.disabled = true;
      try {
        await GrowAI.deleteStation(delStation.id);
        stations = stations.filter(function (s) {
          return s.id !== delStation.id;
        });
        render();
        loadInsights();
      } catch (err) {
        target.disabled = false;
        showToast(err.message, "error");
      }
    }
  });

  newStationBtn.addEventListener("click", function () {
    openModal("create");
  });

  // ---- canvas scaling (recomputed on every render since content height
  // now varies with the station count) ----
  var applyScale = initResponsiveCanvas({
    desktopPageId: "appEstacoesPage",
    desktopWrapperSelector: ".app-estacoes-wrapper",
    mobilePageId: "mAppEstacoesPage",
    mobileWrapperSelector: ".m-app-estacoes-wrapper",
  });

  load();
})();
