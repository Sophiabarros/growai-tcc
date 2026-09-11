(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  var HEALTH_LABEL = { saudavel: "boa", atencao: "média" };
  var HEALTH_ICON = {
    saudavel: "assets/icons/app/icon-app-check.svg",
    atencao: "assets/icons/app/icon-app-warning.svg",
  };

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function setStatus(el, message, isError) {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("app-home__status--error", !!isError);
    el.classList.toggle("m-app-home__status--error", !!isError);
  }

  function firstName(name) {
    if (!name) return "";
    return String(name).trim().split(/\s+/)[0];
  }

  function stationLocation(station) {
    if (!station) return "";
    return station.tag ? station.name + " · " + station.tag : station.name;
  }

  // ---- desktop: greeting ----
  function renderGreeting() {
    var el = document.getElementById("appGreetingTitle");
    if (!el) return;
    var user = GrowAI.getUser();
    var name = firstName(user && user.name);
    el.textContent = name ? "Olá, " + name : "Olá!";
  }

  // ---- desktop: "Suas plantas" list ----
  function renderPlantsList(stations) {
    var list = document.getElementById("appPlantsList");
    if (!list) return;
    if (!stations.length) {
      list.innerHTML = '<p class="app-plants__empty">Nenhuma estação cadastrada ainda.</p>';
      return;
    }
    list.innerHTML = stations
      .map(function (s, i) {
        var photo = s.__photo && s.__photo.image_url;
        var img = photo
          ? '<img class="app-plant-row__photo" alt="' + escapeHtml(s.plant) + '" src="' + escapeHtml(photo) + '" />'
          : '<img class="app-plant-row__photo" alt="" src="assets/icons/app/icon-app-planta-station.svg" style="padding: 1rem; box-sizing: border-box; object-fit: contain;" />';
        return (
          '<a href="app-estacoes.html" class="app-plant-row' + (i === 0 ? " app-plant-row--active" : "") + '">' +
          img +
          '<span class="app-plant-row__info">' +
          '<p class="app-plant-row__name">' + escapeHtml(s.plant) + "</p>" +
          '<p class="app-plant-row__loc">' + escapeHtml(stationLocation(s)) + "</p>" +
          "</span>" +
          '<span class="app-plant-row__dot"></span>' +
          "</a>"
        );
      })
      .join("");
  }

  // ---- desktop: featured card (first station) ----
  function renderFeatured(station, reading, photo) {
    var card = document.getElementById("appFeatured");
    if (!card || !station) {
      if (card) card.hidden = true;
      return;
    }
    card.hidden = false;
    document.getElementById("appFeaturedName").textContent = station.plant;
    document.getElementById("appFeaturedLoc").textContent = stationLocation(station);
    document.getElementById("appFeaturedStatus").textContent = photo && photo.health_status === "atencao" ? "Atenção" : "Online";

    var photoImg = document.getElementById("appFeaturedPhoto");
    if (photo && photo.image_url) {
      photoImg.src = photo.image_url;
      photoImg.hidden = false;
    } else {
      photoImg.hidden = true;
    }

    var btn = card.querySelector(".app-featured__btn");
    if (btn) btn.onclick = function () { window.location.href = "app-camera.html"; };
  }

  // ---- desktop: camera thumbnail (reuses the featured station's latest photo) ----
  function renderCameraThumb(station, photo) {
    var img = document.getElementById("appCameraThumb");
    var caption = document.getElementById("appCameraCaption");
    if (!img) return;
    if (photo && photo.image_url) img.src = photo.image_url;
    if (caption && station) caption.textContent = "Câmera · " + stationLocation(station);
  }

  // ---- desktop: sensor tiles (value + progress bar) ----
  var SENSOR_MAX = { light: 12, humidity: 100, ph: 14, temperature: 40 };
  function setSensorBar(id, ratio) {
    var bar = document.getElementById(id);
    if (!bar) return;
    var pct = Math.max(4, Math.min(100, Math.round((ratio || 0) * 100)));
    bar.style.width = pct + "%";
  }
  function renderSensors(reading) {
    var light = reading ? Math.round(reading.light_h) + "h" : "—";
    var ph = reading ? "pH " + reading.ph : "—";
    var humidity = reading ? Math.round(reading.humidity) + "%" : "—";
    var temp = reading ? Math.round(reading.temperature) + "°C" : "—";

    document.getElementById("appSensorLight").textContent = light;
    document.getElementById("appSensorPh").textContent = ph;
    document.getElementById("appSensorHumidity").textContent = humidity;
    document.getElementById("appSensorTemp").textContent = temp;

    document.getElementById("mSensorLight").textContent = light;
    document.getElementById("mSensorPh").textContent = ph;
    document.getElementById("mSensorHumidity").textContent = humidity;
    document.getElementById("mSensorTemp").textContent = temp;

    setSensorBar("appSensorLightBar", reading ? reading.light_h / SENSOR_MAX.light : 0);
    setSensorBar("appSensorHumidityBar", reading ? reading.humidity / SENSOR_MAX.humidity : 0);
    setSensorBar("appSensorPhBar", reading ? reading.ph / SENSOR_MAX.ph : 0);
    setSensorBar("appSensorTempBar", reading ? reading.temperature / SENSOR_MAX.temperature : 0);
  }

  // ---- mobile: station cards (unchanged 2-slot layout/markup) ----
  function mobileCardBodyHtml(station, reading, photo) {
    var healthStat = photo
      ? '<span class="m-app-station-card__stat m-app-station-card__stat--health-' + (photo.health_status === "atencao" ? "warn" : "ok") + '">' +
        '<img alt="" src="' + HEALTH_ICON[photo.health_status] + '" /> Saúde: ' + (HEALTH_LABEL[photo.health_status] || photo.health_status) +
        "</span>"
      : "";

    if (photo && photo.health_status === "atencao") {
      return (
        '<p class="m-app-station-card__name">' + escapeHtml(station.plant) + "</p>" +
        '<div class="m-app-station-card__stats">' + healthStat + "</div>" +
        '<p class="m-app-station-card__warning">' + escapeHtml(photo.analysis_text) + "</p>" +
        '<button type="button" class="m-app-station-card__btn" data-action="ver-camera">Ver câmera</button>'
      );
    }
    var extraStats = reading
      ? '<span class="m-app-station-card__stat"><img alt="" src="assets/icons/app/icon-app-humidity.svg" /> ' + Math.round(reading.humidity) + "%</span>" +
        '<span class="m-app-station-card__stat"><img alt="" src="assets/icons/app/icon-app-thermometer.svg" /> ' + Math.round(reading.temperature) + "°C</span>"
      : "";
    return (
      '<p class="m-app-station-card__name">' + escapeHtml(station.plant) + "</p>" +
      '<div class="m-app-station-card__stats">' + healthStat + extraStats + "</div>" +
      '<button type="button" class="m-app-station-card__btn" data-action="ver-camera">Ver câmera</button>'
    );
  }
  function renderMobileCard(mEl, station, reading, photo) {
    if (!mEl) return;
    if (!station) {
      mEl.hidden = true;
      return;
    }
    mEl.hidden = false;
    mEl.innerHTML = mobileCardBodyHtml(station, reading, photo);
  }

  // The mobile sensors/alerts/tab bar `top` values assume exactly 2 station
  // cards; with 0 or 1 station (status message instead, or a single card)
  // that leaves a big empty gap before the tab bar; when more content grows
  // past it, it would overlap instead. This measures the actual bottom edge
  // of whichever is visible and repositions the tab bar (and the page's
  // min-height) right after it.
  function positionMobileTrailing() {
    var mSensors = document.querySelector(".m-app-sensors");
    var mAlertsTitle = document.querySelector(".m-app-alerts__title");
    var mAlerts = document.querySelector(".m-app-alerts");
    var tabbar = document.querySelector(".m-app-tabbar");
    var mPage = document.getElementById("mAppHomePage");
    if (!mSensors || !mAlertsTitle || !mAlerts || !tabbar || !mPage) return;

    var bottomPx = 0;
    [
      document.getElementById("mAppHomeStatus"),
      document.getElementById("mAppStationCard1"),
      document.getElementById("mAppStationCard2"),
    ].forEach(function (el) {
      if (el && !el.hidden) bottomPx = Math.max(bottomPx, el.offsetTop + el.offsetHeight);
    });
    if (bottomPx === 0) return;

    var sensorsTopRem = bottomPx / 10 + 2.3;
    var alertsTitleTopRem = sensorsTopRem + 11.6 + 3.1;
    var alertsTopRem = alertsTitleTopRem + 4.1;
    var tabbarTopRem = alertsTopRem + 9.6 + 4.6;

    mSensors.style.top = sensorsTopRem + "rem";
    mAlertsTitle.style.top = alertsTitleTopRem + "rem";
    mAlerts.style.top = alertsTopRem + "rem";
    tabbar.style.top = tabbarTopRem + "rem";
    mPage.style.minHeight = tabbarTopRem + 9.4 + "rem";
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest('[data-action="ver-camera"]');
    if (target) window.location.href = "app-camera.html";
  });

  async function load() {
    var appStatus = document.getElementById("appHomeStatus");
    var mStatus = document.getElementById("mAppHomeStatus");
    setStatus(appStatus, "Carregando...", false);
    setStatus(mStatus, "Carregando...", false);
    renderGreeting();

    var stations;
    try {
      stations = await GrowAI.getStations();
    } catch (err) {
      setStatus(appStatus, err.message, true);
      setStatus(mStatus, err.message, true);
      renderPlantsList([]);
      renderFeatured(null);
      positionMobileTrailing();
      applyScale();
      return;
    }

    if (stations.length === 0) {
      var emptyMsg = "Você ainda não tem estações. Crie uma na tela Estações.";
      setStatus(appStatus, emptyMsg, false);
      setStatus(mStatus, emptyMsg, false);
      renderSensors(null);
      renderPlantsList([]);
      renderFeatured(null);
      positionMobileTrailing();
      applyScale();
      return;
    }
    setStatus(appStatus, "", false);
    setStatus(mStatus, "", false);

    var limited = stations.slice(0, 4);
    var details = await Promise.all(
      limited.map(function (s) {
        return Promise.all([
          GrowAI.getLatestReading(s.id).catch(function () { return null; }),
          GrowAI.getLatestPhoto(s.id).catch(function () { return null; }),
        ]);
      })
    );
    limited.forEach(function (s, i) { s.__photo = details[i][1]; });

    renderSensors(details[0][0]);
    renderPlantsList(limited);
    renderFeatured(limited[0], details[0][0], details[0][1]);
    renderCameraThumb(limited[0], details[0][1]);

    renderMobileCard(document.getElementById("mAppStationCard1"), limited[0], details[0][0], details[0][1]);
    renderMobileCard(document.getElementById("mAppStationCard2"), limited[1], details[1] ? details[1][0] : null, details[1] ? details[1][1] : null);

    positionMobileTrailing();
    applyScale();
  }

  // ---- canvas scaling ----
  var applyScale = initResponsiveCanvas({
    desktopPageId: "appHomePage",
    desktopWrapperSelector: ".app-home-wrapper",
    mobilePageId: "mAppHomePage",
    mobileWrapperSelector: ".m-app-home-wrapper",
  });

  load();
})();
