(function () {
  "use strict";

  // Relatório de cultivo em PDF, no papel timbrado da TrackLink.
  //
  // Busca os dados reais da estação (mesmas rotas das telas do app), monta o
  // texto em blocos e distribui os blocos pelas folhas A4 medindo a altura de
  // cada um: nada é cortado no meio entre uma página e outra, e um título
  // nunca fica sozinho no pé da folha (ele vai junto com o primeiro bloco da
  // seção). O PDF sai do "Salvar como PDF" do navegador.

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  var el = {
    folhas: document.getElementById("rpFolhas"),
    medidor: document.getElementById("rpMedidor"),
    status: document.getElementById("rpStatus"),
    pdf: document.getElementById("rpPdf"),
    dica: document.getElementById("rpDica"),
    estacao: document.getElementById("rpEstacao"),
  };

  var CAMPO = {
    light_hours: { nome: "Luz diária", un: " h" },
    humidity_target: { nome: "Umidade alvo", un: "%" },
    water_interval_h: { nome: "Rega a cada", un: " h" },
    temp_max: { nome: "Ventilar acima de", un: " °C" },
    vent_min_por_hora: { nome: "Ventilação", un: " min/h" },
    nutri_s: { nome: "Nutriente", un: " s/dia" },
    uv_min_dia: { nome: "Luz UV", un: " min/dia" },
  };
  var SAUDE = { saudavel: ["Saudável", "ok"], atencao: ["Atenção", "atencao"], indefinido: ["Sem análise", "sem"] };

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function tem(v) { return v !== null && v !== undefined && v !== "" && isFinite(Number(v)); }
  function n1(v) { return String(Math.round(Number(v) * 10) / 10).replace(".", ","); }
  function inteiro(v) { return String(Math.round(Number(v))); }
  function data(iso, opts) {
    return new Date(String(iso).length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("pt-BR", opts || { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  function dataHora(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function media(lista, campo) {
    var v = lista.map(function (d) { return d[campo]; }).filter(tem).map(Number);
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }
  function valorCampo(k, v) {
    if (v === undefined || v === null || v === "") return "—";
    return (isFinite(Number(v)) ? n1(v) : String(v).slice(0, 5)) + ((CAMPO[k] && CAMPO[k].un) || "");
  }

  // ------------------------------------------------------------ blocos
  function blocoCapa(st, semana) {
    var dias = (semana && semana.dias) || [];
    var periodo = dias.length ? data(dias[0].dia, { day: "2-digit", month: "long" }) + " a " + data(dias[dias.length - 1].dia, { day: "2-digit", month: "long", year: "numeric" }) : "semana atual";
    return (
      '<div class="rp-capa">' +
      '<p class="rp-capa__eyebrow">Relatório de cultivo</p>' +
      '<h1 class="rp-capa__titulo">' + esc(st.name) + " · " + esc(st.plant) + "</h1>" +
      '<p class="rp-capa__sub">' + (st.tag ? "Finalidade: " + esc(st.tag) + ". " : "") +
      "Horta semi-hidropônica automatizada GrowAI, monitorada por sensores e analisada por inteligência artificial.</p>" +
      '<div class="rp-capa__meta"><span>Período: <b>' + esc(periodo) + "</b></span>" +
      "<span>Gerado em: <b>" + esc(new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })) + "</b></span>" +
      "<span>Sistema: <b>GrowAI / TrackLink</b></span></div>" +
      "</div>"
    );
  }

  function secaoResumo(st, semana) {
    var dias = ((semana && semana.dias) || []).filter(function (d) { return !d.futuro; });
    var fotos = dias.reduce(function (a, d) { return a + (d.fotos_analisadas || 0); }, 0);
    var atencao = dias.reduce(function (a, d) { return a + (d.fotos_atencao || 0); }, 0);
    var saude = null;
    var tot = 0, boas = 0;
    dias.forEach(function (d) {
      if (tem(d.saude_pct) && d.fotos_analisadas) { tot += d.fotos_analisadas; boas += (d.saude_pct / 100) * d.fotos_analisadas; }
    });
    if (tot) saude = Math.round((100 * boas) / tot);
    var umid = media(dias, "umidade_media");
    var temp = media(dias, "temp_media");
    var luz = media(dias, "luz_h");
    var uv = media(dias, "uv_min");

    var frases = [];
    // "Estação 1" já diz que é estação: não vira "da estação Estação 1".
    var onde = /^esta[cç][aã]o/i.test(String(st.name || "")) ? esc(st.name) : "a estação " + esc(st.name);
    frases.push(
      "Este relatório reúne o acompanhamento semanal d" + (onde.charAt(0) === "a" && onde.indexOf("a estação") === 0 ? onde : "a " + onde) + ", com " + esc(st.plant) +
      (st.tag ? " cultivada com a finalidade " + esc(String(st.tag).toLowerCase()) : "") + ", ao longo da semana."
    );
    if (fotos) {
      frases.push(
        "A câmera da horta fotografou a planta e a inteligência artificial analisou " + fotos + " foto" + (fotos > 1 ? "s" : "") +
        "; " + saude + "% delas foram consideradas saudáveis" + (atencao ? " e " + atencao + " pediram atenção" : "") + "."
      );
    } else {
      frases.push("Nesta semana nenhuma foto foi analisada pela inteligência artificial, então não há índice de saúde para o período.");
    }
    var amb = [];
    if (umid !== null) amb.push("a umidade média do solo ficou em " + inteiro(umid) + "%");
    if (temp !== null) amb.push("a temperatura média do ar em " + n1(temp) + " °C");
    if (luz !== null) amb.push("a luz de cultivo ficou acesa em média " + n1(luz) + " h por dia");
    if (uv !== null) amb.push("a luz UV, " + inteiro(uv) + " min por dia");
    if (amb.length) frases.push("No ambiente, " + amb.join(", ").replace(/, ([^,]*)$/, " e $1") + ".");
    else frases.push("A placa principal não enviou leituras dos sensores nesta semana.");

    var k = function (rot, val, obs, destaque) {
      return '<div class="rp-kpi' + (destaque ? " rp-kpi--destaque" : "") + '"><p class="rp-kpi__rot">' + rot + '</p><p class="rp-kpi__val">' + val + "</p>" +
        (obs ? '<p class="rp-kpi__obs">' + obs + "</p>" : "") + "</div>";
    };
    return [
      '<h2 class="rp-h2">1 - Resumo da semana</h2><p class="rp-p">' + frases.join(" ") + "</p>",
      '<div class="rp-kpis">' +
        k("Saúde", saude !== null ? saude + "%" : "—", fotos ? fotos + " fotos analisadas" : "sem análise", true) +
        k("Umidade do solo", umid !== null ? inteiro(umid) + "%" : "—", "média") +
        k("Temperatura", temp !== null ? n1(temp) + " °C" : "—", "média do ar") +
        k("Luz de cultivo", luz !== null ? n1(luz) + " h" : "—", "por dia") +
        k("Luz UV", uv !== null ? inteiro(uv) + " min" : "—", "por dia") +
        "</div>",
    ];
  }

  function secaoDias(semana) {
    var dias = (semana && semana.dias) || [];
    var cel = function (v, fmt) { return tem(v) ? fmt(v) : '<span class="rp-vazio">—</span>'; };
    var linhas = dias.map(function (d) {
      var tempTxt = tem(d.temp_media)
        ? n1(d.temp_media) + " °C" + (tem(d.temp_min) && tem(d.temp_max) ? ' <span class="rp-vazio">(' + n1(d.temp_min) + "–" + n1(d.temp_max) + ")</span>" : "")
        : '<span class="rp-vazio">—</span>';
      return "<tr><td>" + esc(d.label) + " " + data(d.dia, { day: "2-digit", month: "2-digit" }) + "</td>" +
        '<td class="num">' + cel(d.saude_pct, function (v) { return v + "%"; }) + "</td>" +
        '<td class="num">' + (d.fotos_analisadas || '<span class="rp-vazio">0</span>') + "</td>" +
        '<td class="num">' + cel(d.umidade_media, function (v) { return inteiro(v) + "%"; }) + "</td>" +
        '<td class="num">' + tempTxt + "</td>" +
        '<td class="num">' + cel(d.luz_h, function (v) { return n1(v) + " h"; }) + "</td>" +
        '<td class="num">' + cel(d.uv_min, function (v) { return inteiro(v) + " min"; }) + "</td></tr>";
    }).join("");
    return [
      '<h2 class="rp-h2">2 - Saúde e ambiente dia a dia</h2>' +
        '<p class="rp-p">Saúde é a porcentagem das fotos analisadas no dia que a inteligência artificial classificou como saudáveis. ' +
        "Umidade e temperatura são médias das leituras da placa; luz e UV são o tempo que cada uma ficou ligada.</p>" +
        '<table class="rp-tabela"><thead><tr><th>Dia</th><th class="num">Saúde</th><th class="num">Fotos</th><th class="num">Umidade</th>' +
        '<th class="num">Temperatura</th><th class="num">Luz</th><th class="num">UV</th></tr></thead><tbody>' + linhas + "</tbody></table>",
    ];
  }

  function secaoAgua(agua) {
    var titulo = '<h2 class="rp-h2">3 - Água da rega (últimos 30 dias)</h2>';
    if (!agua || agua.erro) return [titulo + '<p class="rp-p">Não foi possível calcular o uso de água agora.</p>'];
    var t = agua.total || {};
    if (!t.dias_com_dado) {
      return [titulo + '<p class="rp-p">A placa principal ainda não registrou o tempo de bomba neste período, então o uso de água não pode ser calculado.</p>'];
    }
    var economizou = Number(t.economia_litros) >= 0;
    var texto =
      "A irrigação do GrowAI é acionada pela umidade do solo, e não por horário. Nos " + t.dias_com_dado + " dia" + (t.dias_com_dado > 1 ? "s" : "") +
      " com registro, a bomba ficou ligada " + t.bomba_min + " min, o que corresponde a cerca de " + n1(t.litros) + " L. " +
      "Um timer comum, regando a cada " + n1(agua.rega_fixa.intervalo_h) + " h pelo mesmo tempo de cada rega, gastaria " + n1(t.litros_fixo) + " L: " +
      (economizou
        ? "uma economia estimada de " + n1(t.economia_litros) + " L (" + t.economia_pct + "%)."
        : "neste período a rega por umidade gastou " + n1(Math.abs(t.economia_litros)) + " L a mais, porque o solo pediu mais água que a rotina fixa daria.");

    var dias = agua.dias || [];
    var max = Math.max(1, dias.reduce(function (m, d) { return Math.max(m, d.litros || 0, d.litros_fixo || 0); }, 0));
    var W = 300, H = 60, base = 56;
    var larg = W / Math.max(1, dias.length);
    var barras = dias.map(function (d, i) {
      if (!tem(d.litros)) return '<rect x="' + (i * larg + larg * 0.2).toFixed(2) + '" y="' + (base - 1) + '" width="' + (larg * 0.6).toFixed(2) + '" height="1" fill="#cfdcd6" />';
      var h = Math.max(1.2, ((base - 4) * d.litros) / max);
      return '<rect x="' + (i * larg + larg * 0.2).toFixed(2) + '" y="' + (base - h).toFixed(2) + '" width="' + (larg * 0.6).toFixed(2) + '" height="' + h.toFixed(2) + '" rx="0.8" fill="#4c9a8f" />';
    }).join("");
    var fixo = dias.filter(function (d) { return tem(d.litros_fixo); })[0];
    var yFixo = fixo ? (base - ((base - 4) * fixo.litros_fixo) / max).toFixed(2) : null;
    var grafico =
      '<div class="rp-grafico"><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" stroke="#9fb7af" stroke-width="0.4" />' + barras +
      (yFixo ? '<line x1="0" x2="' + W + '" y1="' + yFixo + '" y2="' + yFixo + '" stroke="#3f8a5e" stroke-width="0.8" stroke-dasharray="3 2" vector-effect="non-scaling-stroke" />' : "") +
      "</svg>" +
      '<div class="rp-grafico__leg"><span>' + (dias[0] ? data(dias[0].dia, { day: "2-digit", month: "short" }) : "") + "</span>" +
      '<span><i style="background:#4c9a8f"></i>água usada por dia<i style="background:#3f8a5e;height:0.5mm"></i>timer de referência</span>' +
      "<span>" + (dias.length ? data(dias[dias.length - 1].dia, { day: "2-digit", month: "short" }) : "") + "</span></div></div>";
    var kpi = function (rot, val, obs, destaque) {
      return '<div class="rp-kpi' + (destaque ? " rp-kpi--destaque" : "") + '"><p class="rp-kpi__rot">' + rot + '</p><p class="rp-kpi__val">' + val + '</p><p class="rp-kpi__obs">' + obs + "</p></div>";
    };
    return [
      titulo + '<p class="rp-p">' + texto + "</p>",
      '<div class="rp-kpis rp-kpis--3">' +
        kpi(economizou ? "Economia" : "Gasto a mais", n1(Math.abs(t.economia_litros)) + " L", (tem(t.economia_pct) ? Math.abs(t.economia_pct) + "% " : "") + "em relação ao timer", true) +
        kpi("Rega por umidade", n1(t.litros) + " L", "bomba ligada " + t.bomba_min + " min") +
        kpi("Timer a cada " + n1(agua.rega_fixa.intervalo_h) + " h", n1(t.litros_fixo) + " L", n1(agua.rega_fixa.regas_por_dia) + " regas por dia") +
        "</div>" + grafico,
      '<p class="rp-nota">Estimativa: vazão ' + (agua.vazao_informada ? "informada" : "de referência") + " de " + n1(agua.vazao_lpm) +
        " L/min multiplicada pelo tempo real de bomba registrado pela placa. Dias sem registro da placa ficam fora da conta.</p>",
    ];
  }

  function textoEvento(e) {
    var lugar = esc(e.station_name || "");
    if (e.tipo === "analise") {
      var praga = e.pragas === "sim";
      var t = praga ? "Praga detectada na foto" : "Foto analisada: " + (e.health_status === "atencao" ? "precisa de atenção" : "saudável");
      var det = (e.analysis_text || "") + (praga && e.pragas_descricao ? " Praga: " + e.pragas_descricao + "." : "");
      return { cor: praga ? "#d64545" : e.health_status === "atencao" ? "#d9a520" : "#4c9a8f", titulo: t, texto: det };
    }
    if (e.tipo === "ajuste" || e.tipo === "sugestao") {
      var mud = e.config ? Object.keys(e.config).filter(function (k) { return CAMPO[k]; }).map(function (k) {
        var de = e.config_anterior && e.config_anterior[k];
        return esc(CAMPO[k].nome) + ": " + (de !== undefined && de !== null ? "<s>" + esc(valorCampo(k, de)) + "</s> → " : "") + "<b>" + esc(valorCampo(k, e.config[k])) + "</b>";
      }).join(" · ") : "";
      var tit = e.tipo === "ajuste"
        ? (e.desfeita_em ? "Ajuste de rotina desfeito pela pessoa" : e.origem === "ia_rotina" ? "IA corrigiu a rotina salva" : "IA ajustou a rotina pela foto")
        : "IA sugeriu mudar a rotina" + (e.applied ? " (aplicada)" : "");
      return { cor: "#3f8a5e", titulo: tit, texto: e.message || "", mudancas: mud };
    }
    return { cor: "#d9a520", titulo: e.titulo || "Decisão sobre a luz", texto: e.mensagem || "", lugar: lugar };
  }

  function secaoDiario(diario, stationId) {
    var eventos = ((diario && diario.eventos) || []).filter(function (e) {
      return String(e.station_id) === String(stationId) && Date.now() - new Date(e.em).getTime() < 30 * 86400000;
    }).slice(0, 10);
    var titulo = '<h2 class="rp-h2">4 - Decisões da inteligência artificial</h2>' +
      '<p class="rp-p">Tudo o que a IA viu e decidiu nesta estação nos últimos 30 dias, com o motivo de cada decisão. ' +
      "Ajustes de rotina feitos pela IA podem ser desfeitos pela pessoa no aplicativo.</p>";
    if (!eventos.length) return [titulo + '<p class="rp-p">Nenhuma decisão da IA registrada neste período.</p>'];
    var itens = eventos.map(function (e) {
      var t = textoEvento(e);
      return '<div class="rp-evento" style="--rp-cor:' + t.cor + '"><span class="rp-evento__ponto"></span><div>' +
        '<p class="rp-evento__titulo">' + esc(t.titulo) + "</p>" +
        (t.texto ? '<p class="rp-evento__texto">' + esc(t.texto) + "</p>" : "") +
        (t.mudancas ? '<p class="rp-evento__mudancas">' + t.mudancas + "</p>" : "") +
        '</div><span class="rp-evento__quando">' + esc(dataHora(e.em)) + "</span></div>";
    });
    // Título junto do primeiro evento; os outros entram um a um.
    return [titulo + itens[0]].concat(itens.slice(1));
  }

  function secaoFotos(fotos) {
    var titulo = '<h2 class="rp-h2">5 - Registro fotográfico</h2>';
    if (!fotos.length) return [titulo + '<p class="rp-p">A câmera desta estação ainda não enviou fotos.</p>'];
    var figs = fotos.map(function (f) {
      var s = SAUDE[f.health_status] || SAUDE.indefinido;
      var cls = f.pragas === "sim" ? "praga" : s[1];
      return '<figure class="rp-foto"><img src="' + esc(f.image_url) + '" alt="" />' +
        "<figcaption><b>" + esc(dataHora(f.captured_at)) + '</b> <span class="rp-selo rp-selo--' + cls + '">' +
        (f.pragas === "sim" ? "Praga" : s[0]) + "</span>" +
        (f.analysis_text && f.health_status !== "indefinido" ? "<br />" + esc(String(f.analysis_text).slice(0, 110)) + (String(f.analysis_text).length > 110 ? "…" : "") : "") +
        "</figcaption></figure>";
    });
    var linhas = [];
    for (var i = 0; i < figs.length; i += 3) linhas.push('<div class="rp-fotos">' + figs.slice(i, i + 3).join("") + "</div>");
    return [titulo + '<p class="rp-p">Fotos tiradas pela câmera da horta com a luz de cultivo apagada e flash, para as cores serem reais, ' +
      "com o diagnóstico que a IA deu a cada uma.</p>" + linhas[0]].concat(linhas.slice(1));
  }

  function secaoRotina(st) {
    var horaMin = function (t) { return t ? String(t).slice(0, 5) : "—"; };
    var linhas = [
      ["Luz de cultivo", n1(st.light_hours) + " h por dia, a partir das " + horaMin(st.luz_inicio)],
      ["Umidade alvo do solo", inteiro(st.humidity_target) + "% (a rega liga abaixo de " + Math.max(15, Math.round(st.humidity_target - 10)) + "%)"],
      ["Rega de referência", "a cada " + n1(st.water_interval_h) + " h (usada só na comparação de água)"],
      ["Ventilação", (st.vent_min_por_hora != null ? st.vent_min_por_hora : "—") + " min por hora e sempre acima de " + n1(st.temp_max) + " °C"],
      ["Luz UV", (st.uv_min_dia != null ? st.uv_min_dia : 30) + " min por dia, junto com a ventilação"],
      ["Nutriente", (st.nutri_s != null ? st.nutri_s : "—") + " s por dia, às " + horaMin(st.nutri_hora)],
      ["Ajuste automático pela IA", st.ia_autoajuste === false ? "desligado (a IA só sugere)" : "ligado (a IA corrige e avisa; dá para desfazer)"],
    ];
    return [
      '<h2 class="rp-h2">6 - Rotina configurada</h2>' +
        '<table class="rp-tabela"><thead><tr><th>Parâmetro</th><th>Valor atual</th></tr></thead><tbody>' +
        linhas.map(function (l) { return "<tr><td>" + esc(l[0]) + "</td><td>" + esc(l[1]) + "</td></tr>"; }).join("") +
        "</tbody></table>",
    ];
  }

  function secaoMetodo() {
    return [
      '<h2 class="rp-h2">7 - Como os dados foram obtidos</h2>' +
        '<p class="rp-p">A placa principal (ESP32) lê a umidade do solo por um sensor capacitivo e a temperatura do ar por um sensor DS18B20, ' +
        "aciona a bomba, a luz de cultivo, a ventilação com luz UV e o dosador de nutriente, e envia as leituras ao servidor a cada 15 segundos. " +
        "A câmera (ESP32-CAM) fotografa a planta a cada 30 minutos; a cada 3 horas uma foto é analisada pela inteligência artificial (Google Gemini), " +
        "que avalia sinais visuais de saúde, procura pragas e julga a luz natural para decidir se o LED de cultivo precisa acender.</p>" +
        '<p class="rp-nota">A IA analisa apenas sinais visuais e as leituras dos sensores. Ela não mede concentração de princípios ativos nem faz afirmações terapêuticas. ' +
        "Os valores de água são estimativas a partir do tempo de bomba.</p>",
    ];
  }

  // ------------------------------------------------------------ paginação
  function alturaUtil() {
    var t = document.createElement("div");
    t.style.height = "calc(297mm - 58mm - 20mm)";
    el.medidor.appendChild(t);
    var h = t.offsetHeight;
    el.medidor.removeChild(t);
    return h;
  }

  function medir(html) {
    el.medidor.innerHTML = '<div class="rp-bloco">' + html + "</div>";
    var b = el.medidor.firstChild;
    var estilo = getComputedStyle(b);
    return b.offsetHeight + parseFloat(estilo.marginBottom || 0);
  }

  async function esperarImagens(raiz) {
    var imgs = Array.prototype.slice.call(raiz.querySelectorAll("img"));
    await Promise.all(imgs.map(function (i) {
      return i.complete ? null : new Promise(function (ok) { i.onload = i.onerror = ok; });
    }));
  }

  async function paginar(blocos, st) {
    // As fotos precisam carregar no medidor para a altura sair certa.
    el.medidor.innerHTML = blocos.join("");
    await esperarImagens(el.medidor);
    var util = alturaUtil();
    var paginas = [[]];
    var usado = 0;
    blocos.forEach(function (html) {
      var h = medir(html);
      if (usado + h > util && paginas[paginas.length - 1].length) {
        paginas.push([]);
        usado = 0;
      }
      paginas[paginas.length - 1].push(html);
      usado += h;
    });
    el.medidor.innerHTML = "";
    var total = paginas.length;
    el.folhas.innerHTML = paginas.map(function (p, i) {
      return '<section class="rp-folha"><div class="rp-folha__conteudo">' +
        p.map(function (h) { return '<div class="rp-bloco">' + h + "</div>"; }).join("") + "</div>" +
        '<div class="rp-rodape"><span>GrowAI · Relatório de cultivo · ' + esc(st.name) + "</span><span>Página " + (i + 1) + " de " + total + "</span></div></section>";
    }).join("");
    return total;
  }

  // ------------------------------------------------------------ dados
  async function fotosDoRelatorio(stationId) {
    var lista = await GrowAI.getTimeline(stationId).catch(function () { return []; });
    if (!lista.length) return [];
    // Prefere as analisadas pela IA; até 6, espalhadas pelo período.
    var analisadas = lista.filter(function (f) { return f.health_status !== "indefinido"; });
    var base = analisadas.length >= 3 ? analisadas : lista;
    var escolhidas = [];
    var n = Math.min(6, base.length);
    for (var i = 0; i < n; i++) escolhidas.push(base[Math.round((i * (base.length - 1)) / Math.max(1, n - 1))]);
    escolhidas = escolhidas.filter(function (f, i, arr) { return arr.indexOf(f) === i; }).reverse(); // mais recente primeiro
    return Promise.all(escolhidas.map(function (f) {
      return GrowAI.getPhoto(stationId, f.id).catch(function () { return null; });
    })).then(function (r) { return r.filter(Boolean); });
  }

  async function montar(stationId) {
    el.pdf.disabled = true;
    el.status.textContent = "Buscando os dados da estação…";
    var estacoes = await GrowAI.getStations();
    if (!estacoes.length) {
      el.status.textContent = "Você ainda não tem estações.";
      el.folhas.innerHTML = "";
      return;
    }
    var st = estacoes.filter(function (s) { return String(s.id) === String(stationId); })[0] || estacoes[0];

    el.estacao.innerHTML = estacoes.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === st.id ? " selected" : "") + ">" + esc(s.name + " · " + s.plant) + "</option>";
    }).join("");
    el.estacao.hidden = estacoes.length < 2;

    var r = await Promise.all([
      GrowAI.getWeeklyReports().catch(function () { return []; }),
      GrowAI.getAgua(st.id, 30).catch(function (e) { return { erro: e.message }; }),
      GrowAI.getDiarioIa().catch(function () { return null; }),
      fotosDoRelatorio(st.id),
    ]);
    var semana = (r[0] || []).filter(function (x) { return String(x.station_id) === String(st.id); })[0] || null;

    el.status.textContent = "Montando as páginas…";
    var blocos = [blocoCapa(st, semana)]
      .concat(secaoResumo(st, semana))
      .concat(secaoDias(semana))
      .concat(secaoAgua(r[1]))
      .concat(secaoDiario(r[2], st.id))
      .concat(secaoFotos(r[3]))
      .concat(secaoRotina(st))
      .concat(secaoMetodo());
    var paginas = await paginar(blocos, st);
    document.title = "Relatório " + st.name + " - " + new Date().toLocaleDateString("pt-BR");
    el.status.textContent = "Pronto: " + paginas + " página" + (paginas > 1 ? "s" : "") + " no papel timbrado.";
    el.pdf.disabled = false;
    if (/[?&]imprimir=1/.test(location.search)) setTimeout(imprimir, 400);
  }

  function imprimir() {
    el.dica.hidden = false;
    window.print();
  }

  el.pdf.addEventListener("click", imprimir);
  el.estacao.addEventListener("change", function () {
    var url = new URL(location.href);
    url.searchParams.set("station_id", el.estacao.value);
    history.replaceState(null, "", url);
    montar(el.estacao.value).catch(falhou);
  });

  function falhou(e) {
    el.status.textContent = "Não foi possível montar o relatório: " + (e && e.message ? e.message : "erro desconhecido");
  }

  var qs = new URLSearchParams(location.search);
  montar(qs.get("station_id")).catch(falhou);
})();
