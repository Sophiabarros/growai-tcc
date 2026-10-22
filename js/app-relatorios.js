(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  /* Os dois gráficos (linha da saúde e barras da umidade) usam a MESMA
     geometria, e a grade, os eixos, as barras e a linha saem todos do mesmo
     SVG. Antes a grade e os eixos eram imagens exportadas do Figma, cada uma
     com um deslocamento próprio: os dois cartões não se alinhavam e os
     rótulos não caíam embaixo dos pontos. Medidas em rem, iguais às de
     css/app-relatorios.css (.rel-chart1/2 e .m-rel-chart1/2). */
  var CHART_BOXES = {
    desktop: { w: 50.4, h: 29.2, left: 5.2, right: 49.0, top: 1.6, bottom: 25.2 },
    mobile: { w: 33.5, h: 16.6, left: 3.2, right: 32.6, top: 0.9, bottom: 13.6 },
  };
  var BAR_MAX = 100; // umidade do solo, 0-100% (eixo impresso no HTML)

  // Grade tracejada em 0/25/50/75/100 e os dois eixos.
  function gradeSvg(box) {
    var linhas = [0, 25, 50, 75, 100].map(function (v) {
      var y = (box.top + (1 - v / 100) * (box.bottom - box.top)).toFixed(2);
      return '<line class="rg-grade" x1="' + box.left + '" x2="' + box.right + '" y1="' + y + '" y2="' + y +
        '" stroke="#88D3CF" stroke-opacity="0.16" stroke-width="0.06" stroke-dasharray="0.3 0.3" />';
    }).join("");
    var eixos =
      '<line class="rg-eixo" x1="' + box.left + '" x2="' + box.left + '" y1="' + box.top + '" y2="' + box.bottom +
      '" stroke="#88D3CF" stroke-opacity="0.7" stroke-width="0.08" />' +
      '<line class="rg-eixo" x1="' + box.left + '" x2="' + box.right + '" y1="' + box.bottom + '" y2="' + box.bottom +
      '" stroke="#88D3CF" stroke-opacity="0.7" stroke-width="0.08" />';
    return linhas + eixos;
  }

  function svgDe(box, conteudo) {
    return '<svg viewBox="0 0 ' + box.w + " " + box.h + '" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">' +
      gradeSvg(box) + conteudo + "</svg>";
  }

  // Onde fica o i-ésimo ponto (linha) ou o centro da i-ésima barra, de 0 a 1
  // da largura da área de plotagem. Os rótulos do eixo X usam a mesma conta.
  function fracaoLinha(i, n) { return n === 1 ? 0.5 : i / (n - 1); }
  function fracaoBarra(i, n) { return (i + 0.5) / n; }

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function temNum(v) {
    return v !== null && v !== undefined && v !== "" && isFinite(Number(v));
  }

  /* Linha da saúde. Ponto sem dado (null) NÃO vira zero: a linha só liga
     pontos vizinhos que existem, e o buraco fica visível. Cada bolinha tem
     um <title> (dica ao passar o mouse). */
  function buildLineSvg(values, dicas, box, ligarLacunas) {
    var n = values.length;
    var pts = values.map(function (v, i) {
      if (!temNum(v)) return null;
      var x = box.left + fracaoLinha(i, n) * (box.right - box.left);
      var clamped = Math.max(0, Math.min(100, Number(v)));
      var y = box.top + (1 - clamped / 100) * (box.bottom - box.top);
      return [x, y, i];
    });
    var segs = [];
    var atual = [];
    pts.forEach(function (p) {
      if (p) atual.push(p);
      // No dia, as fotos são a cada 3 h por projeto: liga os pontos mesmo assim.
      else if (atual.length && !ligarLacunas) { segs.push(atual); atual = []; }
    });
    if (atual.length) segs.push(atual);
    var linhas = segs
      .filter(function (seg) { return seg.length > 1; })
      .map(function (seg) {
        var poly = seg.map(function (p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }).join(" ");
        return '<polyline class="rg-linha" points="' + poly + '" fill="none" stroke="#88D3CF" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round" />';
      })
      .join("");
    var r = n > 12 ? 0.25 : 0.35;
    var circles = pts
      .filter(Boolean)
      .map(function (p) {
        return '<circle class="rg-ponto" cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="' + r + '" fill="#FCFCFD" stroke="#88D3CF" stroke-width="0.15"><title>' +
          escapeHtml(dicas[p[2]] || "") + "</title></circle>";
      })
      .join("");
    return svgDe(box, linhas + circles);
  }

  // Barras da umidade. null = sem barra (sem leitura), não barra zerada.
  function buildBarSvg(values, dicas, box) {
    var n = values.length;
    var groupWidth = (box.right - box.left) / n;
    var barWidth = groupWidth * (n > 12 ? 0.6 : 0.45);
    var altura = box.bottom - box.top;
    var bars = values
      .map(function (v, i) {
        if (!temNum(v)) return "";
        var clamped = Math.max(0, Math.min(BAR_MAX, Number(v)));
        // Nunca passa do topo da área (100%), por mais alta que seja a barra.
        var barHeight = Math.min(altura, (clamped / BAR_MAX) * altura);
        var x = box.left + fracaoBarra(i, n) * (box.right - box.left) - barWidth / 2;
        barHeight = Math.max(barHeight, 0.3); // 0% vira um traço SOBRE o eixo, não abaixo dele
        var y = box.bottom - barHeight;
        return (
          '<rect class="rg-barra" x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barWidth.toFixed(2) +
          '" height="' + Math.max(barHeight, 0.3).toFixed(2) + '" rx="' + Math.min(barWidth * 0.3, Math.max(barHeight, 0.3) / 2).toFixed(2) + '" fill="#88D3CF"><title>' +
          escapeHtml(dicas[i] || "") + "</title></rect>"
        );
      })
      .join("");
    return svgDe(box, bars);
  }

  /* Sem nenhum ponto: a grade continua e o aviso fica no MEIO DA ÁREA DE
     PLOTAGEM (não do cartão inteiro, que inclui os números do eixo Y). */
  function vazio(texto, box) {
    var pos =
      "left:" + (box.left / box.w) * 100 + "%;right:" + (1 - box.right / box.w) * 100 + "%;" +
      "top:" + (box.top / box.h) * 100 + "%;bottom:" + (1 - box.bottom / box.h) * 100 + "%";
    return svgDe(box, "") +
      '<div class="rel-chart-vazio" style="' + pos + '"><p class="rel-chart-vazio__texto">' + escapeHtml(texto) + "</p></div>";
  }

  /* Rótulos do eixo X, cada um exatamente embaixo do seu ponto (linha) ou
     da sua barra. indices[i] = posição do rótulo i entre os n pontos. */
  var EIXOS_X = [
    { id: "relChart1X", box: "desktop", tipo: "linha" },
    { id: "relChart2X", box: "desktop", tipo: "barra" },
    { id: "mRelChart1X", box: "mobile", tipo: "linha" },
    { id: "mRelChart2X", box: "mobile", tipo: "barra" },
  ];
  function setXLabels(labels, destaque, indices, n) {
    EIXOS_X.forEach(function (eixo) {
      var el = document.getElementById(eixo.id);
      if (!el) return;
      var box = CHART_BOXES[eixo.box];
      el.style.left = (box.left / box.w) * 100 + "%";
      el.style.right = (1 - box.right / box.w) * 100 + "%";
      el.style.top = ((box.bottom + 0.6) / box.h) * 100 + "%";
      el.innerHTML = labels
        .map(function (t, i) {
          var f = eixo.tipo === "linha" ? fracaoLinha(indices[i], n) : fracaoBarra(indices[i], n);
          return '<span style="left:' + (f * 100).toFixed(2) + '%"' + (i === destaque ? ' class="is-highlight"' : "") + ">" + escapeHtml(t) + "</span>";
        })
        .join("");
    });
  }

  function setText(ids, texto) {
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = texto;
    });
  }

  function num1(v) {
    return String(Math.round(Number(v) * 10) / 10).replace(".", ",");
  }

  function renderCharts(saude, umidade, dicasS, dicasU, msgVazioS, msgVazioU, ligarLacunas) {
    var temS = saude.some(temNum);
    var temU = umidade.some(temNum);
    var d = CHART_BOXES.desktop;
    var m = CHART_BOXES.mobile;
    document.getElementById("relChart1Data").innerHTML = temS ? buildLineSvg(saude, dicasS, d, ligarLacunas) : vazio(msgVazioS, d);
    document.getElementById("mRelChart1Data").innerHTML = temS ? buildLineSvg(saude, dicasS, m, ligarLacunas) : vazio(msgVazioS, m);
    document.getElementById("relChart2Data").innerHTML = temU ? buildBarSvg(umidade, dicasU, d) : vazio(msgVazioU, d);
    document.getElementById("mRelChart2Data").innerHTML = temU ? buildBarSvg(umidade, dicasU, m) : vazio(msgVazioU, m);
  }

  // Intervalo da semana atual (segunda a domingo, como no eixo dos gráficos),
  // ex.: "15 - 21 de setembro" ou "28 de set. - 4 de out." quando cruza o mês.
  function weekRangeLabel() {
    var now = new Date();
    var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    var sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    var month = function (d, style) { return d.toLocaleDateString("pt-BR", { month: style }); };
    return monday.getMonth() === sunday.getMonth()
      ? monday.getDate() + " - " + sunday.getDate() + " de " + month(sunday, "long")
      : monday.getDate() + " de " + month(monday, "short").replace(".", "") + ". - " +
        sunday.getDate() + " de " + month(sunday, "short").replace(".", "") + ".";
  }

  /* Linha de resumo embaixo do subtítulo: "Saúde 75% · Umidade 52% · 21 °C ·
     Luz 12 h · UV 30 min". Só o que existe. */
  function resumoTexto(r) {
    if (!r) return "";
    var partes = [];
    if (temNum(r.saude_pct)) partes.push("Saúde " + r.saude_pct + "%");
    if (temNum(r.umidade)) partes.push("Umidade " + Math.round(r.umidade) + "%");
    if (temNum(r.temp)) partes.push(num1(r.temp) + " °C");
    if (temNum(r.luz_h)) partes.push("Luz " + num1(r.luz_h) + " h");
    if (temNum(r.uv_min)) partes.push("UV " + Math.round(r.uv_min) + " min");
    return partes.join(" · ");
  }

  // ---- estado da tela: período e estação ----
  var relatorios = [];     // GET /reports/weekly (todas as estações)
  var modo = "semana";     // "semana" | "dia"
  var estacaoId = null;

  function relatorioDaEstacao() {
    return relatorios.filter(function (r) { return String(r.station_id) === String(estacaoId); })[0] || relatorios[0] || null;
  }

  function renderSemana() {
    var rep = relatorioDaEstacao();
    var dias = rep && rep.dias ? rep.dias : [];
    var saude = dias.map(function (d) { return d.futuro ? null : d.saude_pct; });
    var umid = dias.map(function (d) { return d.futuro ? null : d.umidade_media; });
    var dicasS = dias.map(function (d) {
      return d.label + ": " + (temNum(d.saude_pct) ? d.saude_pct + "% saudável (" + d.fotos_analisadas + " fotos analisadas)" : "sem fotos analisadas");
    });
    var dicasU = dias.map(function (d) {
      return d.label + ": umidade média " + (temNum(d.umidade_media) ? Math.round(d.umidade_media) + "%" : "—") +
        (temNum(d.temp_media) ? " · " + num1(d.temp_media) + " °C" : "");
    });
    var hojeIdx = -1;
    dias.forEach(function (d, i) { if (!d.futuro) hojeIdx = i; });
    setXLabels(["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"], hojeIdx, [0, 1, 2, 3, 4, 5, 6], 7);
    setText(["relTitle", "mRelTitle"], "Relatório semanal");
    setText(["relSubtitle", "mRelSubtitle"], weekRangeLabel() + (rep ? " · " + rep.station_name : ""));

    // Médias da semana para o resumo (só dias com dado).
    var media = function (campo) {
      var v = dias.map(function (d) { return d[campo]; }).filter(temNum).map(Number);
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
    };
    // Saúde da semana: % de TODAS as fotos analisadas, não média dos dias.
    var tot = 0;
    var boas = 0;
    dias.forEach(function (d) {
      if (temNum(d.saude_pct) && d.fotos_analisadas) {
        tot += d.fotos_analisadas;
        boas += (d.saude_pct / 100) * d.fotos_analisadas;
      }
    });
    var resumo = resumoTexto({
      saude_pct: tot ? Math.round((100 * boas) / tot) : null,
      umidade: media("umidade_media"),
      temp: media("temp_media"),
      luz_h: media("luz_h"),
      uv_min: media("uv_min"),
    });
    setText(["relResumo", "mRelResumo"], resumo ? "Média da semana: " + resumo : "");

    renderCharts(saude, umid, dicasS, dicasU,
      "Nenhuma foto analisada nesta semana ainda.",
      "Nenhuma leitura de umidade nesta semana ainda.");
  }

  async function renderDia() {
    setText(["relTitle", "mRelTitle"], "Relatório de hoje");
    if (estacaoId == null) { renderCharts([], [], [], [], "Nenhuma estação cadastrada.", "Nenhuma estação cadastrada."); return; }
    var hoje = new Date().toLocaleDateString("pt-BR", { day: "numeric", month: "long" });
    var rep;
    try {
      rep = await GrowAI.getDailyReport(estacaoId);
    } catch (e) {
      renderCharts([], [], [], [], "Não foi possível carregar.", "Não foi possível carregar.");
      return;
    }
    if (modo !== "dia") return; // trocou de aba enquanto carregava
    setText(["relSubtitle", "mRelSubtitle"], "Hoje, " + hoje + " · " + rep.station_name);
    var horas = rep.horas || [];
    var saude = horas.map(function (h) { return h.futuro ? null : h.saude_pct; });
    var umid = horas.map(function (h) { return h.futuro ? null : h.umidade; });
    var dicasS = horas.map(function (h) {
      return h.hora + "h: " + (temNum(h.saude_pct) ? h.saude_pct + "% saudável (" + h.fotos_analisadas + " fotos)" : "sem foto analisada");
    });
    var dicasU = horas.map(function (h) {
      return h.hora + "h: umidade " + (temNum(h.umidade) ? Math.round(h.umidade) + "%" : "—") + (temNum(h.temp) ? " · " + num1(h.temp) + " °C" : "");
    });
    // 24 pontos; 7 rótulos nas horas que caem embaixo deles.
    var horaAgora = new Date().getHours();
    var rotulos = [0, 4, 8, 12, 15, 19, 23];
    var destaque = -1;
    rotulos.forEach(function (h, i) { if (h <= horaAgora) destaque = i; });
    setXLabels(rotulos.map(function (h) { return h + "h"; }), destaque, rotulos, 24);

    var r = rep.resumo;
    var resumo = r ? resumoTexto({ saude_pct: r.saude_pct, umidade: r.umidade_media, temp: r.temp_media, luz_h: r.luz_h, uv_min: r.uv_min }) : "";
    setText(["relResumo", "mRelResumo"], resumo ? "Até agora: " + resumo : "");
    renderCharts(saude, umid, dicasS, dicasU,
      "Nenhuma foto analisada hoje ainda. A câmera fotografa às :00 e :30.",
      "Nenhuma leitura de umidade hoje ainda.", true);
  }

  function render() {
    document.querySelectorAll(".rel-controls__btn").forEach(function (b) {
      var ativo = b.dataset.modo === modo;
      b.classList.toggle("is-active", ativo);
      b.setAttribute("aria-selected", ativo ? "true" : "false");
    });
    if (modo === "dia") renderDia();
    else renderSemana();
  }

  function montarEstacoes() {
    ["relStation", "mRelStation"].forEach(function (id) {
      var sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = relatorios
        .map(function (r) {
          return '<option value="' + r.station_id + '">' + escapeHtml(r.station_name + " · " + r.plant) + "</option>";
        })
        .join("");
      sel.value = String(estacaoId);
      // Uma estação só: o seletor não serve para nada e fica escondido.
      sel.hidden = relatorios.length < 2;
    });
    // No celular o seletor ocupa a direita do subtítulo: o texto encolhe.
    document.body.classList.toggle("rel-varias-estacoes", relatorios.length > 1);
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest(".rel-controls__btn");
    if (!b || b.dataset.modo === modo) return;
    modo = b.dataset.modo;
    render();
  });
  document.addEventListener("change", function (ev) {
    if (ev.target.id !== "relStation" && ev.target.id !== "mRelStation") return;
    estacaoId = ev.target.value;
    montarEstacoes();
    render();
    carregarAgua();
  });

  // ---- suggestions ----
  var HEALTHY_THRESHOLD = 85;

  // Nome e unidade de cada campo da rotina, para o card nunca mostrar nome de
  // coluna ("water_interval_h"). Os mesmos rótulos do aviso de rotina
  // (js/station-modal.js) e do formulário da estação.
  var CAMPO = {
    light_hours: { nome: "Luz diária", un: " h" },
    humidity_target: { nome: "Umidade alvo", un: "%" },
    water_interval_h: { nome: "Rega a cada", un: " h" },
    temp_max: { nome: "Ventilar acima de", un: " °C" },
    vent_min_por_hora: { nome: "Ventilação", un: " min/h" },
    nutri_s: { nome: "Nutriente", un: " s/dia" },
    uv_min_dia: { nome: "Luz UV", un: " min/dia" },
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
        // Só campos que o app conhece: sugestões antigas ainda trazem ph_target,
        // que saiu do projeto.
        if (!CAMPO[k]) return false;
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

    // Água + diário no celular: logo abaixo do último card de sugestão.
    var mExtra = document.getElementById("mRelExtra");
    if (mExtra) {
      var fundoM = 0;
      ["mRelSuggestion1", "mRelSuggestion2", "mRelSuggestionsEmpty"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el.hidden) fundoM = Math.max(fundoM, el.offsetTop + el.offsetHeight);
      });
      if (fundoM) mExtra.style.top = fundoM + 34 + "px";
    }

    var pagina = document.getElementById("appRelatoriosPage");
    if (!pagina) return;
    if (alturaBaseDesktop === null) alturaBaseDesktop = pagina.offsetHeight;
    var fundo = 0;
    ["relSuggestion1", "relSuggestion2", "relSuggestionsEmpty"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.hidden) fundo = Math.max(fundo, el.offsetTop + el.offsetHeight);
    });
    // Água + diário no desktop: o mesmo, e a página cresce até o fim deles.
    var extra = document.getElementById("relExtra");
    if (extra && fundo) {
      extra.style.top = fundo + 80 + "px";
      fundo = extra.offsetTop + extra.offsetHeight;
    }
    pagina.style.height = Math.max(alturaBaseDesktop, fundo + 60) + "px";
  }

  // The mobile tab bar's `top` assumes both suggestion slots are visible;
  // with fewer (or none) that leaves a big gap, so it's repositioned right
  // after whatever actually ended up visible.
  function updateMobileTabbar() {
    encaixaCards();
    positionMobileTabbar({
      mobilePageId: "mAppRelatoriosPage",
      contentSelectors: [".m-rel-chart-card--2", "#mRelSuggestion1", "#mRelSuggestion2", "#mRelSuggestionsEmpty", "#mRelExtra"],
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
        carregarDiario();
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
      carregarDiario();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Aplicar sugestão";
      showToast(err.message, "error");
    }
  });


  /* =================================================================
     ÁGUA DA REGA + DIÁRIO DA IA
     As duas seções abaixo das sugestões. O mesmo HTML vai para o desktop
     (#relExtra) e para o celular (#mRelExtra); o CSS ajusta o tamanho.
     ================================================================= */
  var agua = null;          // GET /reports/agua da estação escolhida
  var aguaDias = 30;
  var diario = null;        // GET /reports/diario-ia
  var diarioFiltro = "todos";
  var diarioVisiveis = 6;

  function litrosTxt(v) {
    if (!temNum(v)) return "—";
    var n = Number(v);
    return (Math.abs(n) >= 100 ? Math.round(n) : num1(n)) + " L";
  }
  function dataCurta(iso) {
    return new Date(iso + (String(iso).length === 10 ? "T12:00:00" : "")).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
  }
  function quando(iso) {
    var d = new Date(iso);
    var min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "agora";
    if (min < 60) return "há " + min + " min";
    if (min < 24 * 60) return "há " + Math.round(min / 60) + " h";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "") +
      " · " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  // Barras do dia (água usada) e a linha tracejada do timer de referência.
  function aguaSvg(a) {
    var dias = a.dias || [];
    var n = dias.length || 1;
    var W = 300, H = 64, base = 58, topo = 6;
    var maxL = Math.max(1, a.rega_fixa ? dias.reduce(function (m, d) { return Math.max(m, d.litros || 0, d.litros_fixo || 0); }, 0) : 1);
    var larg = W / n;
    var barras = dias.map(function (d, i) {
      var x = i * larg + larg * 0.18;
      var w = larg * 0.64;
      if (!temNum(d.litros)) {
        return '<rect class="agua-g__sem" x="' + x.toFixed(2) + '" y="' + (base - 1.5) + '" width="' + w.toFixed(2) + '" height="1.5" rx="0.75"><title>' +
          escapeHtml(dataCurta(d.dia) + ": sem dado da placa") + "</title></rect>";
      }
      var h = Math.max(1.5, ((base - topo) * d.litros) / maxL);
      return '<rect class="agua-g__barra" x="' + x.toFixed(2) + '" y="' + (base - h).toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="1.2"><title>' +
        escapeHtml(dataCurta(d.dia) + ": " + litrosTxt(d.litros) + " (timer: " + litrosTxt(d.litros_fixo) + ")") + "</title></rect>";
    }).join("");
    var fixo = dias.filter(function (d) { return temNum(d.litros_fixo); })[0];
    var linha = fixo
      ? '<line class="agua-g__timer" x1="0" x2="' + W + '" y1="' + (base - ((base - topo) * fixo.litros_fixo) / maxL).toFixed(2) +
        '" y2="' + (base - ((base - topo) * fixo.litros_fixo) / maxL).toFixed(2) + '" />'
      : "";
    return '<svg class="agua-g" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Água usada por dia">' +
      '<line class="agua-g__base" x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" />' + barras + linha + "</svg>";
  }

  function aguaHtml() {
    var titulo = '<div class="rx-cab"><div><h2 class="rx-titulo">Água da rega</h2>' +
      '<p class="rx-sub">Rega pela umidade do solo × um timer comum' + (agua ? " · " + escapeHtml(agua.station_name) : "") + "</p></div>" +
      '<div class="rx-seg" role="tablist" aria-label="Período">' +
      [7, 30].map(function (d) {
        return '<button type="button" role="tab" class="rx-seg__btn' + (d === aguaDias ? " is-active" : "") + '" aria-selected="' + (d === aguaDias) +
          '" data-action="agua-dias" data-dias="' + d + '">' + d + " dias</button>";
      }).join("") + "</div></div>";
    if (!agua) return '<section class="rx-card">' + titulo + '<p class="rx-vazio">Carregando…</p></section>';
    if (agua.erro) return '<section class="rx-card">' + titulo + '<p class="rx-vazio">' + escapeHtml(agua.erro) + "</p></section>";

    var t = agua.total || {};
    if (!t.dias_com_dado) {
      return '<section class="rx-card">' + titulo +
        '<p class="rx-vazio">A placa principal ainda não mandou o tempo de bomba nestes ' + aguaDias + " dias. Assim que ela regar, a conta aparece aqui.</p></section>";
    }
    var economizou = Number(t.economia_litros) >= 0;
    var kpis =
      '<div class="rx-kpis">' +
      '<div class="rx-kpi rx-kpi--destaque"><p class="rx-kpi__rotulo">' + (economizou ? "Economia" : "Gastou a mais") + "</p>" +
      '<p class="rx-kpi__valor">' + litrosTxt(Math.abs(t.economia_litros)) + "</p>" +
      '<p class="rx-kpi__nota">' + (temNum(t.economia_pct) ? Math.abs(t.economia_pct) + "% " + (economizou ? "a menos" : "a mais") + " que o timer" : "") + "</p></div>" +
      '<div class="rx-kpi"><p class="rx-kpi__rotulo">Rega por umidade</p><p class="rx-kpi__valor">' + litrosTxt(t.litros) + "</p>" +
      '<p class="rx-kpi__nota">bomba ligada ' + t.bomba_min + " min</p></div>" +
      '<div class="rx-kpi"><p class="rx-kpi__rotulo">Timer a cada ' + num1(agua.rega_fixa.intervalo_h) + " h</p><p class=\"rx-kpi__valor\">" + litrosTxt(t.litros_fixo) + "</p>" +
      '<p class="rx-kpi__nota">' + num1(agua.rega_fixa.regas_por_dia) + " regas/dia de " + num1(agua.rega_fixa.duracao_s / 60) + " min</p></div>" +
      "</div>";
    var dias = agua.dias || [];
    var grafico =
      '<div class="rx-grafico">' + aguaSvg(agua) +
      '<div class="rx-grafico__eixo"><span>' + (dias[0] ? dataCurta(dias[0].dia) : "") + '</span><span class="rx-grafico__leg"><i class="rx-leg rx-leg--barra"></i>água usada <i class="rx-leg rx-leg--timer"></i>timer</span><span>' +
      (dias.length ? dataCurta(dias[dias.length - 1].dia) : "") + "</span></div></div>";
    var nota =
      '<p class="rx-nota">Estimativa. Vazão ' + (agua.vazao_informada ? "informada" : "de referência") + " de " + num1(agua.vazao_lpm) + " L/min" +
      " × tempo real de bomba registrado pela placa. O timer usa o \"Rega a cada\" da estação com a mesma duração de cada rega da placa. " +
      t.dias_com_dado + " de " + dias.length + " dias com dado da placa; os outros ficam fora da conta.</p>";
    return '<section class="rx-card">' + titulo + kpis + grafico + nota + "</section>";
  }

  var TIPOS_DIARIO = [
    { id: "todos", rotulo: "Tudo" },
    { id: "analise", rotulo: "Análises" },
    { id: "ajuste", rotulo: "Rotina" },
    { id: "luz", rotulo: "Luz" },
  ];
  var SAUDE_TXT = { saudavel: "saudável", atencao: "precisa de atenção" };
  var LUZ_TXT = { pouca: "pouca luz natural", boa: "luz natural boa", muita: "muita luz natural", incerto: "luz incerta" };

  function itemDiarioHtml(e, m) {
    var lugar = escapeHtml(e.station_name || e.plant || "Estação");
    var titulo, detalhe = "", extra = "", acao = "", classe = e.tipo;
    if (e.tipo === "analise") {
      var praga = e.pragas === "sim";
      classe = praga ? "praga" : e.health_status === "atencao" ? "atencao" : "analise";
      titulo = praga ? "Encontrou praga em " + lugar : "Analisou a foto de " + lugar + ": " + (SAUDE_TXT[e.health_status] || "—");
      detalhe = e.analysis_text || "";
      var tags = [];
      if (praga) tags.push("Praga: " + (e.pragas_descricao || "detectada"));
      else if (e.pragas === "nao") tags.push("sem pragas");
      if (LUZ_TXT[e.luz_nivel]) tags.push(LUZ_TXT[e.luz_nivel]);
      if (e.modelo) tags.push(e.modelo);
      if (tags.length) extra = '<p class="dx-tags">' + tags.map(function (t) { return "<span>" + escapeHtml(t) + "</span>"; }).join("") + "</p>";
    } else if (e.tipo === "ajuste" || e.tipo === "sugestao") {
      var deRotina = e.origem === "ia_rotina";
      if (e.tipo === "ajuste") {
        titulo = e.desfeita_em
          ? "Ajuste desfeito em " + lugar
          : deRotina
            ? "Corrigiu a rotina que você salvou em " + lugar
            : "Ajustou a rotina de " + lugar + " pelo que viu na foto";
        classe = e.desfeita_em ? "desfeito" : "ajuste";
        acao = e.desfeita_em ? "" : '<button type="button" class="dx-btn" data-action="diario-undo" data-id="' + e.id + '">Desfazer ajuste</button>';
      } else {
        titulo = "Sugeriu mudar a rotina de " + lugar + (e.applied ? " · aplicada" : "");
        classe = "sugestao";
        acao = e.applied || !e.config ? "" : '<button type="button" class="dx-btn" data-action="diario-apply" data-id="' + e.id + '">Aplicar sugestão</button>';
      }
      detalhe = e.message || "";
      extra = mudancasHtml(e, !m);
    } else if (e.tipo === "luz") {
      titulo = e.titulo || "Luz de cultivo";
      classe = e.apagou ? "luz" : "luz-acesa";
      detalhe = e.mensagem || "";
    }
    return (
      '<li class="dx-item dx-item--' + classe + '">' +
      '<span class="dx-ponto" aria-hidden="true"></span>' +
      '<div class="dx-corpo">' +
      '<div class="dx-linha"><p class="dx-titulo">' + titulo + '</p><time class="dx-quando" datetime="' + escapeHtml(e.em) + '">' + quando(e.em) + "</time></div>" +
      (detalhe ? '<p class="dx-detalhe">' + escapeHtml(detalhe) + "</p>" : "") +
      extra + acao +
      "</div></li>"
    );
  }

  function diarioHtml(m) {
    var cab = '<div class="rx-cab"><div><h2 class="rx-titulo">Diário da IA</h2>' +
      '<p class="rx-sub">Tudo o que a IA viu e decidiu na sua horta, com o motivo de cada coisa</p></div></div>';
    if (!diario) return '<section class="rx-card">' + cab + '<p class="rx-vazio">Carregando…</p></section>';
    if (diario.erro) return '<section class="rx-card">' + cab + '<p class="rx-vazio">' + escapeHtml(diario.erro) + "</p></section>";
    var r = diario.resumo || {};
    var resumo =
      '<div class="dx-resumo"><span class="dx-resumo__titulo">Últimos 7 dias</span>' +
      '<span class="dx-chip"><b>' + (r.analises || 0) + "</b> análises de foto</span>" +
      '<span class="dx-chip' + (r.pragas ? " dx-chip--alerta" : "") + '"><b>' + (r.pragas || 0) + "</b> pragas</span>" +
      '<span class="dx-chip"><b>' + (r.ajustes || 0) + "</b> ajustes de rotina</span>" +
      '<span class="dx-chip"><b>' + (r.luz || 0) + "</b> decisões de luz</span></div>";
    var filtros =
      '<div class="rx-seg rx-seg--filtro" role="tablist" aria-label="Filtrar o diário">' +
      TIPOS_DIARIO.map(function (t) {
        return '<button type="button" role="tab" class="rx-seg__btn' + (t.id === diarioFiltro ? " is-active" : "") + '" aria-selected="' + (t.id === diarioFiltro) +
          '" data-action="diario-filtro" data-filtro="' + t.id + '">' + t.rotulo + "</button>";
      }).join("") + "</div>";
    var lista = (diario.eventos || []).filter(function (e) {
      if (diarioFiltro === "todos") return true;
      if (diarioFiltro === "ajuste") return e.tipo === "ajuste" || e.tipo === "sugestao";
      return e.tipo === diarioFiltro;
    });
    var corpo = lista.length
      ? '<ol class="dx-lista">' + lista.slice(0, diarioVisiveis).map(function (e) { return itemDiarioHtml(e, m); }).join("") + "</ol>" +
        (lista.length > diarioVisiveis ? '<button type="button" class="dx-mais" data-action="diario-mais">Mostrar mais (' + (lista.length - diarioVisiveis) + ")</button>" : "")
      : '<p class="rx-vazio">' + (diarioFiltro === "todos" ? "A IA ainda não tomou nenhuma decisão por aqui." : "Nada deste tipo ainda.") + "</p>";
    return '<section class="rx-card">' + cab + resumo + filtros + corpo + "</section>";
  }

  function renderExtras() {
    var d = document.getElementById("relExtra");
    var m = document.getElementById("mRelExtra");
    if (d) d.innerHTML = aguaHtml() + diarioHtml(false);
    if (m) m.innerHTML = aguaHtml() + diarioHtml(true);
    updateMobileTabbar();
  }

  function carregarAgua() {
    if (estacaoId == null) { agua = { erro: "Cadastre uma estação para ver a água da rega." }; renderExtras(); return; }
    var pedidoPara = String(estacaoId) + "/" + aguaDias;
    agua = null;
    renderExtras();
    GrowAI.getAgua(estacaoId, aguaDias).then(
      function (a) { if (String(estacaoId) + "/" + aguaDias === pedidoPara) { agua = a; renderExtras(); } },
      function (e) { agua = { erro: e.message || "Não foi possível calcular a água agora." }; renderExtras(); }
    );
  }

  function carregarDiario() {
    return GrowAI.getDiarioIa().then(
      function (d) { diario = d; renderExtras(); },
      function (e) { diario = { erro: e.message || "Não foi possível carregar o diário agora." }; renderExtras(); }
    );
  }

  document.addEventListener("click", async function (ev) {
    var b = ev.target.closest("[data-action]");
    if (!b) return;
    var acao = b.dataset.action;
    if (acao === "agua-dias") {
      if (Number(b.dataset.dias) === aguaDias) return;
      aguaDias = Number(b.dataset.dias);
      carregarAgua();
    } else if (acao === "exportar-pdf") {
      // Relatório no papel timbrado, da estação escolhida aqui.
      window.open("relatorio.html" + (estacaoId != null ? "?station_id=" + encodeURIComponent(estacaoId) : ""), "_blank");
    } else if (acao === "diario-filtro") {
      diarioFiltro = b.dataset.filtro;
      diarioVisiveis = 6;
      renderExtras();
    } else if (acao === "diario-mais") {
      diarioVisiveis += 10;
      renderExtras();
    } else if (acao === "diario-undo" || acao === "diario-apply") {
      b.disabled = true;
      b.textContent = acao === "diario-undo" ? "Desfazendo..." : "Aplicando...";
      try {
        if (acao === "diario-undo") await GrowAI.undoSuggestion(b.dataset.id);
        else await GrowAI.applySuggestion(b.dataset.id);
        if (window.showToast) showToast(acao === "diario-undo" ? "Rotina voltou aos valores anteriores." : "Sugestão aplicada.", "success");
        // Os cards de sugestão lá em cima mostram a mesma coisa: atualiza os dois.
        suggestionsCache = await GrowAI.getSuggestions().catch(function () { return suggestionsCache; });
        renderSuggestions(suggestionsCache);
        await carregarDiario();
      } catch (err) {
        b.disabled = false;
        b.textContent = acao === "diario-undo" ? "Desfazer ajuste" : "Aplicar sugestão";
        if (window.showToast) showToast(err.message, "error");
      }
    }
  });

  async function load() {
    GrowAI.syncProfile();
    try {
      relatorios = await GrowAI.getWeeklyReports();
    } catch (err) {
      relatorios = [];
    }
    estacaoId = relatorios[0] ? relatorios[0].station_id : null;
    montarEstacoes();
    render();

    try {
      suggestionsCache = await GrowAI.getSuggestions();
      renderSuggestions(suggestionsCache);
    } catch (err) {
      // leave the two suggestion slots hidden on failure
    }

    updateMobileTabbar();
    carregarAgua();
    carregarDiario();
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
