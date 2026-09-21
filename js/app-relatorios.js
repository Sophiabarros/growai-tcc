(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  // The grid/axis art (chart-*-grid/axes.svg) is decorative and stays as
  // static Figma-exported images. Only the line+dots and the bars encode
  // real values, so those two are regenerated as inline SVG from the API
  // response instead. Plot areas below mirror the exact rem boxes already
  // used for the axis label rows in css/app-relatorios.css, so labels and
  // data line up.
  var CHART_BOXES = {
    desktop: {
      line: { w: 50.4, h: 29.2, left: 3.3, right: 50.0, top: 2.336, bottom: 25.696 },
      bars: { w: 48.7, h: 29.2, left: 6.229, right: 46.625, top: 1.46, bottom: 24.82 },
    },
    mobile: {
      line: { w: 26.5, h: 16.6, left: 1.9, right: 26.2, top: 0.8, bottom: 14.8 },
      bars: { w: 25.8, h: 18.6, left: 3.3, right: 24.7, top: 0.9, bottom: 17.1 },
    },
  };
  var BAR_MAX = 80; // matches the fixed 0-80 axis already printed in the HTML

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function buildLineSvg(values, box) {
    var n = values.length;
    var pts = values.map(function (v, i) {
      var x = box.left + (i / (n - 1)) * (box.right - box.left);
      var clamped = Math.max(0, Math.min(100, Number(v)));
      var y = box.top + (1 - clamped / 100) * (box.bottom - box.top);
      return [x, y];
    });
    var poly = pts.map(function (p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }).join(" ");
    var circles = pts
      .map(function (p) {
        return '<circle cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="0.35" fill="#FCFCFD" stroke="#88D3CF" stroke-width="0.15" />';
      })
      .join("");
    return (
      '<svg viewBox="0 0 ' + box.w + " " + box.h + '" style="position:absolute;inset:0;width:100%;height:100%">' +
      '<polyline points="' + poly + '" fill="none" stroke="#88D3CF" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round" />' +
      circles +
      "</svg>"
    );
  }

  function buildBarSvg(values, box) {
    var n = values.length;
    var groupWidth = (box.right - box.left) / n;
    var barWidth = groupWidth * 0.45;
    var bars = values
      .map(function (v, i) {
        var clamped = Math.max(0, Math.min(BAR_MAX, Number(v)));
        var barHeight = (clamped / BAR_MAX) * (box.bottom - box.top);
        var x = box.left + i * groupWidth + (groupWidth - barWidth) / 2;
        var y = box.bottom - barHeight;
        return (
          '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barWidth.toFixed(2) +
          '" height="' + Math.max(barHeight, 0.3).toFixed(2) + '" rx="' + (barWidth * 0.3).toFixed(2) + '" fill="#88D3CF" />'
        );
      })
      .join("");
    return '<svg viewBox="0 0 ' + box.w + " " + box.h + '" style="position:absolute;inset:0;width:100%;height:100%">' + bars + "</svg>";
  }

  function renderCharts(report) {
    var health = report ? report.health.map(function (d) { return d.value; }) : [0, 0, 0, 0, 0, 0, 0];
    var env = report ? report.environment.map(function (d) { return d.value; }) : [0, 0, 0, 0, 0, 0, 0];

    document.getElementById("relChart1Data").innerHTML = buildLineSvg(health, CHART_BOXES.desktop.line);
    document.getElementById("relChart2Data").innerHTML = buildBarSvg(env, CHART_BOXES.desktop.bars);
    document.getElementById("mRelChart1Data").innerHTML = buildLineSvg(health, CHART_BOXES.mobile.line);
    document.getElementById("mRelChart2Data").innerHTML = buildBarSvg(env, CHART_BOXES.mobile.bars);
  }

  // Intervalo da semana atual (segunda a domingo, como no eixo dos gráficos),
  // ex.: "15 - 21 de setembro" ou "28 de set. - 4 de out." quando cruza o mês.
  function renderWeekRange() {
    var now = new Date();
    var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    var sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    var month = function (d, style) { return d.toLocaleDateString("pt-BR", { month: style }); };
    var label =
      monday.getMonth() === sunday.getMonth()
        ? monday.getDate() + " - " + sunday.getDate() + " de " + month(sunday, "long")
        : monday.getDate() + " de " + month(monday, "short").replace(".", "") + ". - " +
          sunday.getDate() + " de " + month(sunday, "short").replace(".", "") + ".";
    ["relSubtitle", "mRelSubtitle"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = label;
    });
  }

  // ---- suggestions ----
  var HEALTHY_THRESHOLD = 85;

  function suggestionCardHtml(s, isDesktop) {
    var healthy = Number(s.health_pct) >= HEALTHY_THRESHOLD;
    var growthIcon = "assets/icons/app/icon-app-crescimento-1" + (isDesktop ? "-d" : "") + ".svg";
    var healthIcon = "assets/icons/app/icon-app-rel-check" + (isDesktop ? "-d" : "") + ".svg";
    var name = escapeHtml(s.station_name) + " - " + escapeHtml(s.plant);
    var nameClass = isDesktop ? "rel-suggestion__name" : "m-rel-suggestion__name";
    var descClass = isDesktop ? "rel-suggestion__desc" : "m-rel-suggestion__desc";
    var statClass = isDesktop ? "rel-suggestion__stat" : "m-rel-suggestion__stat";
    var badgeClass = isDesktop ? "rel-suggestion__badge" : "m-rel-suggestion__badge";
    var btnClass = isDesktop ? "rel-suggestion__btn" : "m-rel-suggestion__btn";

    var badge = "";
    if (!healthy) {
      var avisoIcon = "assets/icons/app/icon-app-rel-aviso" + (isDesktop ? "-d" : "") + ".svg";
      badge = '<span class="' + badgeClass + '"><img alt="" src="' + avisoIcon + '" /></span>';
    } else if (!isDesktop) {
      badge = '<span class="' + badgeClass + '"><img alt="" src="assets/icons/app/icon-app-seta-crescimento.svg" /></span>';
    }

    var growthStat =
      '<span class="' + statClass + (isDesktop ? " rel-suggestion__stat--growth" : "") + '"><img alt="" src="' +
      growthIcon + '" /> Crescimento: +' + escapeHtml(s.growth_pct) + "%</span>";
    var healthStat =
      '<span class="' + statClass + (isDesktop ? " rel-suggestion__stat--health" : "") + '"><img alt="" src="' +
      healthIcon + '" /> Saúde: ' + escapeHtml(s.health_pct) + "%</span>";

    var btn = "";
    if (!healthy) {
      btn = s.applied
        ? '<button type="button" class="' + btnClass + '" disabled>Sugestão aplicada</button>'
        : '<button type="button" class="' + btnClass + '" data-action="apply" data-id="' + s.id + '">Aplicar sugestão</button>';
    }

    if (isDesktop) {
      return (
        '<p class="' + nameClass + '">' + name + "</p>" +
        '<p class="' + descClass + '">' + escapeHtml(s.message) + "</p>" +
        growthStat +
        healthStat +
        badge +
        btn
      );
    }

    return (
      '<p class="' + nameClass + '">' + name + "</p>" +
      badge +
      '<p class="' + descClass + '">' + escapeHtml(s.message) + "</p>" +
      '<div class="m-rel-suggestion__stats">' + growthStat + healthStat + "</div>" +
      btn
    );
  }

  function renderSuggestions(list) {
    var slots = [
      { d: document.getElementById("relSuggestion1"), m: document.getElementById("mRelSuggestion1") },
      { d: document.getElementById("relSuggestion2"), m: document.getElementById("mRelSuggestion2") },
    ];
    slots.forEach(function (slot, i) {
      var s = list[i];
      if (!s) {
        slot.d.hidden = true;
        slot.m.hidden = true;
        return;
      }
      slot.d.hidden = false;
      slot.m.hidden = false;
      slot.d.innerHTML = suggestionCardHtml(s, true);
      slot.m.innerHTML = suggestionCardHtml(s, false);
    });
  }

  var suggestionsCache = [];

  // The mobile tab bar's `top` assumes both suggestion slots are visible;
  // with fewer (or none) that leaves a big gap, so it's repositioned right
  // after whatever actually ended up visible.
  function updateMobileTabbar() {
    positionMobileTabbar({
      mobilePageId: "mAppRelatoriosPage",
      contentSelectors: [".m-rel-chart-card--2", "#mRelSuggestion1", "#mRelSuggestion2"],
    });
    applyScale();
  }

  document.addEventListener("click", async function (event) {
    var btn = event.target.closest('[data-action="apply"]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "Aplicando...";
    try {
      var updated = await GrowAI.applySuggestion(btn.dataset.id);
      suggestionsCache = suggestionsCache.map(function (s) {
        return s.id === updated.id ? Object.assign({}, s, updated) : s;
      });
      renderSuggestions(suggestionsCache);
      updateMobileTabbar();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Aplicar sugestão";
      showToast(err.message, "error");
    }
  });

  async function load() {
    renderWeekRange();
    try {
      var reports = await GrowAI.getWeeklyReports();
      renderCharts(reports[0] || null);
    } catch (err) {
      renderCharts(null);
    }

    try {
      suggestionsCache = await GrowAI.getSuggestions();
      renderSuggestions(suggestionsCache);
    } catch (err) {
      // leave the two suggestion slots hidden on failure
    }

    updateMobileTabbar();
  }

  // ---- canvas scaling ----
  var applyScale = initResponsiveCanvas({
    desktopPageId: "appRelatoriosPage",
    desktopWrapperSelector: ".app-relatorios-wrapper",
    mobilePageId: "mAppRelatoriosPage",
    mobileWrapperSelector: ".m-app-relatorios-wrapper",
  });

  load();
})();
