(function () {
  "use strict";

  // Painel de desenvolvedor: uso da cota da IA. Abre pela linha
  // "Uso da IA" em Configurações > Desenvolvedor; pede a senha de dev, que é
  // conferida no SERVIDOR (GET /api/dev/ia-uso). A senha fica só nesta aba
  // (sessionStorage) para não pedir de novo a cada atualização.
  //
  // Para que serve: quando a IA "dá erro sem motivo", quase sempre é a cota
  // gratuita do Gemini que acabou (20 chamadas por modelo por dia). Aqui dá
  // para ver isso antes de a banca ver.

  var CHAVE_SENHA = "growai_dev";
  var MODO = { foto: "Análise de foto", rotina: "Avaliação de rotina", vera: "Perguntas à V.E.R.A", teste: "Teste do painel", outro: "Outros" };
  var STATUS = {
    ok: { classe: "ok", titulo: "IA funcionando" },
    pouca: { classe: "aviso", titulo: "Pouca cota sobrando" },
    reserva: { classe: "aviso", titulo: "Usando os modelos de reserva" },
    esgotada: { classe: "erro", titulo: "Cota do dia esgotada" },
    sem_chave: { classe: "erro", titulo: "Chave da IA não configurada" },
    desligada: { classe: "erro", titulo: "IA desligada no servidor" },
  };

  var MARKUP = [
    '<div class="dev" id="devModal" hidden role="dialog" aria-modal="true" aria-labelledby="devTitulo">',
    '  <div class="dev__fundo" data-dev="fechar"></div>',
    '  <div class="dev__painel">',
    '    <div class="dev__topo">',
    '      <div><p class="dev__titulo" id="devTitulo">Uso da IA</p><p class="dev__sub">Área de desenvolvedor · cota do Gemini</p></div>',
    '      <button type="button" class="dev__fechar" data-dev="fechar" aria-label="Fechar">&times;</button>',
    "    </div>",
    '    <div class="dev__corpo" id="devCorpo"></div>',
    "  </div>",
    "</div>",
  ].join("\n");

  var raiz, corpo, ultimoFoco;

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function senha() {
    try { return sessionStorage.getItem(CHAVE_SENHA); } catch (e) { return null; }
  }
  function guardarSenha(v) {
    try { v ? sessionStorage.setItem(CHAVE_SENHA, v) : sessionStorage.removeItem(CHAVE_SENHA); } catch (e) { /* sem storage */ }
  }
  function hora(iso) {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function quando(iso) {
    var d = new Date(iso);
    var hoje = new Date();
    var mesmoDia = d.toDateString() === hoje.toDateString();
    return (mesmoDia ? "hoje" : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })) + " " + hora(iso);
  }
  function numero(n) {
    return Number(n || 0).toLocaleString("pt-BR");
  }

  function montar() {
    if (raiz) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    raiz = document.getElementById("devModal");
    corpo = document.getElementById("devCorpo");
    raiz.addEventListener("click", function (ev) {
      var a = ev.target.closest("[data-dev]");
      if (!a) return;
      var acao = a.dataset.dev;
      if (acao === "fechar") fechar();
      else if (acao === "atualizar") carregar();
      else if (acao === "bloquear") { guardarSenha(null); telaSenha(); }
      else if (acao === "testar") testar(a);
    });
    raiz.addEventListener("submit", function (ev) {
      if (ev.target.id !== "devForm") return;
      ev.preventDefault();
      var campo = document.getElementById("devSenha");
      guardarSenha(campo.value);
      carregar(true);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && raiz && !raiz.hidden) fechar();
    });
  }

  function telaSenha(erro) {
    corpo.innerHTML =
      '<form class="dev__senha" id="devForm" autocomplete="off">' +
      '<p class="dev__texto">Esta área mostra quanto da cota da IA já foi usado hoje. Digite a senha de desenvolvedor.</p>' +
      '<label class="dev__rotulo" for="devSenha">Senha de desenvolvedor</label>' +
      '<input class="dev__campo" type="password" id="devSenha" required autocomplete="current-password" />' +
      (erro ? '<p class="dev__erro" role="alert">' + esc(erro) + "</p>" : "") +
      '<button type="submit" class="dev__btn">Desbloquear</button>' +
      "</form>";
    setTimeout(function () { var c = document.getElementById("devSenha"); if (c) c.focus(); }, 50);
  }

  async function carregar(acabouDeDigitar) {
    var s = senha();
    if (!s) return telaSenha();
    if (!acabouDeDigitar) corpo.innerHTML = '<p class="dev__texto">Carregando…</p>';
    try {
      var d = await GrowAI.getIaUso(s);
      render(d);
    } catch (e) {
      if (e.status === 403 || e.status === 429) {
        guardarSenha(null);
        return telaSenha(e.message);
      }
      corpo.innerHTML = '<p class="dev__erro">' + esc(e.message || "Não foi possível carregar.") + "</p>" +
        '<button type="button" class="dev__btn" data-dev="atualizar">Tentar de novo</button>';
    }
  }

  function render(d) {
    var st = STATUS[d.status] || STATUS.ok;
    var virada = hora(d.virada_em);
    var frase = {
      ok: "Sobram " + d.restantes + " de " + d.limite_total + " chamadas hoje, somando os " + d.modelos.length + " modelos.",
      pouca: "Só " + d.restantes + " chamadas sobrando hoje. Evite testes desnecessários até " + virada + ".",
      reserva: "O modelo principal acabou a cota de hoje; a IA continua pelos de reserva (" + d.restantes + " chamadas).",
      esgotada: "Todos os modelos gastaram a cota de hoje. A IA volta sozinha às " + virada + " (horário de Brasília)" +
        (d.claude_reserva ? ", ou pelo Claude, que está configurado como última reserva." : "."),
      sem_chave: "Falta a GEMINI_API_KEY no servidor (Render > Environment).",
      desligada: "IA_HABILITADA=false no servidor: nenhuma análise é feita.",
    }[d.status] || "";

    var modelos = d.modelos.map(function (m) {
      var pct = Math.min(100, Math.round((100 * m.usadas) / Math.max(1, m.limite)));
      return (
        '<div class="dev-modelo' + (m.esgotado ? " is-esgotado" : "") + '">' +
        '<div class="dev-modelo__linha"><p class="dev-modelo__nome">' + esc(m.modelo) +
        ' <span class="dev-modelo__papel">' + (m.papel === "principal" ? "principal" : "reserva") + "</span></p>" +
        '<p class="dev-modelo__num">' + (m.esgotado ? "esgotado" : "restam <b>" + m.restantes + "</b>") + "</p></div>" +
        '<div class="dev-barra" role="img" aria-label="' + m.usadas + " de " + m.limite + ' chamadas usadas"><span style="width:' + pct + '%"></span></div>' +
        '<p class="dev-modelo__meta">' + m.usadas + " de " + m.limite + " usadas · " + numero(m.tokens) + " tokens" +
        (m.erros_cota ? " · " + m.erros_cota + " recusa(s) por cota" : "") + "</p></div>"
      );
    }).join("");

    var c = d.capacidade || {};
    var cfg = d.config || {};
    var podeFazer =
      '<ul class="dev-pode">' +
      "<li><b>" + c.analises_foto + "</b> análises de foto (botão “Analisar saúde agora”)</li>" +
      "<li><b>" + c.avaliacoes_rotina + "</b> avaliações de rotina (ao salvar uma estação)</li>" +
      "<li><b>" + Math.min(c.perguntas_vera, Math.max(0, cfg.vera_limite - cfg.vera_minhas_hoje)) + "</b> perguntas à V.E.R.A para você hoje " +
      "(limite de " + cfg.vera_limite + " por pessoa; você fez " + cfg.vera_minhas_hoje + ")</li>" +
      "</ul>" +
      '<p class="dev__nota">Cada uma gasta 1 chamada da mesma cota. A câmera também usa a cota sozinha: ' +
      (cfg.cameras_ativas
        ? cfg.cameras_ativas + " câmera(s) ativa(s), 1 análise a cada " + Math.round(cfg.intervalo_foto_min / 60) + " h (até " + c.automaticas_restantes_hoje + " por dia)."
        : "nenhuma câmera ativa nas últimas 24 h, então nada automático está gastando.") +
      " A cota vira às " + virada + " (meia-noite no horário do Pacífico).</p>";

    var pm = (d.hoje && d.hoje.por_modo) || {};
    var hoje = Object.keys(pm).length
      ? '<ul class="dev-modos">' + Object.keys(pm).map(function (k) {
          return "<li><span>" + esc(MODO[k] || k) + "</span><b>" + pm[k].usadas + "</b>" +
            (pm[k].tentativas > pm[k].usadas ? '<em>' + (pm[k].tentativas - pm[k].usadas) + " falha(s)</em>" : "") + "</li>";
        }).join("") + "</ul>"
      : '<p class="dev__texto">Nenhuma chamada à IA hoje ainda.</p>';

    var erros = (d.erros || []).length
      ? '<ul class="dev-erros">' + d.erros.slice(0, 8).map(function (e) {
          return '<li title="' + esc(e.detalhe || "") + '"><span class="dev-erros__quando">' + quando(e.em) + "</span>" +
            '<span class="dev-erros__motivo">' + esc(e.motivo) + "</span>" +
            '<span class="dev-erros__meta">' + esc((MODO[e.modo] || e.modo || "") + (e.modelo ? " · " + e.modelo : "")) + "</span></li>";
        }).join("") + "</ul>"
      : '<p class="dev__texto">Nenhum erro da IA registrado.</p>';

    var maxSem = Math.max(1, Math.max.apply(null, (d.semana || []).map(function (s) { return s.usadas + s.cota; })));
    var semana = '<div class="dev-semana">' + (d.semana || []).map(function (s) {
      var dia = new Date(s.dia + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
      return '<div class="dev-semana__dia" title="' + s.usadas + " chamadas · " + numero(s.tokens) + " tokens" + (s.cota ? " · " + s.cota + " recusas por cota" : "") + '">' +
        '<div class="dev-semana__col"><span class="dev-semana__ok" style="height:' + Math.round((100 * s.usadas) / maxSem) + '%"></span>' +
        (s.cota ? '<span class="dev-semana__cota" style="height:' + Math.round((100 * s.cota) / maxSem) + '%"></span>' : "") + "</div>" +
        '<span class="dev-semana__n">' + s.usadas + "</span><span class=\"dev-semana__rot\">" + dia + "</span></div>";
    }).join("") + "</div>";

    corpo.innerHTML =
      '<div class="dev-status dev-status--' + st.classe + '"><p class="dev-status__titulo">' + st.titulo + "</p>" +
      '<p class="dev-status__texto">' + esc(frase) + "</p></div>" +
      '<h3 class="dev__secao">Cota por modelo (hoje)</h3>' + modelos +
      (d.claude ? '<p class="dev__nota">Claude (reserva paga) usado hoje: ' + d.claude.usadas + " chamada(s), " + numero(d.claude.tokens) + " tokens.</p>" : "") +
      '<h3 class="dev__secao">O que ainda dá para fazer hoje</h3>' + podeFazer +
      '<h3 class="dev__secao">Hoje, por função</h3>' + hoje +
      '<h3 class="dev__secao">Últimos erros da IA</h3>' + erros +
      '<h3 class="dev__secao">Últimos 7 dias</h3>' + semana +
      '<div class="dev__teste" id="devTeste"></div>' +
      '<div class="dev__acoes">' +
      '<button type="button" class="dev__btn" data-dev="testar">Testar a IA agora (gasta 1 chamada)</button>' +
      '<button type="button" class="dev__btn dev__btn--sec" data-dev="atualizar">Atualizar</button>' +
      '<button type="button" class="dev__btn dev__btn--sec" data-dev="bloquear">Bloquear</button>' +
      "</div>";
  }

  async function testar(btn) {
    btn.disabled = true;
    btn.textContent = "Testando…";
    var caixa = document.getElementById("devTeste");
    try {
      var r = await GrowAI.testarIa(senha());
      caixa.innerHTML = r.ok
        ? '<p class="dev-teste dev-teste--ok">A IA respondeu em ' + (r.ms / 1000).toFixed(1).replace(".", ",") + " s pelo " + esc(r.modelo) + ". Está tudo certo.</p>"
        : '<p class="dev-teste dev-teste--erro">' + esc(r.motivo) + '<span>' + esc(r.detalhe || "") + "</span></p>";
      await carregar();
    } catch (e) {
      caixa.innerHTML = '<p class="dev-teste dev-teste--erro">' + esc(e.message) + "</p>";
      btn.disabled = false;
      btn.textContent = "Testar a IA agora (gasta 1 chamada)";
    }
  }

  function abrir() {
    montar();
    ultimoFoco = document.activeElement;
    raiz.hidden = false;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () { raiz.classList.add("is-aberto"); });
    carregar();
  }

  function fechar() {
    if (!raiz || raiz.hidden) return;
    raiz.classList.remove("is-aberto");
    document.body.style.overflow = "";
    setTimeout(function () { raiz.hidden = true; }, 180);
    if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
  }

  document.addEventListener("click", function (ev) {
    if (ev.target.closest('[data-action="open-dev"]')) abrir();
  });
  document.addEventListener("keydown", function (ev) {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.closest && ev.target.closest('[data-action="open-dev"]')) {
      ev.preventDefault();
      abrir();
    }
  });

  window.DevPanel = { abrir: abrir };
})();
