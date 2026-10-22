(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  var HEALTH_LABEL = { saudavel: "boa", atencao: "média", indefinido: "—" };
  var HEALTH_ICON = {
    saudavel: "assets/icons/app/icon-app-check.svg",
    atencao: "assets/icons/app/icon-app-warning.svg",
    // 'indefinido' = a IA nao analisou (desligada, falhou ou deu timeout).
    // Reaproveita o check, sem icone de alerta: nao e problema na planta.
    indefinido: "assets/icons/app/icon-app-check.svg",
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
    var horas = Math.round(minutes / 60);
    if (horas < 48) return horas + "h atrás";
    return Math.round(horas / 24) + " dias atrás";
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
    /* Ordem: Offline (a placa nao fala com o servidor) tem prioridade sobre
       Atencao (a IA viu algo na foto), porque com a placa fora do ar o dado da
       foto pode ser de horas atras. `online` vem de readings/latest. */
    var estaOnline = !!(reading && reading.online);
    document.getElementById("appFeaturedStatus").textContent =
      !estaOnline ? "Offline" : photo && photo.health_status === "atencao" ? "Atenção" : "Online";

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
      // Sensor com defeito (ex.: DS18B20 solto). Só com a placa online: offline
      // o erro pode ser velho.
      var r = s.__reading;
      if (r && r.online && r.erro) {
        var semTemp = /DS18B20/i.test(r.erro);
        alerts.push({
          title: semTemp
            ? "Sensor de temperatura sem leitura" + (r.temperatura_fonte === "sao_paulo" ? " — mostrando a temperatura de São Paulo" : "")
            : "Sensor com problema: " + r.erro,
          meta: s.plant + " · confira a ligação do sensor",
        });
      }
      var photo = s.__photo;
      // Anti-pragas: praga vista na última foto analisada vira alerta próprio.
      if (photo && photo.pragas === "sim") {
        alerts.push({
          title: "Praga detectada" + (photo.pragas_descricao ? ": " + photo.pragas_descricao : ""),
          meta: s.plant + " · " + timeAgo(photo.captured_at),
        });
      }
      if (photo && photo.health_status === "atencao") {
        alerts.push({
          title: photo.analysis_text || "Planta precisa de atenção",
          meta: s.plant + " · " + timeAgo(photo.captured_at),
        });
      }
    });
    return alerts.slice(0, 4);
  }
  /* Sem nenhum alerta, a seção inteira (título, "Ver todos" e a lista) sai
     da tela, em vez de ocupar espaço com "Nenhum alerta no momento". */
  function mostrarSecaoAlertas(ids, visivel) {
    ids.forEach(function (id) {
      var el = typeof id === "string" ? document.getElementById(id) : id;
      if (el) el.hidden = !visivel;
    });
  }
  function renderAlerts(alerts) {
    var container = document.getElementById("appAlerts");
    if (!container) return;
    mostrarSecaoAlertas(["appAlertsTitle", "appAlertsSeeAll", "appAlerts"], alerts.length > 0);
    if (!alerts.length) {
      container.innerHTML = "";
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
    mostrarSecaoAlertas([document.querySelector(".m-app-alerts__title"), "mAppAlerts"], alerts.length > 0);
    if (!alerts.length) {
      container.innerHTML = "";
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
    var titulo = document.getElementById("appSystemStatusTitle");
    if (titulo) titulo.textContent = mode === "ok" ? "Sistema online" : mode === "offline" ? "Sistema offline" : "Sistema";
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
  var SENSOR_MAX = { light: 12, humidity: 100, temperature: 40 };
  function setSensorBar(id, ratio) {
    var bar = document.getElementById(id);
    if (!bar) return;
    var pct = Math.max(4, Math.min(100, Math.round((ratio || 0) * 100)));
    bar.style.width = pct + "%";
  }
  // null != 0. Sensor com defeito manda null, e o projeto nao tem sensor de
  // luminosidade - mostrar "0%" ou "NaN" seria inventar leitura.
  function temValor(v) {
    return v !== null && v !== undefined && isFinite(v);
  }
  function fmtSensor(reading, campo, sufixo) {
    if (!reading || !temValor(reading[campo])) return "—";
    return Math.round(Number(reading[campo])) + sufixo;
  }
  function razaoSensor(reading, campo, max) {
    if (!reading || !temValor(reading[campo])) return 0;
    return Number(reading[campo]) / max;
  }

  /* "Última atualização" era texto fixo ("agora"), mesmo com a placa fora do
     ar há dias. Agora mostra a idade real da leitura. */
  function renderSensorsUpdated(reading) {
    var el = document.getElementById("appSensorsUpdated");
    if (!el || !el.firstChild || el.firstChild.nodeType !== 3) return;
    el.firstChild.nodeValue = reading && reading.recorded_at
      ? "Última atualização: " + timeAgo(reading.recorded_at)
      : "Sem leituras ainda";
  }

  /* Nível de luz que a IA avaliou no quadro de iluminação da câmera
     (cam-2.1.0), da última foto analisada. Sem avaliação, fica o que era:
     as horas de luz da rotina. */
  // "Incerta": a IA não conseguiu julgar (câmera sem a planta no quadro, lente tampada).
  var LUZ_NIVEL = { pouca: "Pouca", boa: "Boa", muita: "Muita", incerto: "Incerta" };
  var LUZ_BARRA = { pouca: 0.3, boa: 0.7, muita: 1, incerto: 0 };

  function renderSensors(reading, photo) {
    renderSensorsUpdated(reading);
    var horasLuz = fmtSensor(reading, "light_h", "h");
    var nivel = photo && LUZ_NIVEL[photo.luz_nivel] ? photo.luz_nivel : null;
    /* Sem avaliação da IA ainda, o card diz por quê, em vez de mostrar só as
       horas e parecer que não faz nada: luz de cultivo apagada agora (a luz
       só é avaliada no horário de luz da rotina) ou aguardando a primeira
       análise do dia. */
    var luzApagada = !!(reading && reading.reles && Number(reading.reles.luz) === 0);
    var situacao = nivel ? LUZ_NIVEL[nivel] : luzApagada ? "apagada" : "avaliando";
    var light = nivel ? LUZ_NIVEL[nivel] : horasLuz;
    // Luz natural boa: a IA deixou o LED de cultivo apagado (services/luzIa.js).
    var ledPelaIa = !!(reading && Number(reading.luz_pausa_s) > 0);
    var lightLabel = document.getElementById("appSensorLightLabel");
    if (lightLabel) {
      lightLabel.textContent = ledPelaIa ? "Luz natural · LED off (IA)"
        : nivel && horasLuz !== "—" ? "Luz · " + horasLuz + "/dia"
        : reading ? "Luz · " + situacao : "Luz";
    }
    var humidity = fmtSensor(reading, "humidity", "%");
    var temp = fmtSensor(reading, "temperature", "°C");
    /* Sensor de temperatura sem leitura: o backend manda a de São Paulo
       (internet) e marca temperatura_fonte. O rótulo diz de onde veio. */
    var tempDeSP = !!(reading && reading.temperatura_fonte === "sao_paulo");

    // Luz UV de hoje (= tempo com os ventiladores ligados) contra o limite da rotina.
    var uvLimite = reading && temValor(reading.uv_min_dia) ? Number(reading.uv_min_dia) : 30;
    var uvMin = reading && temValor(reading.uv_s_hoje) ? Math.round(Number(reading.uv_s_hoje) / 60) : null;
    var uv = uvMin === null ? "—" : uvMin + " min";

    document.getElementById("appSensorLight").textContent = light;
    document.getElementById("appSensorUv").textContent = uv;
    document.getElementById("appSensorHumidity").textContent = humidity;
    document.getElementById("appSensorTemp").textContent = temp;
    var tempLabel = document.getElementById("appSensorTempLabel");
    // Hora da medição (Congonhas mede de hora em hora): mostra que a temperatura muda.
    var tempHora = tempDeSP && reading.temperatura_medida_em
      ? new Date(reading.temperatura_medida_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "";
    if (tempLabel) tempLabel.textContent = tempDeSP ? "Temp · SP" + (tempHora ? " às " + tempHora : "") : "Temp";

    document.getElementById("mSensorLight").textContent = ledPelaIa ? situacao + " · LED off"
      : reading ? horasLuz + " · " + situacao : horasLuz;
    document.getElementById("mSensorUv").textContent = uvMin === null ? "—" : "UV " + uvMin + " min";
    document.getElementById("mSensorHumidity").textContent = humidity;
    document.getElementById("mSensorTemp").textContent = tempDeSP && temp !== "—" ? temp + " (SP" + (tempHora ? " " + tempHora.replace(":00", "h") : "") + ")" : temp;

    setSensorBar("appSensorLightBar", nivel ? LUZ_BARRA[nivel] : razaoSensor(reading, "light_h", SENSOR_MAX.light));
    setSensorBar("appSensorHumidityBar", razaoSensor(reading, "humidity", SENSOR_MAX.humidity));
    setSensorBar("appSensorUvBar", uvMin === null ? 0 : uvMin / Math.max(1, uvLimite));
    setSensorBar("appSensorTempBar", razaoSensor(reading, "temperature", SENSOR_MAX.temperature));
  }

  // ---- mobile: station cards (unchanged 2-slot layout/markup) ----
  function mobileCardBodyHtml(station, reading, photo) {
    var healthStat = photo
      ? '<span class="m-app-station-card__stat m-app-station-card__stat--health-' + (photo.health_status === "atencao" ? "warn" : "ok") + '">' +
        '<img alt="" src="' + (HEALTH_ICON[photo.health_status] || HEALTH_ICON.saudavel) + '" /> ' +
        (photo.health_status === "indefinido"
          ? "Sem análise"
          : "Saúde: " + (HEALTH_LABEL[photo.health_status] || photo.health_status)) +
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
      ? '<span class="m-app-station-card__stat"><img alt="" src="assets/icons/app/icon-app-humidity.svg" /> ' + fmtSensor(reading, "humidity", "%") + "</span>" +
        '<span class="m-app-station-card__stat"><img alt="" src="assets/icons/app/icon-app-thermometer.svg" /> ' + fmtSensor(reading, "temperature", "°C") + "</span>"
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

    // Os cards têm altura própria (o "saudável" é bem mais baixo que o com
    // aviso), então o 2º card é empilhado logo abaixo do 1º em vez de ficar
    // num `top` fixo do CSS.
    var CARDS_TOP_REM = 15.7;
    var CARDS_GAP_REM = 2.3;
    var nextCardTopRem = CARDS_TOP_REM;
    [
      document.getElementById("mAppStationCard1"),
      document.getElementById("mAppStationCard2"),
    ].forEach(function (card) {
      if (!card || card.hidden) return;
      card.style.top = nextCardTopRem + "rem";
      nextCardTopRem += card.offsetHeight / 10 + CARDS_GAP_REM;
    });

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

    // Sem alertas a seção some: a página termina logo depois dos sensores.
    if (mAlerts.hidden) {
      mPage.style.minHeight = sensorsTopRem + mSensors.offsetHeight / 10 + 4.6 + "rem";
      return;
    }

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

    // Sincroniza perfil (avatar, nome, etc) com o backend, caso tenha mudado
    // em outro dispositivo. Falha silenciosa pra não bloquear o carregamento.
    GrowAI.syncProfile();

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
    limited.forEach(function (s, i) { s.__photo = details[i][1]; s.__reading = details[i][0]; });

    destaque = { station: limited[0], photo: details[0][1] };
    renderSensors(details[0][0], details[0][1]);
    renderPlantsList(limited);
    renderFeatured(limited[0], details[0][0], details[0][1]);
    renderCameraThumb(limited[0], details[0][1]);

    var alerts = buildAlerts(limited);
    renderAlerts(alerts);
    renderMobileAlerts(alerts);

    /* Antes bastava a requisicao ter respondido. Agora leitura sem `online`
       tambem conta como offline: a placa pode ter parado de mandar e a ultima
       leitura continuar no banco. */
    var allConnected = details.every(function (d) { return d[0] !== null && d[0].online !== false; });
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

  /* Ao vivo: a cada fala da placa principal (5-15 s) os sensores da estação em
     destaque mudam sozinhos; foto nova analisada recarrega a página inteira.
     O intervalo de 60 s é a reserva para quando o WebSocket não conecta. */
  var destaque = null;
  function aplicarAoVivo(leitura) {
    if (!destaque || !leitura) return;
    var l = Object.assign({ light_h: destaque.station.light_hours }, leitura);
    renderSensors(l, destaque.photo);
    renderFeatured(destaque.station, l, destaque.photo);
    if (l.online) renderSystemStatus("ok");
  }
  GrowAI.aoVivo(function (msg) {
    if (!destaque || Number(msg.station_id) !== Number(destaque.station.id)) return;
    if (msg.tipo === "telemetria") aplicarAoVivo(msg.leitura);
    else if (msg.tipo === "foto") load();
  });
  setInterval(function () {
    if (!destaque || document.hidden) return;
    GrowAI.getLatestReading(destaque.station.id).then(aplicarAoVivo).catch(function () {});
  }, 60000);

  load();
})();
