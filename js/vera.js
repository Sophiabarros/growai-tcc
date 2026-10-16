(function () {
  "use strict";

  // V.E.R.A: chat com a IA da horta, 3 perguntas por dia (o limite é do backend,
  // GET/POST /api/vera). No computador, botão flutuante; no celular, botão no
  // topo ao lado do sino (flutuando, ele engrossava visualmente a tab bar).
  // Aberto, o resto da tela fica desfocado atrás. Visual em css/vera.css.
  //
  //   Vera.abrir();                       // abre o chat
  //   Vera.abrir("texto já escrito");     // abre com a pergunta preenchida

  if (!window.GrowAI || !GrowAI.isAuthenticated()) return;

  var MARKUP = [
    '<div class="vera-fundo" id="veraFundo" hidden data-vera="fechar"></div>',
    '<button type="button" class="vera-fab" id="veraFab" aria-label="Abrir a V.E.R.A, assistente da horta">',
    '  <span class="vera-fab__icone" aria-hidden="true">✦</span><span class="vera-fab__nome">V.E.R.A</span>',
    "</button>",
    '<div class="vera" id="vera" hidden role="dialog" aria-modal="false" aria-labelledby="veraTitulo">',
    '  <div class="vera__topo">',
    '    <div>',
    '      <p class="vera__titulo" id="veraTitulo">V.E.R.A</p>',
    '      <p class="vera__sub" id="veraSub">Assistente da sua horta</p>',
    "    </div>",
    '    <button type="button" class="vera__fechar" data-vera="fechar" aria-label="Fechar">&times;</button>',
    "  </div>",
    '  <div class="vera__conversa" id="veraConversa" aria-live="polite"></div>',
    '  <form class="vera__form" id="veraForm">',
    '    <textarea class="vera__campo" id="veraCampo" rows="2" maxlength="500" placeholder="Pergunte sobre a sua horta…"></textarea>',
    '    <button type="submit" class="vera__enviar" id="veraEnviar">Enviar</button>',
    "  </form>",
    "</div>",
  ].join("\n");

  var BOAS_VINDAS =
    "Oi! Eu sou a V.E.R.A. Sei o que está acontecendo na sua horta: as rotinas, as últimas análises das fotos e as leituras dos sensores. " +
    "Pergunte, por exemplo: \"A análise falou em folha amarelada, o que eu faço?\"";

  var painel, conversa, campo, enviar, sub, fundo;

  // Abre/fecha com transição (css: .is-aberto). hidden só volta no fim da saída.
  var timerSaida = null;
  function mostrar(els) {
    clearTimeout(timerSaida);
    els.forEach(function (e) { e.hidden = false; });
    // Dois quadros: o navegador precisa pintar o estado inicial antes de animar.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        els.forEach(function (e) { e.classList.add("is-aberto"); });
      });
    });
  }
  function esconder(els) {
    els.forEach(function (e) { e.classList.remove("is-aberto"); });
    clearTimeout(timerSaida);
    timerSaida = setTimeout(function () {
      els.forEach(function (e) { if (!e.classList.contains("is-aberto")) e.hidden = true; });
    }, 180);
  }
  function estaAberto(el) {
    return !!el && el.classList.contains("is-aberto");
  }
  var estado = null;
  var enviando = false;

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function montar() {
    if (painel) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    painel = document.getElementById("vera");
    conversa = document.getElementById("veraConversa");
    campo = document.getElementById("veraCampo");
    enviar = document.getElementById("veraEnviar");
    sub = document.getElementById("veraSub");

    function alternar() {
      if (estaAberto(painel)) fechar();
      else abrir();
    }
    document.getElementById("veraFab").addEventListener("click", alternar);
    // Celular: botão no topo do app, ao lado do sino.
    var topo = document.querySelector(".m-app-header");
    if (topo && !topo.querySelector(".m-vera-btn")) {
      topo.insertAdjacentHTML("beforeend", '<button type="button" class="m-vera-btn" aria-label="Abrir a V.E.R.A">✦ V.E.R.A</button>');
      topo.querySelector(".m-vera-btn").addEventListener("click", alternar);
    }
    fundo = document.getElementById("veraFundo");
    fundo.addEventListener("click", fechar);
    painel.addEventListener("click", function (ev) {
      if (ev.target.closest('[data-vera="fechar"]')) fechar();
    });
    document.getElementById("veraForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      perguntar();
    });
    // Enter envia; Shift+Enter quebra linha.
    campo.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        perguntar();
      }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && estaAberto(painel)) fechar();
    });
  }

  // Texto já escapado; só **negrito** e quebras de linha viram HTML.
  function bolha(quem, texto) {
    var html = esc(texto)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
    return '<div class="vera__msg vera__msg--' + quem + '"><p>' + html + "</p></div>";
  }

  function render(extra) {
    var html = bolha("vera", BOAS_VINDAS);
    (estado && estado.conversa ? estado.conversa : []).forEach(function (c) {
      html += bolha("eu", c.pergunta) + bolha("vera", c.resposta);
    });
    if (extra) html += extra;
    conversa.innerHTML = html;
    conversa.scrollTop = conversa.scrollHeight;

    var restantes = estado ? estado.restantes : null;
    var limite = estado ? estado.limite : 3;
    sub.textContent = restantes == null
      ? "Assistente da sua horta"
      : restantes > 0
        ? restantes + " de " + limite + " perguntas restantes hoje"
        : "Você usou as " + limite + " perguntas de hoje";
    var bloqueado = enviando || (restantes != null && restantes <= 0);
    campo.disabled = bloqueado;
    enviar.disabled = bloqueado;
    campo.placeholder = restantes === 0 ? "A V.E.R.A volta amanhã!" : "Pergunte sobre a sua horta…";
  }

  async function carregar() {
    try {
      estado = await GrowAI.getVera();
    } catch (e) {
      estado = null;
    }
    render();
  }

  async function perguntar() {
    var texto = campo.value.trim();
    if (!texto || enviando) return;
    enviando = true;
    render(bolha("eu", texto) + '<div class="vera__msg vera__msg--vera vera__msg--pensando"><p>Pensando…</p></div>');
    var extraErro = "";
    try {
      estado = await GrowAI.askVera(texto);
      campo.value = "";
    } catch (e) {
      // 429 (limite) e 503 (IA fora) já vêm com a mensagem certa do backend,
      // e a pergunta continua no campo para tentar de novo.
      if (e && e.data && e.data.restantes != null) estado = e.data;
      extraErro = bolha("eu", texto) +
        '<div class="vera__msg vera__msg--erro"><p>' + esc(e.message || "Não foi possível perguntar agora.") + "</p></div>";
    } finally {
      enviando = false;
      render(extraErro);
    }
  }

  function abrir(textoInicial) {
    montar();
    if (window.Notificacoes && window.Notificacoes.fechar) window.Notificacoes.fechar();
    mostrar([painel, fundo]);
    document.body.classList.add("vera-aberta");
    document.getElementById("veraFab").classList.add("is-aberto");
    if (typeof textoInicial === "string" && textoInicial) campo.value = textoInicial;
    carregar().then(function () {
      if (!campo.disabled) campo.focus();
    });
  }

  function fechar() {
    if (!painel) return;
    esconder([painel, fundo]);
    document.body.classList.remove("vera-aberta");
    document.getElementById("veraFab").classList.remove("is-aberto");
  }

  window.Vera = { abrir: abrir, fechar: fechar };
  montar();
})();
