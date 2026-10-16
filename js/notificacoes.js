(function () {
  "use strict";

  // O sino do app: contador de não lidas e a lista de tudo o que a pessoa
  // recebeu (GET /api/notificacoes). Abrir a lista marca tudo como lido.
  // Notificação nova chega na hora pelo WebSocket (GrowAI.aoVivo).
  // O sino já existe no topo de cada tela (.app-header__bell no computador,
  // .m-app-header__bell no celular); o painel é injetado aqui.

  if (!window.GrowAI || !GrowAI.isAuthenticated()) return;

  var TIPO = {
    saude: { rotulo: "Saúde", destino: "app-camera.html" },
    praga: { rotulo: "Pragas", destino: "app-camera.html" },
    luz: { rotulo: "Iluminação", destino: "app-camera.html" },
    ajuste: { rotulo: "Rotina", destino: "app-relatorios.html" },
    relatorio: { rotulo: "Relatório", destino: "app-relatorios.html" },
    rega: { rotulo: "Rega", destino: "app-estacoes.html" },
    sensor: { rotulo: "Sensor", destino: "app-estacoes.html" },
    placa: { rotulo: "Placa", destino: "app-estacoes.html" },
  };

  var MARKUP = [
    '<div class="notif-fundo" id="notifFundo" hidden></div>',
    '<div class="notif" id="notif" hidden role="dialog" aria-modal="false" aria-labelledby="notifTitulo">',
    '  <div class="notif__topo">',
    '    <p class="notif__titulo" id="notifTitulo">Notificações</p>',
    '    <button type="button" class="notif__fechar" data-notif="fechar" aria-label="Fechar">&times;</button>',
    "  </div>",
    '  <div class="notif__lista" id="notifLista"></div>',
    "</div>",
  ].join("\n");

  var painel, lista, fundo;

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
  var naoLidas = 0;
  var itens = [];

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function haQuanto(iso) {
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "agora";
    var m = Math.round(s / 60);
    if (m < 60) return "há " + m + " min";
    var h = Math.round(m / 60);
    if (h < 24) return "há " + h + " h";
    var d = Math.round(h / 24);
    return d === 1 ? "ontem" : "há " + d + " dias";
  }

  function sinos() {
    return Array.prototype.slice.call(document.querySelectorAll(".app-header__bell, .m-app-header__bell"));
  }

  function atualizarContador() {
    sinos().forEach(function (sino) {
      var b = sino.querySelector(".notif-badge");
      if (!b) {
        b = document.createElement("span");
        b.className = "notif-badge";
        sino.appendChild(b);
      }
      b.textContent = naoLidas > 9 ? "9+" : String(naoLidas);
      b.hidden = naoLidas === 0;
      sino.setAttribute("aria-label", naoLidas ? "Notificações: " + naoLidas + " não lidas" : "Notificações");
    });
  }

  function render() {
    if (!lista) return;
    if (!itens.length) {
      lista.innerHTML =
        '<p class="notif__vazio">Nenhuma notificação ainda. Você recebe aviso quando uma planta precisa de atenção, ' +
        "quando aparece praga, quando a IA ajusta a rotina, quando a rega começa e quando uma placa desconecta.</p>";
      return;
    }
    lista.innerHTML = itens
      .map(function (n) {
        var t = TIPO[n.tipo] || { rotulo: "Aviso", destino: "app-home.html" };
        return (
          '<a class="notif__item notif__item--' + esc(n.tipo) + (n.lida ? "" : " is-nova") + '" href="' + t.destino + '">' +
          '<span class="notif__ponto" aria-hidden="true"></span>' +
          '<span class="notif__corpo">' +
          '<span class="notif__meta">' + esc(t.rotulo) + (n.station_name ? " · " + esc(n.station_name) : "") + " · " + haQuanto(n.criado_em) + "</span>" +
          '<span class="notif__item-titulo">' + esc(n.titulo) + "</span>" +
          (n.mensagem ? '<span class="notif__msg">' + esc(n.mensagem) + "</span>" : "") +
          "</span></a>"
        );
      })
      .join("");
  }

  async function carregar() {
    try {
      var r = await GrowAI.getNotificacoes();
      itens = r.itens || [];
      naoLidas = r.nao_lidas || 0;
    } catch (e) {
      /* sem rede: o sino fica como está */
    }
    atualizarContador();
    render();
  }

  function montarPainel() {
    if (painel) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    painel = document.getElementById("notif");
    lista = document.getElementById("notifLista");
    fundo = document.getElementById("notifFundo");
    fundo.addEventListener("click", fechar);
    painel.addEventListener("click", function (ev) {
      if (ev.target.closest('[data-notif="fechar"]')) fechar();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && estaAberto(painel)) fechar();
    });
  }

  async function abrir() {
    montarPainel();
    if (window.Vera && window.Vera.fechar) window.Vera.fechar();
    mostrar([painel, fundo]);
    lista.innerHTML = '<p class="notif__vazio">Carregando…</p>';
    await carregar();
    // Viu a lista: tudo vira lido (as novas continuam destacadas até fechar).
    if (naoLidas) {
      naoLidas = 0;
      atualizarContador();
      GrowAI.marcarNotificacoesLidas().catch(function () {});
    }
  }

  function fechar() {
    if (!painel) return;
    esconder([painel, fundo]);
    itens = itens.map(function (n) { return Object.assign({}, n, { lida: true }); });
  }

  // Liga os sinos que já estão no topo de cada tela.
  sinos().forEach(function (sino) {
    sino.removeAttribute("aria-hidden");
    sino.setAttribute("role", "button");
    sino.setAttribute("tabindex", "0");
    sino.classList.add("notif-sino");
    sino.addEventListener("click", function () {
      if (estaAberto(painel)) fechar();
      else abrir();
    });
    sino.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        abrir();
      }
    });
  });

  // Nova notificação pelo WebSocket: contador sobe e aparece um aviso.
  GrowAI.aoVivo(function (msg) {
    if (!msg || msg.tipo !== "notificacao" || !msg.notificacao) return;
    itens.unshift(msg.notificacao);
    if (estaAberto(painel)) {
      render();
    } else {
      naoLidas++;
      atualizarContador();
      if (typeof window.showToast === "function") window.showToast("🔔 " + msg.notificacao.titulo);
    }
  });

  carregar();
  // Reserva do WebSocket: confere o contador a cada 2 min.
  setInterval(function () {
    if (!document.hidden && !estaAberto(painel)) carregar();
  }, 120000);

  window.Notificacoes = { abrir: abrir, fechar: fechar };
})();
