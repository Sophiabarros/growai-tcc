(function () {
  "use strict";

  // Vera: chat com a IA da horta, 3 perguntas por dia (o limite é do backend,
  // GET/POST /api/vera). Botão flutuante em todas as telas do app; o painel é
  // injetado aqui, como os modais, e o visual está em css/vera.css.
  //
  //   Vera.abrir();                       // abre o chat
  //   Vera.abrir("texto já escrito");     // abre com a pergunta preenchida

  if (!window.GrowAI || !GrowAI.isAuthenticated()) return;

  var MARKUP = [
    '<button type="button" class="vera-fab" id="veraFab" aria-label="Abrir a Vera, assistente da horta">',
    '  <span class="vera-fab__icone" aria-hidden="true">✦</span><span class="vera-fab__nome">Vera</span>',
    "</button>",
    '<div class="vera" id="vera" hidden role="dialog" aria-modal="false" aria-labelledby="veraTitulo">',
    '  <div class="vera__topo">',
    '    <div>',
    '      <p class="vera__titulo" id="veraTitulo">Vera</p>',
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
    "Oi! Eu sou a Vera. Sei o que está acontecendo na sua horta: as rotinas, as últimas análises das fotos e as leituras dos sensores. " +
    "Pergunte, por exemplo: \"A análise falou em folha amarelada, o que eu faço?\"";

  var painel, conversa, campo, enviar, sub;
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

    document.getElementById("veraFab").addEventListener("click", function () {
      if (painel.hidden) abrir();
      else fechar();
    });
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
      if (ev.key === "Escape" && painel && !painel.hidden) fechar();
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
    campo.placeholder = restantes === 0 ? "A Vera volta amanhã!" : "Pergunte sobre a sua horta…";
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
    painel.hidden = false;
    document.getElementById("veraFab").classList.add("is-aberto");
    if (typeof textoInicial === "string" && textoInicial) campo.value = textoInicial;
    carregar().then(function () {
      if (!campo.disabled) campo.focus();
    });
  }

  function fechar() {
    if (!painel) return;
    painel.hidden = true;
    document.getElementById("veraFab").classList.remove("is-aberto");
  }

  window.Vera = { abrir: abrir, fechar: fechar };
  montar();
})();
