(function () {
  "use strict";

  // Política de senha no navegador: mínimo de 8 caracteres e pelo menos 1
  // caractere especial. Serve só de FEEDBACK para o usuário - quem garante a
  // regra de verdade é o backend (backend/services/passwordPolicy.js), que
  // deve ficar em sincronia com este arquivo.
  //
  // Uso:
  //   <ul class="pw-hint" id="dica"><li data-rule="length">…</li><li data-rule="special">…</li></ul>
  //   PasswordPolicy.attach(inputSenha, document.getElementById("dica"));
  //
  // attach() atualiza a lista enquanto a pessoa digita (cinza -> verde quando
  // a regra é cumprida, vermelho se já digitou e ainda não cumpre) e marca o
  // campo como inválido (setCustomValidity), o que impede o envio do
  // formulário e mostra a mensagem no próprio campo.

  var MIN_LENGTH = 8;
  var MAX_LENGTH = 72; // limite do bcrypt no backend
  // qualquer símbolo que não seja letra, dígito ou espaço ("ç" não conta)
  var SPECIAL_CHAR_RE = /[^\p{L}\p{N}\s]/u;

  function check(password) {
    var value = password || "";
    var result = {
      length: value.length >= MIN_LENGTH,
      max: value.length <= MAX_LENGTH,
      special: SPECIAL_CHAR_RE.test(value),
    };
    result.ok = result.length && result.max && result.special;
    return result;
  }

  // Mesmas mensagens do backend.
  function message(password) {
    var r = check(password);
    if (!password) return "Informe uma senha.";
    if (!r.length) return "A senha deve ter no mínimo " + MIN_LENGTH + " caracteres.";
    if (!r.max) return "A senha deve ter no máximo " + MAX_LENGTH + " caracteres.";
    if (!r.special) return "A senha deve ter pelo menos 1 caractere especial (ex.: ! @ # $ % &).";
    return "";
  }

  function attach(input, hintList) {
    if (!input) return;

    function update() {
      var value = input.value;
      var r = check(value);
      if (hintList) {
        Array.prototype.forEach.call(hintList.querySelectorAll("[data-rule]"), function (item) {
          var met = !!r[item.getAttribute("data-rule")];
          item.classList.toggle("is-met", met);
          item.classList.toggle("is-unmet", !met && value.length > 0);
        });
      }
      input.setCustomValidity(r.ok ? "" : message(value));
    }

    input.addEventListener("input", update);
    update();
  }

  window.PasswordPolicy = { check: check, message: message, attach: attach, MIN_LENGTH: MIN_LENGTH };
})();
