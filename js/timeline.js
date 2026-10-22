(function () {
  "use strict";

  // Linha do tempo da planta: todas as fotos da câmera de uma estação, em
  // ordem, com o veredito da IA de cada uma. Dá para arrastar, ir foto a foto
  // ou dar play (time-lapse). Markup injetado na primeira abertura, como os
  // outros modais do app; visual em css/timeline.css.
  //
  //   Timeline.abrir(station);
  //
  // Dados: GET /stations/:id/photos/timeline traz a lista leve (sem imagem);
  // cada imagem vem de GET /stations/:id/photos/:photoId quando é mostrada,
  // e fica guardada em memória enquanto o modal estiver aberto.

  var SAUDE = {
    saudavel: { texto: "Saudável", classe: "ok" },
    atencao: { texto: "Atenção", classe: "atencao" },
    indefinido: { texto: "Sem análise", classe: "sem" },
  };
  var LUZ = { pouca: "Pouca luz natural", boa: "Luz natural boa", muita: "Muita luz natural", incerto: "Luz: não deu para avaliar" };
  var VELOCIDADES = [
    { rotulo: "1x", ms: 900 },
    { rotulo: "2x", ms: 450 },
    { rotulo: "4x", ms: 220 },
  ];

  var MARKUP = [
    '<div class="tl" id="tl" hidden role="dialog" aria-modal="true" aria-labelledby="tlTitulo">',
    '  <div class="tl__fundo" data-tl="fechar"></div>',
    '  <div class="tl__painel">',
    '    <div class="tl__topo">',
    '      <div>',
    '        <p class="tl__titulo" id="tlTitulo">Linha do tempo</p>',
    '        <p class="tl__sub" id="tlSub"></p>',
    "      </div>",
    '      <button type="button" class="tl__fechar" data-tl="fechar" aria-label="Fechar">&times;</button>',
    "    </div>",
    '    <div class="tl__palco" id="tlPalco">',
    '      <img class="tl__img" id="tlImg" alt="" hidden />',
    '      <span class="tl__selo" id="tlSelo" hidden></span>',
    '      <span class="tl__contador" id="tlContador"></span>',
    '      <span class="tl__data" id="tlData"></span>',
    '      <span class="tl__carregando" id="tlCarregando" hidden aria-hidden="true"></span>',
    '      <p class="tl__vazio" id="tlVazio" hidden></p>',
    "    </div>",
    '    <div class="tl__trilha" id="tlTrilha">',
    '      <div class="tl__marcas" id="tlMarcas" aria-hidden="true"></div>',
    '      <input type="range" class="tl__range" id="tlRange" min="0" max="0" step="1" value="0" aria-label="Escolher foto da linha do tempo" />',
    "    </div>",
    '    <div class="tl__limites"><span id="tlInicio"></span><span id="tlFim"></span></div>',
    '    <div class="tl__controles">',
    '      <button type="button" class="tl__btn" data-tl="anterior" aria-label="Foto anterior">&#9664;&#9664;</button>',
    '      <button type="button" class="tl__btn tl__btn--play" data-tl="play" id="tlPlay" aria-label="Reproduzir time-lapse">&#9654;</button>',
    '      <button type="button" class="tl__btn" data-tl="proxima" aria-label="Próxima foto">&#9654;&#9654;</button>',
    '      <button type="button" class="tl__chip" data-tl="velocidade" id="tlVel" aria-label="Velocidade do time-lapse">1x</button>',
    '      <label class="tl__filtro"><input type="checkbox" id="tlSoAnalisadas" /> Só fotos analisadas pela IA</label>',
    '      <span class="tl__legenda" aria-hidden="true">',
    '        <i class="tl__leg tl__leg--ok"></i>Saudável <i class="tl__leg tl__leg--atencao"></i>Atenção',
    '        <i class="tl__leg tl__leg--praga"></i>Praga <i class="tl__leg tl__leg--sem"></i>Sem análise',
    "      </span>",
    "    </div>",
    '    <div class="tl__info" id="tlInfo"></div>',
    "  </div>",
    "</div>",
  ].join("\n");

  var el = {};
  var station = null;
  var todas = []; // lista completa da API
  var fotos = []; // a lista filtrada que está na trilha
  var idx = 0;
  var cache = {}; // photoId -> Promise<foto com image_url>
  var tocando = null;
  var vel = 0;
  var pedido = 0; // descarta respostas de fotos que já não são a atual
  var ultimoFoco = null;

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function dataHora(iso, curto) {
    var d = new Date(iso);
    var dia = d.toLocaleDateString("pt-BR", curto ? { day: "2-digit", month: "short" } : { day: "2-digit", month: "long", year: "numeric" });
    var hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return dia.replace(".", "") + " · " + hora;
  }

  function classeDa(f) {
    if (f.pragas === "sim") return "praga";
    return (SAUDE[f.health_status] || SAUDE.indefinido).classe;
  }

  function montar() {
    if (el.raiz) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    ["tl", "tlSub", "tlPalco", "tlImg", "tlSelo", "tlContador", "tlData", "tlCarregando", "tlVazio", "tlMarcas",
      "tlRange", "tlInicio", "tlFim", "tlPlay", "tlVel", "tlSoAnalisadas", "tlInfo"].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
    el.raiz = el.tl;

    el.raiz.addEventListener("click", function (ev) {
      var alvo = ev.target.closest("[data-tl]");
      if (!alvo) return;
      var acao = alvo.dataset.tl;
      if (acao === "fechar") fechar();
      else if (acao === "anterior") { parar(); ir(idx - 1); }
      else if (acao === "proxima") { parar(); ir(idx + 1); }
      else if (acao === "play") alternarPlay();
      else if (acao === "velocidade") {
        vel = (vel + 1) % VELOCIDADES.length;
        el.tlVel.textContent = VELOCIDADES[vel].rotulo;
      }
    });
    el.tlRange.addEventListener("input", function () {
      parar();
      ir(Number(el.tlRange.value));
    });
    el.tlSoAnalisadas.addEventListener("change", function () {
      var atual = fotos[idx];
      filtrar();
      // Fica na mesma foto se ela continua na lista; senão, na mais próxima.
      var novo = atual ? fotos.findIndex(function (f) { return f.id === atual.id; }) : -1;
      if (novo < 0 && atual) {
        novo = fotos.findIndex(function (f) { return new Date(f.captured_at) >= new Date(atual.captured_at); });
        if (novo < 0) novo = fotos.length - 1;
      }
      ir(Math.max(0, novo));
    });
    document.addEventListener("keydown", function (ev) {
      if (!el.raiz || el.raiz.hidden) return;
      if (ev.key === "Escape") fechar();
      else if (ev.key === "ArrowLeft") { parar(); ir(idx - 1); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { parar(); ir(idx + 1); ev.preventDefault(); }
      else if (ev.key === " " && ev.target.tagName !== "INPUT") { alternarPlay(); ev.preventDefault(); }
    });
  }

  function filtrar() {
    fotos = el.tlSoAnalisadas.checked
      ? todas.filter(function (f) { return f.health_status !== "indefinido"; })
      : todas.slice();
    el.tlRange.max = String(Math.max(0, fotos.length - 1));
    el.tlRange.disabled = fotos.length < 2;
    // Uma marquinha colorida por foto: a saúde ao longo do tempo, de relance.
    el.tlMarcas.innerHTML = fotos
      .map(function (f, i) {
        var x = fotos.length === 1 ? 50 : (i / (fotos.length - 1)) * 100;
        return '<i class="tl__marca tl__marca--' + classeDa(f) + '" style="left:' + x.toFixed(3) + '%"></i>';
      })
      .join("");
    el.tlInicio.textContent = fotos.length ? dataHora(fotos[0].captured_at, true) : "";
    el.tlFim.textContent = fotos.length > 1 ? dataHora(fotos[fotos.length - 1].captured_at, true) : "";
  }

  function carregar(f) {
    if (!cache[f.id]) {
      cache[f.id] = GrowAI.getPhoto(station.id, f.id).catch(function (e) {
        delete cache[f.id]; // deixa tentar de novo
        throw e;
      });
    }
    return cache[f.id];
  }

  // Já pede as próximas: o time-lapse não engasga esperando a rede.
  function adiantar(a) {
    for (var i = 1; i <= 3; i++) if (fotos[a + i]) carregar(fotos[a + i]).catch(function () {});
  }

  function ir(novo) {
    if (!fotos.length) return Promise.resolve();
    idx = Math.max(0, Math.min(fotos.length - 1, novo));
    el.tlRange.value = String(idx);
    var f = fotos[idx];
    var meu = ++pedido;

    el.tlContador.textContent = "Foto " + (idx + 1) + " de " + fotos.length;
    el.tlData.textContent = dataHora(f.captured_at);
    var s = SAUDE[f.health_status] || SAUDE.indefinido;
    var cls = classeDa(f);
    el.tlSelo.hidden = false;
    el.tlSelo.className = "tl__selo tl__selo--" + cls;
    el.tlSelo.textContent = cls === "praga" ? "Praga detectada" : s.texto;
    renderInfo(f);

    el.tlCarregando.hidden = false;
    adiantar(idx);
    return carregar(f).then(
      function (comImg) {
        if (meu !== pedido) return;
        el.tlImg.src = comImg.image_url;
        el.tlImg.alt = "Foto de " + dataHora(f.captured_at);
        el.tlImg.hidden = false;
        el.tlCarregando.hidden = true;
      },
      function () {
        if (meu !== pedido) return;
        el.tlCarregando.hidden = true;
        if (window.showToast) window.showToast("Não foi possível carregar esta foto.", "error");
      }
    );
  }

  function renderInfo(f) {
    var tags = [];
    if (f.pragas === "sim") tags.push('<span class="tl__tag tl__tag--praga">Praga: ' + esc(f.pragas_descricao || "detectada") + "</span>");
    else if (f.pragas === "nao") tags.push('<span class="tl__tag">Sem pragas</span>');
    if (LUZ[f.luz_nivel]) tags.push('<span class="tl__tag">' + LUZ[f.luz_nivel] + "</span>");
    var texto = f.health_status === "indefinido"
      ? "Esta foto foi guardada sem análise: a IA analisa uma foto a cada 3 horas, para caber na cota diária."
      : f.analysis_text || "";
    el.tlInfo.innerHTML =
      (tags.length ? '<div class="tl__tags">' + tags.join("") + "</div>" : "") +
      '<p class="tl__texto">' + esc(texto) + "</p>";
  }

  function alternarPlay() {
    if (tocando) return parar();
    if (fotos.length < 2) return;
    if (idx >= fotos.length - 1) ir(0); // no fim, recomeça do início
    el.tlPlay.innerHTML = "&#10074;&#10074;";
    el.tlPlay.setAttribute("aria-label", "Pausar time-lapse");
    el.tlPlay.classList.add("is-tocando");
    var passo = function () {
      if (!tocando) return;
      if (idx >= fotos.length - 1) return parar();
      var inicio = Date.now();
      // Espera a imagem chegar antes de contar o tempo da próxima.
      ir(idx + 1).then(function () {
        if (!tocando) return;
        tocando = setTimeout(passo, Math.max(0, VELOCIDADES[vel].ms - (Date.now() - inicio)));
      });
    };
    tocando = setTimeout(passo, VELOCIDADES[vel].ms);
  }

  function parar() {
    if (tocando) clearTimeout(tocando);
    tocando = null;
    if (!el.tlPlay) return;
    el.tlPlay.innerHTML = "&#9654;";
    el.tlPlay.setAttribute("aria-label", "Reproduzir time-lapse");
    el.tlPlay.classList.remove("is-tocando");
  }

  function vazio(texto) {
    el.tlImg.hidden = true;
    el.tlSelo.hidden = true;
    el.tlCarregando.hidden = true;
    el.tlContador.textContent = "";
    el.tlData.textContent = "";
    el.tlVazio.hidden = false;
    el.tlVazio.textContent = texto;
    el.tlInfo.innerHTML = "";
    el.tlMarcas.innerHTML = "";
    el.tlInicio.textContent = "";
    el.tlFim.textContent = "";
    el.tlRange.max = "0";
    el.tlRange.disabled = true;
  }

  function abrir(st) {
    montar();
    parar();
    station = st;
    todas = [];
    fotos = [];
    cache = {};
    idx = 0;
    el.tlSoAnalisadas.checked = false;
    el.tlSub.textContent = (st.name || "") + (st.plant ? " · " + st.plant : "");
    el.tlVazio.hidden = true;
    el.tlImg.hidden = true;
    el.tlSelo.hidden = true;
    el.tlCarregando.hidden = false;
    el.tlInfo.innerHTML = "";
    el.tlContador.textContent = "Carregando fotos…";

    ultimoFoco = document.activeElement;
    document.body.classList.add("visor-aberto");
    el.raiz.hidden = false;
    requestAnimationFrame(function () { el.raiz.classList.add("is-aberto"); });
    el.raiz.querySelector(".tl__fechar").focus();

    GrowAI.getTimeline(st.id).then(
      function (lista) {
        if (station !== st) return;
        todas = lista || [];
        if (!todas.length) return vazio("A câmera desta estação ainda não mandou nenhuma foto.");
        filtrar();
        ir(fotos.length - 1); // abre na mais recente
      },
      function (e) {
        if (station !== st) return;
        vazio(e.message || "Não foi possível carregar a linha do tempo.");
      }
    );
  }

  function fechar() {
    if (!el.raiz || el.raiz.hidden) return;
    parar();
    station = null;
    cache = {}; // solta as imagens da memória
    el.raiz.classList.remove("is-aberto");
    document.body.classList.remove("visor-aberto");
    setTimeout(function () {
      el.raiz.hidden = true;
      el.tlImg.removeAttribute("src");
    }, 180);
    if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
  }

  window.Timeline = { abrir: abrir, fechar: fechar };
})();
