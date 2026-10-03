(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  var TOGGLE_ON = { d: "assets/icons/app/icon-cfg-toggle-on-d.svg", m: "assets/icons/app/icon-cfg-toggle-on.svg" };
  var TOGGLE_OFF = { d: "assets/icons/app/icon-cfg-toggle-off-d.svg", m: "assets/icons/app/icon-cfg-toggle-off.svg" };

  var TOGGLE_IDS = {
    health_alerts: { d: "cfgToggleHealth", m: "mCfgToggleHealth" },
    watering_updates: { d: "cfgToggleWatering", m: "mCfgToggleWatering" },
    weekly_reports: { d: "cfgToggleWeekly", m: "mCfgToggleWeekly" },
  };

  var settingsCache = null;

  function applyToggleVisual(key, value) {
    var ids = TOGGLE_IDS[key];
    if (!ids) return;
    var icon = value ? TOGGLE_ON : TOGGLE_OFF;
    var label = value ? "Ativado" : "Desativado";
    [
      [document.getElementById(ids.d), icon.d],
      [document.getElementById(ids.m), icon.m],
    ].forEach(function (pair) {
      var el = pair[0];
      if (!el) return;
      var img = el.querySelector("img");
      img.src = pair[1];
      img.alt = label;
    });
  }

  /* Conta PLACAS online, nao estacoes.
     Antes recebia stations.length, entao "2 dispositivos conectados" na verdade
     queria dizer "2 estacoes" - e marcava como conectado mesmo sem nenhuma
     placa cadastrada. Agora: `online` de cada placa em /stations/:id/devices
     (o backend usa o prazo certo para cada tipo; a cam vive em deep sleep). */
  function renderDeviceCount(count, total) {
    var els = [document.getElementById("cfgWifiSubtitle"), document.getElementById("mCfgWifiSubtitle")];
    var label =
      count == null
        ? "Não foi possível verificar"
        : total === 0
        ? "Nenhuma placa cadastrada"
        : count === 0
        ? (total === 1 ? "1 placa cadastrada, offline" : total + " placas cadastradas, todas offline")
        : count === 1
        ? "1 placa online" + (total > 1 ? " de " + total : "")
        : count + " placas online de " + total;
    els.forEach(function (el) {
      if (el) el.textContent = label;
    });
  }

  function renderProfile(user) {
    var nameEls = [document.getElementById("cfgProfileName"), document.getElementById("mCfgProfileName")];
    var emailEls = [document.getElementById("cfgProfileEmail"), document.getElementById("mCfgProfileEmail")];
    nameEls.forEach(function (el) { if (el) el.textContent = user.name; });
    emailEls.forEach(function (el) { if (el) el.textContent = user.email; });

    var avatarUrl = GrowAI.avatarUrl(user);
    if (avatarUrl) {
      [document.getElementById("cfgProfileIcon"), document.getElementById("mCfgProfileIcon")].forEach(function (el) {
        if (el) el.src = avatarUrl;
      });
      document.querySelectorAll(".app-header__avatar img").forEach(function (img) {
        img.src = avatarUrl;
      });
    }
  }

  // ---- edit profile modal ----
  var profileModal = document.getElementById("profileModal");
  var profileForm = document.getElementById("profileForm");
  var profileError = document.getElementById("profileModalError");
  var profileSubmit = document.getElementById("profileModalSubmit");
  var profileAvatarInput = document.getElementById("profileAvatarInput");
  var profileAvatarPreview = document.getElementById("profileAvatarPreview");

  function openProfileModal() {
    var user = GrowAI.getUser();
    if (!user) return;
    profileError.hidden = true;
    profileModal.classList.remove("is-closing");
    profileForm.reset();
    profileForm.name.value = user.name;
    document.getElementById("profileEmailDisplay").value = user.email;
    profileAvatarPreview.src = GrowAI.avatarUrl(user) || "assets/images/app/img-app-avatar.svg";
    profileModal.hidden = false;
  }

  function closeProfileModal() {
    profileModal.classList.add("is-closing");
    window.setTimeout(function () {
      profileModal.hidden = true;
      profileModal.classList.remove("is-closing");
    }, 180);
  }

  // A foto vai pro banco como texto (sem storage de arquivos na Vercel), então
  // é recortada em quadrado e reduzida aqui no navegador antes do envio: uma
  // foto de celular de vários MB vira ~20-40 KB, e o limite do servidor (1 MB)
  // nunca é problema.
  var AVATAR_SIZE = 256;
  var AVATAR_MAX_BYTES = 1024 * 1024;

  function resizeAvatar(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        var canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(AVATAR_SIZE, side);
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff"; // PNG com transparência vira JPEG: fundo branco em vez de preto
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          img,
          (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
          0, 0, canvas.width, canvas.height
        );
        canvas.toBlob(
          function (blob) { blob ? resolve(blob) : reject(new Error("Não foi possível processar a imagem.")); },
          "image/jpeg",
          0.85
        );
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Não foi possível ler essa imagem. Use PNG, JPG ou WEBP."));
      };
      img.src = url;
    });
  }

  profileAvatarInput.addEventListener("change", function () {
    var file = profileAvatarInput.files[0];
    if (!file) return;
    profileAvatarPreview.src = URL.createObjectURL(file);
  });

  profileForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    profileError.hidden = true;
    profileSubmit.disabled = true;
    profileSubmit.textContent = "Salvando...";

    try {
      var formData = new FormData();
      formData.append("name", profileForm.name.value);
      var file = profileAvatarInput.files[0];
      if (file) {
        var avatar = await resizeAvatar(file);
        if (avatar.size > AVATAR_MAX_BYTES) throw new Error("Imagem muito grande (máx. 1 MB).");
        formData.append("avatar", avatar, "avatar.jpg");
      }

      var updated = await GrowAI.updateProfile(formData);
      renderProfile(updated);
      closeProfileModal();
      showToast("Perfil atualizado com sucesso.");
    } catch (err) {
      profileError.textContent = err.message;
      profileError.hidden = false;
    } finally {
      profileSubmit.disabled = false;
      profileSubmit.textContent = "Salvar";
    }
  });

  document.addEventListener("click", async function (event) {
    if (event.target.closest('[data-action="edit-profile"]')) {
      openProfileModal();
      return;
    }
    if (event.target.closest('[data-action="close-profile-modal"]')) {
      closeProfileModal();
      return;
    }

    var row = event.target.closest('[data-action="toggle"]');
    if (!row || row.classList.contains("is-saving")) return;
    if (!settingsCache) return; // still waiting on the initial GET — nothing to flip yet
    var key = row.dataset.key;
    var newValue = !settingsCache[key];

    // Optimistic update, rolled back if the request fails. is-saving blocks
    // a second click on the same row while the PATCH is still in flight.
    settingsCache[key] = newValue;
    applyToggleVisual(key, newValue);
    row.classList.add("is-saving");

    try {
      var payload = {};
      payload[key] = newValue;
      settingsCache = await GrowAI.updateNotificationSettings(payload);
      Object.keys(TOGGLE_IDS).forEach(function (k) {
        applyToggleVisual(k, settingsCache[k]);
      });
    } catch (err) {
      settingsCache[key] = !newValue;
      applyToggleVisual(key, !newValue);
      showToast(err.message, "error");
    } finally {
      row.classList.remove("is-saving");
    }
  });

  async function load() {
    // Paints instantly from the cached session (avoids a blank flash), then
    // replaces it with a fresh GET /auth/me so the fields reflect whatever
    // actually changed server-side since login (e.g. edited on another tab).
    var cachedUser = GrowAI.getUser();
    if (cachedUser) renderProfile(cachedUser);
    try {
      renderProfile(await GrowAI.getMe());
    } catch (err) {
      // keeps the cached profile on screen if the fresh fetch fails
    }

    try {
      settingsCache = await GrowAI.getNotificationSettings();
      Object.keys(TOGGLE_IDS).forEach(function (key) {
        applyToggleVisual(key, settingsCache[key]);
      });
    } catch (err) {
      // toggles keep their default markup state on failure
    }

    try {
      var stations = await GrowAI.getStations();
      var porEstacao = await Promise.all(
        stations.map(function (s) {
          return GrowAI.getDevices(s.id).catch(function () { return []; });
        })
      );
      var todas = porEstacao.reduce(function (acc, l) { return acc.concat(l || []); }, []);
      var online = todas.filter(function (d) { return d.online; }).length;
      renderDeviceCount(online, todas.length);
    } catch (err) {
      renderDeviceCount(null);
    }
  }


  // Nome de estação e de planta sao digitados pelo usuario e entram em
  // innerHTML abaixo: escapar e obrigatorio.
  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  /* ================= CONEXÃO ESP32 =================
     A linha "Conexão ESP32" abre esta tela, com as placas de cada estação e o
     passo a passo de configurar.

     Por que o app não configura o Wi-Fi da placa: ele fala com o backend pela
     internet, e o backend não alcança a placa (é serverless, quem inicia a
     conversa é sempre ela). Pior: antes de ter Wi-Fi a placa não está em rede
     nenhuma, então não haveria por onde falar com ela. Por isso a senha é
     digitada no PORTAL da própria placa, e esta tela serve para acompanhar e
     para lembrar como se faz. */

  var espModal = document.getElementById("espModal");
  var espBody = document.getElementById("espModalBody");
  var espFocoAnterior = null;

  var TIPO_PLACA = { main: "Placa principal", cam: "Câmera" };
  var FAZ_PLACA = {
    main: "sensores, bomba, luz e ventilação",
    cam: "uma foto a cada 30 min",
  };

  function espQuando(iso) {
    if (!iso) return "nunca falou com o servidor";
    var min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 1) return "agora mesmo";
    if (min < 60) return "há " + min + " min";
    if (min < 48 * 60) return "há " + Math.round(min / 60) + " h";
    return "há " + Math.round(min / 1440) + " dias";
  }

  function espPlacaHtml(d) {
    var on = !!d.online;
    return (
      '<div class="esp-placa">' +
      '<span class="esp-placa__dot ' + (on ? "esp-placa__dot--on" : "esp-placa__dot--off") + '"></span>' +
      '<span class="esp-placa__info">' +
      '<span class="esp-placa__tipo">' + escapeHtml(TIPO_PLACA[d.tipo] || d.tipo) + "</span>" +
      '<span class="esp-placa__meta">' + escapeHtml(FAZ_PLACA[d.tipo] || "") +
      " · " + escapeHtml(espQuando(d.last_seen)) +
      (d.fw ? " · " + escapeHtml(d.fw) : "") +
      "</span></span>" +
      '<span class="esp-placa__estado' + (on ? "" : " esp-placa__estado--off") + '">' +
      (on ? "Online" : "Offline") +
      "</span></div>"
    );
  }

  var ESP_AJUDA_HTML =
    '<div class="esp-ajuda">' +
    '<p class="esp-ajuda__titulo">Como conectar uma placa ao Wi-Fi</p>' +
    "<ol>" +
    "<li>Ligue a placa. Sem rede configurada, ela cria a própria: <code>GrowAI-setup</code> (senha <code>growai123</code>).</li>" +
    "<li>Conecte o celular nessa rede. A página de configuração abre sozinha; se não abrir, acesse <code>192.168.4.1</code>.</li>" +
    "<li>Escolha a sua rede Wi-Fi (só <strong>2,4 GHz</strong>), digite a senha e cole a chave da placa.</li>" +
    "<li>Salve. Ela reinicia já conectada e aparece aqui como Online.</li>" +
    "</ol>" +
    '<p class="esp-ajuda__nota">' +
    "Para reconfigurar depois: na placa principal, segure o botão <strong>BOOT</strong> ao ligar. " +
    "A câmera abre o portal sozinha depois de 3 tentativas falhas." +
    "</p>" +
    '<p class="esp-ajuda__nota">' +
    "<strong>A chave da placa não aparece aqui de propósito.</strong> O servidor guarda só um resumo " +
    "criptográfico dela, nunca a chave em si — então nem ele consegue mostrá-la de volta. " +
    "Ela é exibida uma única vez, no computador, ao rodar <code>npm run criar-dispositivo</code>. " +
    "Se você perdeu, gere outra: a anterior deixa de valer." +
    "</p>" +
    "</div>";

  function espAbrir() {
    espBody.innerHTML = '<p class="esp-vazio">Carregando placas...</p>';
    espFocoAnterior = document.activeElement;
    espModal.hidden = false;
    espModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () {
      espModal.classList.add("esp-modal--open");
    });
    document.getElementById("espModalClose").focus();
    espCarregar();
  }

  function espFechar() {
    if (espModal.hidden) return;
    espModal.classList.remove("esp-modal--open");
    espModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    setTimeout(function () {
      espModal.hidden = true;
    }, 170);
    if (espFocoAnterior && espFocoAnterior.focus) espFocoAnterior.focus();
    espFocoAnterior = null;
  }

  async function espCarregar(chaveNova) {
    var estacoes;
    try {
      estacoes = await GrowAI.getStations();
    } catch (err) {
      espBody.innerHTML = '<p class="esp-vazio">Não foi possível carregar: ' + escapeHtml(err.message) + "</p>";
      return;
    }

    if (!estacoes.length) {
      espBody.innerHTML =
        '<p class="esp-vazio">Você ainda não tem estações. Crie uma na tela Estações para poder cadastrar placas.</p>' +
        ESP_AJUDA_HTML;
      return;
    }

    var placas = await Promise.all(
      estacoes.map(function (e) {
        return GrowAI.getDevices(e.id).catch(function () {
          return null; // null = não deu para consultar; [] = consultou e não há placa
        });
      })
    );

    var html = estacoes
      .map(function (e, i) {
        var lista = placas[i];
        var corpo;
        if (lista === null) {
          corpo = '<p class="esp-vazio">Não foi possível consultar as placas desta estação.</p>';
        } else if (!lista.length) {
          corpo = '<p class="esp-vazio">Nenhuma placa cadastrada ainda.</p>';
        } else {
          corpo = lista.map(espPlacaHtml).join("");
        }
        return (
          '<div class="esp-estacao" data-estacao="' + e.id + '">' +
          '<p class="esp-estacao__nome">' + escapeHtml(e.name) + " · " + escapeHtml(e.plant) + "</p>" +
          corpo +
          espBotoesHtml(e.id, lista) +
          '<div class="esp-chave-slot"></div>' +
          "</div>"
        );
      })
      .join("");

    espBody.innerHTML = html + ESP_AJUDA_HTML;

    /* Acabou de gerar uma chave? A lista foi redesenhada, entao a caixa dela
       precisa voltar — senao a unica copia da chave sumiria da tela. */
    if (chaveNova) {
      var est = espBody.querySelector('.esp-estacao[data-estacao="' + chaveNova.estacao + '"]');
      if (est) espMostraChave(est.querySelector(".esp-chave-slot"), chaveNova.tipo, chaveNova.dados);
    }
  }

  document.addEventListener("click", function (event) {
    if (event.target.closest('[data-action="close-esp32"]')) {
      espFechar();
      return;
    }
    if (event.target.closest('[data-action="open-esp32"]')) espAbrir();
  });

  document.getElementById("espModalClose").addEventListener("click", espFechar);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      espFechar();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    var linha = event.target.closest && event.target.closest('[data-action="open-esp32"]');
    if (!linha) return;
    event.preventDefault();
    espAbrir();
  });


  /* Botoes de cadastrar placa e a caixa que mostra a chave.
     A chave vem no POST e nunca mais: por isso ela aparece numa caixa
     destacada, com botao de copiar e aviso explicito. */
  function espBotoesHtml(estacaoId, lista) {
    if (lista === null) return "";
    var temMain = lista.some(function (d) { return d.tipo === "main"; });
    var temCam = lista.some(function (d) { return d.tipo === "cam"; });
    function botao(tipo, tem) {
      var rotulo = tem
        ? "Gerar nova chave da " + (tipo === "main" ? "placa principal" : "câmera")
        : "Cadastrar " + (tipo === "main" ? "placa principal" : "câmera");
      return (
        '<button type="button" class="esp-btn' + (tem ? " esp-btn--secundario" : "") + '"' +
        ' data-action="add-placa" data-estacao="' + estacaoId + '" data-tipo="' + tipo + '">' +
        rotulo + "</button>"
      );
    }
    return '<div class="esp-acoes">' + botao("main", temMain) + botao("cam", temCam) + "</div>";
  }

  function espMostraChave(caixa, tipo, dados) {
    var nomeTipo = tipo === "main" ? "placa principal" : "câmera";
    caixa.innerHTML =
      '<div class="esp-chave">' +
      '<p class="esp-chave__titulo">Chave da ' + nomeTipo + "</p>" +
      '<p class="esp-chave__aviso">' +
      (dados.substituiu_anterior ? "A chave anterior desta placa <strong>parou de valer agora</strong>. " : "") +
      "Copie antes de fechar: por segurança, ela <strong>não aparece de novo</strong>." +
      "</p>" +
      '<code class="esp-chave__valor" id="espChaveValor">' + escapeHtml(dados.chave) + "</code>" +
      '<button type="button" class="esp-btn" data-action="copiar-chave">Copiar chave</button>' +
      "</div>";
  }

  document.addEventListener("click", async function (event) {
    var btnCopiar = event.target.closest('[data-action="copiar-chave"]');
    if (btnCopiar) {
      var valor = document.getElementById("espChaveValor");
      if (!valor) return;
      try {
        await navigator.clipboard.writeText(valor.textContent);
        btnCopiar.textContent = "Copiada!";
        setTimeout(function () { btnCopiar.textContent = "Copiar chave"; }, 1800);
      } catch (e) {
        // clipboard bloqueado (http sem https, permissao negada): seleciona
        // o texto para o usuario copiar com Ctrl+C
        var r = document.createRange();
        r.selectNodeContents(valor);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        btnCopiar.textContent = "Selecionada — Ctrl+C";
      }
      return;
    }

    var btn = event.target.closest('[data-action="add-placa"]');
    if (!btn) return;

    var tipo = btn.dataset.tipo;
    var estacaoId = btn.dataset.estacao;
    var rotuloOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Gerando...";
    try {
      var d = await GrowAI.createDevice(estacaoId, tipo);
      // A caixa da chave entra logo abaixo dos botoes daquela estacao.
      var caixa = btn.closest(".esp-estacao").querySelector(".esp-chave-slot");
      espMostraChave(caixa, tipo, d);
      // Recarrega a lista para a placa nova aparecer com o estado dela.
      await espCarregar(d.chave ? { estacao: estacaoId, tipo: tipo, dados: d } : null);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = rotuloOriginal;
      if (window.showToast) showToast(err.message, "error");
    }
  });

  // ---- canvas scaling ----


  initResponsiveCanvas({
    desktopPageId: "appConfiguracoesPage",
    desktopWrapperSelector: ".app-configuracoes-wrapper",
    mobilePageId: "mAppConfiguracoesPage",
    mobileWrapperSelector: ".m-app-configuracoes-wrapper",
  });

  load();
})();
