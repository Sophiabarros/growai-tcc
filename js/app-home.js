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

  // "empty" (no stations yet) and "error" (fetch failed) both need more than
  // plain text — a next action, so the user isn't just told what's wrong.
  // Kept separate from setStatus() because these two build their own markup
  // (a CTA/retry button) instead of a plain textContent message.
  function renderHomeStatus(kind, message) {
    [document.getElementById("appHomeStatus"), document.getElementById("mAppHomeStatus")].forEach(function (el) {
      if (!el) return;
      el.hidden = false;
      el.classList.toggle("app-home__status--error", kind === "error");
      el.classList.toggle("m-app-home__status--error", kind === "error");
      el.innerHTML =
        escapeHtml(message) +
        (kind === "error"
          ? ' <button type="button" class="app-home__status-btn" data-action="retry-home">Tentar novamente</button>'
          : ' <a href="app-estacoes.html" class="app-home__status-btn">Criar estação</a>');
    });
  }

  function firstName(name) {
    if (!name) return "";
    return String(name).trim().split(/\s+/)[0];
  }

  function stationLocation(station) {
    if (!station) return "";
    return station.tag ? station.name + " · " + station.tag : station.name;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (minutes < 1) return "agora mesmo";
    if (minutes < 60) return minutes + " min atrás";
    return Math.round(minutes / 60) + "h atrás";
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
      photoImg.removeAttribute("src");
    }

    var btn = card.querySelector(".app-featured__btn");
    if (btn) btn.onclick = function () { window.location.href = "app-camera.html"; };
  }

  // ---- desktop: camera thumbnail (reuses the featured station's latest photo) ----
  // No photo yet == camera never sent an image, so it shows no picture at
  // all (not even a placeholder) — just the "Câmera desconectada" text.
  function renderCameraThumb(station, photo) {
    var img = document.getElementById("appCameraThumb");
    var live = document.getElementById("appCameraLive");
    var offline = document.getElementById("appCameraOffline");
    var caption = document.getElementById("appCameraCaption");
    if (!img) return;
    if (photo && photo.image_url) {
      img.src = photo.image_url;
      img.hidden = false;
      if (live) live.hidden = false;
      if (offline) offline.hidden = true;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      if (live) live.hidden = true;
      if (offline) offline.hidden = false;
    }
    if (caption && station) caption.textContent = "Câmera · " + stationLocation(station);
  }

  // ---- desktop + mobile: alerts (derived from real station data — a photo
  // flagged "atencao" by the backend — never hardcoded/fake) ----
  var ALERT_ICON = "assets/icons/app/icon-app-warning.svg";
  function buildAlerts(stations) {
    var alerts = [];
    stations.forEach(function (s) {
      var photo = s.__photo;
      if (photo && photo.health_status === "atencao") {
        alerts.push({
          title: photo.analysis_text || "Planta precisa de atenção",
          meta: s.plant + " · " + timeAgo(photo.captured_at),
        });
      }
    });
    return alerts.slice(0, 4);
  }
  function renderAlerts(alerts) {
    var container = document.getElementById("appAlerts");
    if (!container) return;
    if (!alerts.length) {
      container.innerHTML = '<p class="app-alerts__empty">Nenhum alerta no momento.</p>';
      return;
    }
    container.innerHTML = alerts
      .map(function (a) {
        return (
          '<a href="app-estacoes.html" class="app-alert">' +
          '<img class="app-alert__icon" alt="" src="' + ALERT_ICON + '" />' +
          '<span class="app-alert__body">' +
          '<p class="app-alert__title">' + escapeHtml(a.title) + "</p>" +
          '<span class="app-alert__meta">' + escapeHtml(a.meta) + "</span>" +
          "</span>" +
          '<img class="app-alert__arrow" alt="" src="assets/icons/app/icon-cfg-seta-d.svg" />' +
          "</a>"
        );
      })
      .join("");
  }
  function renderMobileAlerts(alerts) {
    var container = document.getElementById("mAppAlerts");
    if (!container) return;
    if (!alerts.length) {
      container.innerHTML = '<p class="m-app-alerts__empty">Nenhum alerta no momento.</p>';
      return;
    }
    container.innerHTML = alerts
      .map(function (a) {
        return (
          '<div class="m-app-alert m-app-alert--warn">' +
          '<img alt="" src="' + ALERT_ICON + '" />' +
          "<span>" + escapeHtml(a.title) + "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  // ---- desktop: "Sistema online" footer (reflects real fetch failures —
  // if a station's latest reading couldn't be fetched, the ESP isn't
  // reachable) ----
  function renderSystemStatus(mode) {
    var text = document.getElementById("appSystemStatusText");
    var dot = document.getElementById("appSystemStatusDot");
    if (!text) return;
    var label =
      mode === "ok" ? "Todos os dispositivos funcionando" : mode === "offline" ? "Não conectado" : "Nenhum dispositivo cadastrado";
    text.textContent = label;
    text.classList.toggle("app-plants__footer-text--offline", mode !== "ok");
    if (dot) dot.classList.toggle("app-plant-row__dot--offline", mode !== "ok");
  }

  // ---- desktop: sem estações, Sensores/Alertas/Câmeras somem e a página
  // encolhe até a borda inferior real do que ainda está visível (Suas
  // plantas / Dica), em vez de deixar o vão fixo calculado pro estado cheio.
  function positionDesktopLayout(isEmpty) {
    var page = document.getElementById("appHomePage");
    if (!page) return;
    page.classList.toggle("app-home--empty", isEmpty);
    if (!isEmpty) {
      page.style.minHeight = "";
      return;
    }
    var plants = document.getElementById("appPlants");
    var tip = document.getElementById("appTip");
    var bottomPx = 0;
    [plants, tip].forEach(function (el) {
      if (el) bottomPx = Math.max(bottomPx, el.offsetTop + el.offsetHeight);
    });
    if (bottomPx > 0) page.style.minHeight = bottomPx / 10 + 4 + "rem";
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

  // The mobile sensors/alerts `top` values assume exactly 2 station cards;
  // with 0 or 1 station (status message instead, or a single card) that
  // leaves a big empty gap; when more content grows past it, it would
  // overlap instead. This measures the actual bottom edge of whichever is
  // visible and repositions everything below it (and the page's
  // min-height) right after it. The tab bar itself is `position:fixed`
  // (css/app-shell.css) — it no longer lives in this flow, so it isn't
  // touched here; .m-app-home's own `padding-bottom` reserves its footprint.
  function positionMobileTrailing() {
    var mSensors = document.querySelector(".m-app-sensors");
    var mAlertsTitle = document.querySelector(".m-app-alerts__title");
    var mAlerts = document.getElementById("mAppAlerts");
    var mPage = document.getElementById("mAppHomePage");
    if (!mSensors || !mAlertsTitle || !mAlerts || !mPage) return;

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

    mSensors.style.top = sensorsTopRem + "rem";
    mAlertsTitle.style.top = alertsTitleTopRem + "rem";
    mAlerts.style.top = alertsTopRem + "rem";

    // Alerts now render 0-4 real rows instead of a fixed 2, so min-height is
    // set from the actual measured height instead of an assumed 2-row
    // constant.
    var alertsHeightRem = mAlerts.offsetHeight / 10;
    mPage.style.minHeight = alertsTopRem + alertsHeightRem + 4.6 + "rem";
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest('[data-action="ver-camera"]');
    if (target) window.location.href = "app-camera.html";

    var retry = event.target.closest('[data-action="retry-home"]');
    if (retry) load();
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
      // err.status: 0 == never reached the server, a number == the server
      // responded but with an error — worth telling apart even though both
      // land on the same friendly copy + retry button here.
      var offline = err.status === 0;
      renderHomeStatus("error", offline ? "Sem conexão com o servidor." : "Não foi possível carregar sua horta agora.");
      if (window.showToast) showToast(err.message, "error");
      renderPlantsList([]);
      renderFeatured(null);
      renderAlerts([]);
      renderMobileAlerts([]);
      renderSystemStatus("none");
      positionDesktopLayout(true);
      positionMobileTrailing();
      applyScale();
      return;
    }

    if (stations.length === 0) {
      renderHomeStatus("empty", "Você ainda não tem estações.");
      renderSensors(null);
      renderPlantsList([]);
      renderFeatured(null);
      renderAlerts([]);
      renderMobileAlerts([]);
      renderSystemStatus("none");
      positionDesktopLayout(true);
      positionMobileTrailing();
      applyScale();
      return;
    }
    setStatus(appStatus, "", false);
    setStatus(mStatus, "", false);
    positionDesktopLayout(false);

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

    var alerts = buildAlerts(limited);
    renderAlerts(alerts);
    renderMobileAlerts(alerts);

    var allConnected = details.every(function (d) { return d[0] !== null; });
    renderSystemStatus(allConnected ? "ok" : "offline");

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
