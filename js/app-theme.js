(function () {
  "use strict";

  // Tema claro/escuro do APP (app-*.html). Usa a MESMA preferência do site
  // (localStorage "tracklink_theme", ver js/theme.js): quem escolheu o claro
  // no site entra no app claro, e vice-versa.
  //
  // Carregado no <head>, sem defer: o data-theme vai no <html> antes da
  // primeira pintura, então a página não pisca escura antes de ficar clara.
  // As cores ficam em css/app-theme.css. O botão (sol/lua, o mesmo ícone do
  // site) é criado aqui, flutuando no canto de baixo da tela.

  var CHAVE = "tracklink_theme";
  var COR_BARRA = { dark: "#152623", light: "#fcfcfd" }; // <meta theme-color>
  var raiz = document.documentElement;

  function lerTema() {
    try {
      return localStorage.getItem(CHAVE) === "light" ? "light" : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function gravarTema(tema) {
    try {
      localStorage.setItem(CHAVE, tema);
    } catch (e) {
      /* sem storage (aba anônima): vale só nesta página */
    }
  }

  function aplicar(tema) {
    raiz.setAttribute("data-theme", tema);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", COR_BARRA[tema]);
    document.querySelectorAll("[data-tema-botao]").forEach(function (b) {
      var claro = tema === "light";
      b.setAttribute("aria-pressed", claro ? "true" : "false");
      b.setAttribute("aria-label", claro ? "Mudar para o modo escuro" : "Mudar para o modo claro");
      b.title = claro ? "Modo escuro" : "Modo claro";
    });
  }

  function atual() {
    return raiz.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function alternar() {
    var proximo = atual() === "light" ? "dark" : "light";
    gravarTema(proximo);
    // Troca com fade suave onde o navegador suporta; nos outros, na hora.
    var semMovimento = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !semMovimento) {
      raiz.classList.add("tema-trocando");
      var t = document.startViewTransition(function () { aplicar(proximo); });
      t.finished.finally(function () { raiz.classList.remove("tema-trocando"); });
    } else {
      aplicar(proximo);
    }
  }

  aplicar(lerTema());

  // Um botão só, flutuante no canto de baixo (como o "voltar ao topo" do
  // site): no computador ao lado da V.E.R.A, no celular acima da barra de
  // abas. O topo do app já tem coisa demais.
  function criarBotoes() {
    if (document.querySelector("[data-tema-botao]")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "app-theme-fab";
    b.setAttribute("data-tema-botao", "");
    b.addEventListener("click", alternar);
    document.body.appendChild(b);
    aplicar(atual()); // rótulo e aria do botão recém-criado
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", criarBotoes);
  else criarBotoes();

  // Outra aba mudou o tema: esta acompanha.
  window.addEventListener("storage", function (e) {
    if (e.key === CHAVE) aplicar(lerTema());
  });

  window.GrowAITema = { alternar: alternar, atual: atual };
})();
