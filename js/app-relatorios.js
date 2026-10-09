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

  // Nome e unidade de cada campo da rotina, para o card nunca mostrar nome de
  // coluna ("water_interval_h"). Os mesmos rótulos do aviso de rotina
  // (js/station-modal.js) e do formulário da estação.
  var CAMPO = {
    light_hours: { nome: "Luz diária", un: " h" },
    humidity_target: { nome: "Umidade alvo", un: "%" },
    water_interval_h: { nome: "Rega a cada", un: " h" },
    ph_target: { nome: "pH alvo", un: "" },
    temp_max: { nome: "Ventilar acima de", un: " °C" },
    vent_min_por_hora: { nome: "Ventilação", un: " min/h" },
    nutri_s: { nome: "Nutriente", un: " s/dia" },
    luz_inicio: { nome: "Luz acende às", un: "" },
    nutri_hora: { nome: "Nutriente às", un: "" },
  };

  function valorCampo(k, v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    var texto = Number.isFinite(n) ? String(Math.round(n * 10) / 10).replace(".", ",") : String(v).slice(0, 5);
    return texto + ((CAMPO[k] && CAMPO[k].un) || "");
  }

  /* Lista "Luz diária  9 h -> 15 h" do que a sugestão muda. Campo que a IA
     devolveu com o mesmo valor de antes (9 -> 9) não é mudança e fica de fora. */
  function mudancasHtml(s, isDesktop) {
    if (!s.config) return "";
    var antes = s.config_anterior || {};
    var itens = Object.keys(s.config)
      .filter(function (k) {
        var de = antes[k];
        return !(de !== undefined && de !== null && String(Number(de)) === String(Number(s.config[k])) && de !== "");
      })
      .map(function (k) {
        var nome = CAMPO[k] ? CAMPO[k].nome : k;
        var de = valorCampo(k, antes[k]);
        var para = valorCampo(k, s.config[k]);
        return (
          "<li>" +
          '<span class="rel-change__name">' + escapeHtml(nome) + "</span>" +
          (de ? '<s class="rel-change__old">' + escapeHtml(de) + '</s><span class="rel-change__arrow" aria-hidden="true">→</span>' : "") +
          '<strong class="rel-change__new">' + escapeHtml(para || "—") + "</strong>" +
          "</li>"
        );
      });
    if (!itens.length) return "";
    return '<ul class="rel-changes' + (isDesktop ? "" : " rel-changes--m") + '">' + itens.join("") + "</ul>";
  }

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

    /* Com auto_aplicada, o card conta o que a IA JA fez - nao o que ela
       propoe. A diferenca importa: o usuario precisa saber que a rotina dele
       mudou sozinha. O estado vai numa etiqueta curta e as mudanças numa
       lista; a mensagem da IA fica sozinha no parágrafo. */
    var desc = escapeHtml(s.message);
    var estado = "";
    if (s.desfeita_em) estado = "Ajuste desfeito";
    else if (s.auto_aplicada) estado = "Ajustado pela IA";
    else if (s.applied) estado = "Sugestão aplicada";
    else if (s.config) estado = "Sugestão da IA";
    var estadoHtml = estado
      ? '<span class="rel-suggestion__state' + (s.desfeita_em ? " rel-suggestion__state--off" : "") + '">' + estado + "</span>"
      : "";
    var mudancas = mudancasHtml(s, isDesktop);

    var growthStat =
      '<span class="' + statClass + (isDesktop ? " rel-suggestion__stat--growth" : "") + '"><img alt="" src="' +
      growthIcon + '" /> Crescimento: +' + escapeHtml(s.growth_pct) + "%</span>";
    var healthStat =
      '<span class="' + statClass + (isDesktop ? " rel-suggestion__stat--health" : "") + '"><img alt="" src="' +
      healthIcon + '" /> Saúde: ' + escapeHtml(s.health_pct) + "%</span>";

    /* Tres estados possiveis, todos no mesmo botao (mesma classe, zero CSS
       novo):
         a IA aplicou sozinha e esta valendo -> "Desfazer ajuste"
         o usuario desfez                    -> "Ajuste desfeito" (desabilitado)
         fluxo antigo                        -> "Aplicar sugestao" / "aplicada"
       O botao de desfazer aparece mesmo com health_pct alto: a IA mexeu na
       rotina, e o usuario tem que poder voltar atras de qualquer jeito. */
    var btn = "";
    if (s.desfeita_em) {
      btn = '<button type="button" class="' + btnClass + '" disabled>Ajuste desfeito</button>';
    } else if (s.auto_aplicada) {
      btn = '<button type="button" class="' + btnClass + '" data-action="undo" data-id="' + s.id + '">Desfazer ajuste</button>';
    } else if (!healthy) {
      btn = s.applied
        ? '<button type="button" class="' + btnClass + '" disabled>Sugestão aplicada</button>'
        : '<button type="button" class="' + btnClass + '" data-action="apply" data-id="' + s.id + '">Aplicar sugestão</button>';
    }

    if (isDesktop) {
      return (
        '<p class="' + nameClass + '">' + name + "</p>" +
        badge +
        estadoHtml +
        '<p class="' + descClass + '">' + desc + "</p>" +
        mudancas +
        '<div class="rel-suggestion__footer">' +
        '<div class="rel-suggestion__stats">' + growthStat + healthStat + "</div>" +
        btn +
        "</div>"
      );
    }

    return (
      '<p class="' + nameClass + '">' + name + "</p>" +
      badge +
      estadoHtml +
      '<p class="' + descClass + '">' + desc + "</p>" +
      mudancas +
      '<div class="m-rel-suggestion__stats">' + growthStat + healthStat + "</div>" +
      btn
    );
  }

  function renderSuggestions(list) {
    var slots = [
      { d: document.getElementById("relSuggestion1"), m: document.getElementById("mRelSuggestion1") },
      { d: document.getElementById("relSuggestion2"), m: document.getElementById("mRelSuggestion2") },
    ];
    // sem nenhuma sugestão: em vez de um vazio sob o título, mostra o aviso
    ["relSuggestionsEmpty", "mRelSuggestionsEmpty"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = list.length > 0;
    });
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

  /* Os cards crescem com o texto (a IA pode ajustar vários campos de uma vez),
     mas a página é desenhada em posição absoluta. Então:
     - no celular, o 2º card vai para logo abaixo do 1º, seja qual for a
       altura dele (antes tinha `top` fixo e o 1º passava por cima);
     - no desktop, a página cresce se um card passar do fim dela. */
  var GAP_CARDS_M = 26; // px do canvas de 412: o mesmo vão do Figma entre os dois
  var alturaBaseDesktop = null;

  function encaixaCards() {
    var m1 = document.getElementById("mRelSuggestion1");
    var m2 = document.getElementById("mRelSuggestion2");
    if (m1 && m2 && !m1.hidden && !m2.hidden) {
      m2.style.top = m1.offsetTop + m1.offsetHeight + GAP_CARDS_M + "px";
    }

    var pagina = document.getElementById("appRelatoriosPage");
    if (!pagina) return;
    if (alturaBaseDesktop === null) alturaBaseDesktop = pagina.offsetHeight;
    var fundo = 0;
    ["relSuggestion1", "relSuggestion2"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.hidden) fundo = Math.max(fundo, el.offsetTop + el.offsetHeight);
    });
    pagina.style.height = Math.max(alturaBaseDesktop, fundo + 60) + "px";
  }

  // The mobile tab bar's `top` assumes both suggestion slots are visible;
  // with fewer (or none) that leaves a big gap, so it's repositioned right
  // after whatever actually ended up visible.
  function updateMobileTabbar() {
    encaixaCards();
    positionMobileTabbar({
      mobilePageId: "mAppRelatoriosPage",
      contentSelectors: [".m-rel-chart-card--2", "#mRelSuggestion1", "#mRelSuggestion2", "#mRelSuggestionsEmpty"],
    });
    applyScale();
  }

  document.addEventListener("click", async function (event) {
    var undoBtn = event.target.closest('[data-action="undo"]');
    if (undoBtn) {
      undoBtn.disabled = true;
      undoBtn.textContent = "Desfazendo...";
      try {
        var revertida = await GrowAI.undoSuggestion(undoBtn.dataset.id);
        suggestionsCache = suggestionsCache.map(function (s) {
          return s.id === revertida.id ? Object.assign({}, s, revertida) : s;
        });
        renderSuggestions(suggestionsCache);
        updateMobileTabbar();
        if (window.showToast) showToast("Rotina voltou aos valores anteriores.", "success");
      } catch (err) {
        undoBtn.disabled = false;
        undoBtn.textContent = "Desfazer ajuste";
        if (window.showToast) showToast(err.message, "error");
      }
      return;
    }

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
    GrowAI.syncProfile();
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
