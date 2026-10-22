(function () {
  "use strict";

  if (!window.GrowAI || !GrowAI.isAuthenticated()) {
    window.location.href = "login.html";
    return;
  }

  // 'indefinido' = a IA nao analisou (desligada, falhou ou deu timeout). E
  // neutro: a foto esta la, so nao tem diagnostico. Sem icone de alerta.
  var HEALTH_LABEL = { saudavel: "Saudável", atencao: "Atenção", indefinido: "Sem análise" };

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (minutes < 1) return "agora mesmo";
    if (minutes < 60) return minutes + " min atrás";
    var horas = Math.round(minutes / 60);
    if (horas < 48) return horas + "h atrás";
    return Math.round(horas / 24) + " dias atrás";
  }

  function setStatus(el, message, isError) {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("app-camera__status--error", !!isError);
    el.classList.toggle("m-app-camera__status--error", !!isError);
  }

  /* Anti-pragas: etiqueta ao lado de "Análise visual". Foto analisada antes
     do anti-pragas (pragas null) ou não analisada não mostra nada. */
  var PRAGAS_TEXTO = { sim: "Praga detectada", nao: "Sem pragas", incerto: "Pragas: não deu para ver", pendente: "Pragas: aguardando análise" };
  /* Foto analisada antes do anti-pragas existir (ou ainda sem análise): o
     anti-pragas aparece como "aguardando", para ficar claro que existe. */
  function pragasEstado(photo) {
    if (!photo) return null;
    return PRAGAS_TEXTO[photo.pragas] ? photo.pragas : "pendente";
  }
  function pragasHtml(photo) {
    if (!photo || !photo.image_url) return "";
    photo = Object.assign({}, photo, { pragas: pragasEstado(photo) });
    return '<span class="cam-pragas cam-pragas--' + photo.pragas + '"' +
      (photo.pragas_descricao ? ' title="' + escapeHtml(photo.pragas_descricao) + '"' : "") + ">" +
      PRAGAS_TEXTO[photo.pragas] + "</span>";
  }

  // Iluminação avaliada pela IA (cam-2.1.0): etiqueta ao lado das pragas.
  var LUZ_TEXTO = { pouca: "Pouca luz", boa: "Luz boa", muita: "Muita luz" };
  function luzHtml(photo) {
    if (!photo || !LUZ_TEXTO[photo.luz_nivel]) return "";
    return '<span class="cam-pragas cam-luz--' + photo.luz_nivel + '"' +
      (photo.luz_descricao ? ' title="' + escapeHtml(photo.luz_descricao) + '"' : "") + ">" +
      LUZ_TEXTO[photo.luz_nivel] + "</span>";
  }

  function cardHtml(station, photo, checkIcon, avisoIcon, hasBullet) {
    var titleRow = hasBullet
      ? '<div class="cam-card__title-row-left"><p class="cam-card__name">' +
        escapeHtml(station.name) +
        '</p><p class="cam-card__plant">' +
        escapeHtml(station.plant) +
        "</p></div>"
      : '<p class="cam-m-card__name">' +
        escapeHtml(station.name) +
        '</p><p class="cam-m-card__plant">' +
        escapeHtml(station.plant) +
        "</p>";

    if (!photo) {
      var emptyClass = hasBullet ? "cam-card__empty" : "cam-m-card__empty";
      if (hasBullet) {
        return (
          '<div class="cam-card__body"><div class="cam-card__title-row">' +
          titleRow +
          '</div><p class="' + emptyClass + '">Nenhuma imagem registrada ainda.</p></div>'
        );
      }
      return '<div class="cam-m-card__body">' + titleRow + '<p class="' + emptyClass + '">Nenhuma imagem registrada ainda.</p></div>';
    }

    var healthClass = photo.health_status === "atencao" ? "health--warn" : "health--ok";
    var healthIcon = photo.health_status === "atencao" ? avisoIcon : checkIcon;
    var healthLabel = HEALTH_LABEL[photo.health_status] || photo.health_status;

    if (hasBullet) {
      return (
        '<img class="cam-card__photo" alt="' + escapeHtml(station.name) + '" src="' + escapeHtml(photo.image_url) + '" />' +
        '<span class="cam-card__time">' + timeAgo(photo.captured_at) + "</span>" +
        '<div class="cam-card__body">' +
        '<div class="cam-card__title-row">' + titleRow +
        '<div class="cam-card__health cam-card__' + healthClass + '"><img alt="" src="' + healthIcon + '" />' + healthLabel + "</div>" +
        "</div>" +
        '<div class="cam-card__analysis"><div class="cam-analysis-head"><p class="cam-card__analysis-label">Análise visual</p><span class="cam-tags">' + luzHtml(photo) + pragasHtml(photo) + '</span></div><p class="cam-card__analysis-text">' +
        escapeHtml(photo.analysis_text) +
        "</p></div>" +
        '<button type="button" class="cam-card__btn" data-action="timeline">Ver histórico de imagens</button>' +
        "</div>"
      );
    }

    return (
      '<img class="cam-m-card__photo" alt="' + escapeHtml(station.name) + '" src="' + escapeHtml(photo.image_url) + '" />' +
      '<span class="cam-m-card__time">' + timeAgo(photo.captured_at) + "</span>" +
      '<div class="cam-m-card__body">' +
      titleRow +
      '<div class="cam-m-card__health cam-m-card__' + healthClass + '"><img alt="" src="' + healthIcon + '" />' + healthLabel + "</div>" +
      '<div class="cam-m-card__analysis"><div class="cam-analysis-head"><p class="cam-m-card__analysis-label">Análise visual</p><span class="cam-tags">' + luzHtml(photo) + pragasHtml(photo) + '</span></div><p class="cam-m-card__analysis-text">' +
      escapeHtml(photo.analysis_text) +
      "</p></div>" +
      '<button type="button" class="cam-m-card__btn" data-action="timeline">Ver histórico de imagens</button>' +
      "</div>"
    );
  }

  var CHECK_ICON = "assets/icons/app/icon-app-cam-check.svg";
  var AVISO_ICON = "assets/icons/app/icon-app-cam-aviso.svg";
  var ADD_STAR_ICON = "assets/icons/app/icon-app-star-sparkle.svg";

  var grid = document.getElementById("camGrid");
  var mList = document.getElementById("camMList");

  // Card "adicionar estação": sempre o último do grid/lista. Abre o mesmo
  // modal de nova estação da página Estações (js/station-modal.js).
  var ADD_CARD_HTML =
    '<button type="button" class="cam-add-card" data-action="add-station" aria-label="Adicionar estação">' +
    '<img alt="" src="' + ADD_STAR_ICON + '" /></button>';
  var M_ADD_CARD_HTML =
    '<button type="button" class="cam-m-add-card" data-action="add-station" aria-label="Adicionar estação">' +
    '<img alt="" src="' + ADD_STAR_ICON + '" /></button>';

  // O que está na tela agora, para o visor achar a estação pelo data-idx.
  var atual = { stations: [], photos: [], cams: [] };

  // Um card por estação (desktop e mobile), mais o card de adicionar.
  function render(stations, photos, cams) {
    atual = { stations: stations, photos: photos, cams: cams || [] };
    grid.innerHTML =
      stations
        .map(function (station, i) {
          return (
            '<div class="cam-card" data-action="open-cam" data-idx="' + i + '" role="button" tabindex="0"' +
            ' aria-label="Abrir câmera de ' + escapeHtml(station.name) + '">' +
            cardHtml(station, photos[i], CHECK_ICON, AVISO_ICON, true) +
            "</div>"
          );
        })
        .join("") + ADD_CARD_HTML;
    mList.innerHTML =
      stations
        .map(function (station, i) {
          return (
            '<div class="cam-m-card" data-action="open-cam" data-idx="' + i + '" role="button" tabindex="0"' +
            ' aria-label="Abrir câmera de ' + escapeHtml(station.name) + '">' +
            cardHtml(station, photos[i], CHECK_ICON, AVISO_ICON, false) +
            "</div>"
          );
        })
        .join("") + M_ADD_CARD_HTML;
  }

  function clearCards() {
    grid.innerHTML = "";
    mList.innerHTML = "";
  }

  // A altura da lista mobile varia com o número de estações e com o texto
  // de cada análise, então a altura da página é medida depois de renderizar.
  function updateMobileTabbar() {
    positionMobileTabbar({
      mobilePageId: "mAppCameraPage",
      contentSelectors: ["#mAppCameraStatus", "#camMList"],
    });
    applyScale();
  }

  async function load() {
    var appStatus = document.getElementById("appCameraStatus");
    var mStatus = document.getElementById("mAppCameraStatus");
    setStatus(appStatus, "Carregando câmeras...", false);
    setStatus(mStatus, "Carregando câmeras...", false);

    GrowAI.syncProfile();

    var stations;
    try {
      stations = await GrowAI.getStations();
    } catch (err) {
      clearCards();
      setStatus(appStatus, err.message, true);
      setStatus(mStatus, err.message, true);
      updateMobileTabbar();
      return;
    }

    if (stations.length === 0) {
      var emptyMsg = "Você ainda não tem estações. Crie a primeira no card abaixo!";
      setStatus(appStatus, emptyMsg, false);
      setStatus(mStatus, emptyMsg, false);
      render([], [], []);
      updateMobileTabbar();
      return;
    }
    setStatus(appStatus, "", false);
    setStatus(mStatus, "", false);

    /* Foto e estado das placas, em paralelo. O estado vem de /devices, onde o
       backend já usa o prazo certo para cada tipo: a 'cam' vive em deep sleep
       e só acorda a cada 30 min, então o prazo dela é de ~95 min, não 60 s. */
    var detalhes = await Promise.all(
      stations.map(function (s) {
        return Promise.all([
          GrowAI.getLatestPhoto(s.id).catch(function () { return null; }),
          GrowAI.getDevices(s.id).catch(function () { return []; }),
        ]);
      })
    );
    var photos = detalhes.map(function (d) { return d[0]; });
    var cams = detalhes.map(function (d) {
      var lista = d[1] || [];
      for (var i = 0; i < lista.length; i++) if (lista[i].tipo === "cam") return lista[i];
      return null; // nenhuma placa cam cadastrada nesta estação
    });

    render(stations, photos, cams);
    updateMobileTabbar();
  }

  document.addEventListener("click", function (event) {
    if (!event.target.closest('[data-action="add-station"]')) return;
    StationModal.open("create", null, function () {
      return load();
    });
  });

  // As setas giram enquanto recarrega (css/app-ux.css, .is-girando). Pelo
  // menos uma volta inteira, para o clique ter resposta visível mesmo quando
  // a rede responde rápido.
  function wireRefresh(btnId) {
    var btn = document.getElementById(btnId);
    btn.addEventListener("click", async function () {
      if (btn.classList.contains("is-girando")) return;
      btn.disabled = true;
      btn.classList.add("is-girando");
      btn.setAttribute("aria-busy", "true");
      var inicio = Date.now();
      try {
        await load();
      } finally {
        var falta = Math.max(0, 800 - (Date.now() - inicio));
        setTimeout(function () {
          btn.classList.remove("is-girando");
          btn.removeAttribute("aria-busy");
          btn.disabled = false;
        }, falta);
      }
    });
  }
  wireRefresh("cameraRefreshBtn");
  wireRefresh("mCameraRefreshBtn");


  /* ================= VISOR DA CÂMERA =================
     Abre ao clicar num card e mostra a foto grande.

     Mostra primeiro a última foto analisada pela IA e, se a estação tem
     câmera, liga o ao vivo por cima dela (ver iniciarAoVivo). A hora da foto
     continua embaixo: a análise da IA é daquela foto, não da imagem ao vivo. */

  var viewer = document.getElementById("camViewer");
  var viewerStage = document.getElementById("camViewerStage");
  var viewerName = document.getElementById("camViewerName");
  var viewerHealth = document.getElementById("camViewerHealth");
  var viewerMeta = document.getElementById("camViewerMeta");
  var viewerAnalysis = document.getElementById("camViewerAnalysis");
  var ultimoFoco = null;

  var OFFLINE_ICON = "assets/icons/app/icon-app-cam-aviso.svg";

  // A foto tem quantos minutos? Serve para avisar que está velha.
  function minutosDe(iso) {
    if (!iso) return null;
    return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  }

  function abrirVisor(idx) {
    var station = atual.stations[idx];
    if (!station) return;
    var photo = atual.photos[idx];
    var cam = atual.cams[idx];

    // Sem placa cadastrada e sem placa online contam como não conectada. São
    // casos diferentes, então a dica embaixo é diferente também.
    var conectada = !!(cam && cam.online);
    var temPlaca = !!cam;

    viewerName.textContent = station.name + " · " + station.plant;

    /* Sem foto nenhuma: não há o que mostrar, então o palco inteiro vira a
       mensagem. É o caso de câmera recém-instalada ou que nunca enviou. */
    if (!photo || !photo.image_url) {
      viewerStage.innerHTML =
        '<div class="cam-viewer__offline">' +
        '<img class="cam-viewer__offline-icon" alt="" src="' + OFFLINE_ICON + '" />' +
        '<p class="cam-viewer__offline-title">Câmera não conectada</p>' +
        '<p class="cam-viewer__offline-hint">' +
        (temPlaca
          ? "A placa está cadastrada, mas ainda não enviou nenhuma foto. Confira a alimentação e o Wi-Fi 2,4 GHz dela."
          : "Nenhuma ESP32-CAM foi cadastrada nesta estação ainda.") +
        "</p></div>";
      viewerHealth.textContent = "";
      viewerHealth.classList.remove("cam-viewer__health--warn");
      viewerMeta.textContent = temPlaca ? "Nenhuma imagem recebida." : "Sem câmera nesta estação.";
      viewerAnalysis.textContent = "";
    } else {
      /* Tem foto. Mesmo com a placa offline a foto é mostrada — ela é o último
         retrato real da planta, e esconder isso só tiraria informação. O aviso
         por cima deixa claro que é antiga. */
      var min = minutosDe(photo.captured_at);
      var html =
        '<img alt="Última foto de ' + escapeHtml(station.name) + '" src="' + escapeHtml(photo.image_url) + '" />';
      if (!conectada) {
        html +=
          '<p class="cam-viewer__stale">Câmera não conectada — esta é a última imagem recebida' +
          (min !== null ? " (" + timeAgo(photo.captured_at) + ")" : "") +
          ".</p>";
      }
      viewerStage.innerHTML = html;

      var st = photo.health_status;
      viewerHealth.innerHTML =
        '<img alt="" src="' + (st === "atencao" ? AVISO_ICON : CHECK_ICON) + '" />' +
        (HEALTH_LABEL[st] || st);
      viewerHealth.classList.toggle("cam-viewer__health--warn", st === "atencao");

      viewerMeta.textContent =
        (temPlaca ? "Análise da IA · foto de " : "Foto de ") + timeAgo(photo.captured_at) +
        (conectada ? " · câmera conectada" : " · câmera não conectada");
      viewerAnalysis.textContent = photo.analysis_text || "";
    }
    mostrarPragas(photo);

    // "Analisar saúde agora": só faz sentido se já existe foto.
    visorIdx = idx;
    acoes.hidden = !(photo && photo.image_url);
    btnAnalisar.disabled = false;
    btnAnalisar.textContent = "Analisar saúde agora";

    // Com câmera cadastrada, tenta o ao vivo por cima da última foto.
    pararAoVivo();
    if (temPlaca) iniciarAoVivo(station);

    ultimoFoco = document.activeElement;
    // O visor tem o próprio "Perguntar à V.E.R.A": o botão flutuante sai da frente.
    document.body.classList.add("visor-aberto");
    viewer.hidden = false;
    viewer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Força um frame antes de animar, senão a transição não roda.
    requestAnimationFrame(function () {
      viewer.classList.add("cam-viewer--open");
    });
    document.getElementById("camViewerClose").focus();
  }

  /* ---- "Analisar saúde agora" ----
     A IA analisa a foto mais recente na hora (POST /stations/:id/analisar-foto),
     sem esperar o ciclo automático. Leva de 5 a 30 s. */
  var acoes = document.getElementById("camViewerAcoes");
  var btnAnalisar = document.getElementById("camViewerAnalisar");
  var visorIdx = null;
  var analisouNoVisor = false;

  function mostrarAnalise(photo, station) {
    var st = photo.health_status;
    viewerHealth.innerHTML =
      '<img alt="" src="' + (st === "atencao" ? AVISO_ICON : CHECK_ICON) + '" />' + (HEALTH_LABEL[st] || st);
    viewerHealth.classList.toggle("cam-viewer__health--warn", st === "atencao");
    viewerAnalysis.textContent = photo.analysis_text || "";
    viewerMeta.textContent = "Análise da IA · foto de " + timeAgo(photo.captured_at) + " · analisada agora";
    mostrarPragas(photo);
  }

  // Linha "Pragas" do visor: o que a IA viu, com a descrição quando há praga.
  var viewerPragas = document.getElementById("camViewerPragas");
  // Linha "Iluminação" do visor (quadro sem flash, luz de cultivo acesa).
  var viewerLuz = document.getElementById("camViewerLuz");
  function mostrarLuz(photo) {
    if (!viewerLuz) return;
    var n = photo && photo.luz_nivel;
    viewerLuz.hidden = !n;
    if (!n) return;
    viewerLuz.className = "cam-viewer__luz cam-viewer__luz--" + n;
    viewerLuz.textContent =
      (n === "incerto" ? "Iluminação: não deu para avaliar" : "Iluminação: " + (n === "boa" ? "boa" : n === "pouca" ? "pouca luz" : "luz demais")) +
      (photo.luz_descricao ? " — " + photo.luz_descricao : "");
    if (!/[.!?…]$/.test(viewerLuz.textContent)) viewerLuz.textContent += ".";
  }

  function mostrarPragas(photo) {
    mostrarLuz(photo);
    if (!viewerPragas) return;
    var p = photo && photo.image_url ? pragasEstado(photo) : null;
    viewerPragas.hidden = !p;
    if (!p) return;
    viewerPragas.className = "cam-viewer__pragas cam-viewer__pragas--" + p;
    viewerPragas.textContent =
      p === "sim" ? ("Praga detectada" + (photo.pragas_descricao ? ": " + photo.pragas_descricao : "")).replace(/[.!?…]*$/, ".")
      : p === "nao" ? "Anti-pragas: nenhuma praga visível nesta foto."
      : p === "pendente" ? "Anti-pragas: esta foto ainda não foi verificada. Toque em \"Analisar saúde agora\" ou aguarde a próxima análise."
      : "Anti-pragas: a foto não permitiu avaliar (escura, desfocada ou planta fora do quadro).";
  }

  // "Perguntar à V.E.R.A": abre o chat já com a análise desta foto escrita.
  document.getElementById("camViewerVera").addEventListener("click", function () {
    var station = atual.stations[visorIdx];
    var photo = atual.photos[visorIdx];
    if (!window.Vera || !station) return;
    var sobre = photo && photo.analysis_text ? ' A análise da foto disse: "' + photo.analysis_text + '"' : "";
    window.Vera.abrir("Sobre a minha " + station.plant + " (" + station.name + ")." + sobre + " O que eu posso fazer?");
  });

  btnAnalisar.addEventListener("click", async function () {
    var idx = visorIdx;
    var station = atual.stations[idx];
    if (!station) return;
    btnAnalisar.disabled = true;
    btnAnalisar.textContent = "Analisando… (até 1 min)";
    try {
      var r = await GrowAI.analyzePhotoNow(station.id);
      if (visorIdx !== idx) return; // fechou ou trocou de câmera no meio
      if (r.ok && r.foto) {
        atual.photos[idx] = Object.assign({}, atual.photos[idx], r.foto);
        mostrarAnalise(atual.photos[idx], station);
        analisouNoVisor = true;
        if (typeof window.showToast === "function") window.showToast("Análise atualizada.");
      } else {
        var cota = /429|quota/i.test((r && r.motivo) || "");
        if (typeof window.showToast === "function") {
          window.showToast(cota
            ? "A IA atingiu o limite de análises de hoje. Tente amanhã."
            : "A IA não conseguiu analisar agora. Tente de novo em alguns minutos.", "error");
        }
      }
    } catch (e) {
      if (typeof window.showToast === "function") window.showToast(e.message || "Não foi possível analisar.", "error");
    } finally {
      if (visorIdx === idx) {
        btnAnalisar.disabled = false;
        btnAnalisar.textContent = "Analisar saúde agora";
      }
    }
  });

  /* ---- ao vivo (cam-2.0.0 em diante) ----
     A câmera fica conectada ao backend e, enquanto este visor está aberto,
     manda ~2 quadros por segundo (GrowAI.assistirCamera). O primeiro quadro
     substitui a última foto; até lá ela continua na tela, com um aviso. A
     imagem ao vivo sai roxa por causa da luz de cultivo — a foto da IA é
     tirada com a luz apagada e continua descrita embaixo. */
  var pararCam = null;
  var urlQuadro = null;

  function avisoAoVivo(texto) {
    var el = viewerStage.querySelector(".cam-viewer__live-status");
    if (!el) {
      el = document.createElement("p");
      el.className = "cam-viewer__live-status";
      viewerStage.appendChild(el);
    }
    el.textContent = texto || "";
    el.hidden = !texto;
    // Uma mensagem por vez: com aviso do ao vivo, some o "câmera não conectada".
    var velho = viewerStage.querySelector(".cam-viewer__stale");
    if (velho) velho.hidden = !!texto;
  }

  function iniciarAoVivo(station) {
    avisoAoVivo("Conectando à câmera ao vivo…");
    pararCam = GrowAI.assistirCamera(station.id, {
      onStatus: function (m) {
        /* Desconectada: se o palco já diz "não conectada (há X)", ele basta;
           senão (o cadastro dizia online e o ao vivo não achou), avisa. */
        if (!m.cam_online) {
          avisoAoVivo(viewerStage.querySelector(".cam-viewer__stale") ? "" : "Câmera desconectada — esta é a última imagem recebida.");
        }
        else if (!urlQuadro) avisoAoVivo("Câmera conectada, esperando a imagem…");
        else avisoAoVivo("");
      },
      onQuadro: function (blob) {
        var img = viewerStage.querySelector(".cam-viewer__live-img");
        if (!img) {
          viewerStage.innerHTML =
            '<img class="cam-viewer__live-img" alt="Câmera de ' + escapeHtml(station.name) + ' ao vivo" />' +
            '<span class="cam-viewer__live-badge" title="A luz de cultivo deixa a imagem ao vivo roxa; a foto da IA é tirada com a luz apagada">AO VIVO</span>';
          img = viewerStage.querySelector(".cam-viewer__live-img");
        }
        /* Carrega o quadro novo fora da tela e só então troca: trocar o src
           direto deixa a imagem em branco (ou "quebrada") até o JPEG
           decodificar, e o ao vivo piscaria a cada quadro. */
        var novo = URL.createObjectURL(new Blob([blob], { type: "image/jpeg" }));
        var pre = new Image();
        pre.onload = function () {
          if (!pararCam) { URL.revokeObjectURL(novo); return; } // visor já fechou
          var anterior = urlQuadro;
          urlQuadro = novo;
          img.src = novo;
          if (anterior) URL.revokeObjectURL(anterior);
          avisoAoVivo("");
        };
        pre.onerror = function () { URL.revokeObjectURL(novo); };
        pre.src = novo;
      },
    });
  }

  function pararAoVivo() {
    if (pararCam) pararCam();
    pararCam = null;
    if (urlQuadro) URL.revokeObjectURL(urlQuadro);
    urlQuadro = null;
  }

  function fecharVisor() {
    if (viewer.hidden) return;
    document.body.classList.remove("visor-aberto");
    pararAoVivo();
    visorIdx = null;
    // Houve análise nova: a grade de cards atualiza ao fechar.
    if (analisouNoVisor) {
      analisouNoVisor = false;
      load();
    }
    viewer.classList.remove("cam-viewer--open");
    viewer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    // Espera a animação de saída antes de esconder de verdade.
    setTimeout(function () {
      viewer.hidden = true;
      viewerStage.innerHTML = ""; // solta a data URL da memória
    }, 180);
    if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
    ultimoFoco = null;
  }

  document.getElementById("camViewerClose").addEventListener("click", fecharVisor);

  document.addEventListener("click", function (event) {
    if (event.target.closest('[data-action="close-cam"]')) {
      fecharVisor();
      return;
    }
    // "Ver histórico de imagens" abre a linha do tempo (e não o visor, que é
    // o clique no resto do card).
    var tl = event.target.closest('[data-action="timeline"]');
    if (tl) {
      var dono = tl.closest("[data-idx]");
      var st = dono && atual.stations[Number(dono.dataset.idx)];
      if (st && window.Timeline) window.Timeline.abrir(st);
      return;
    }
    var card = event.target.closest('[data-action="open-cam"]');
    if (card) abrirVisor(Number(card.dataset.idx));
  });

  // Botão "Linha do tempo" do visor: fecha o visor e abre a linha da estação.
  document.getElementById("camViewerTimeline").addEventListener("click", function () {
    var st = atual.stations[visorIdx];
    if (!st || !window.Timeline) return;
    fecharVisor();
    setTimeout(function () { window.Timeline.abrir(st); }, 190);
  });

  // Teclado: Enter/Espaço abre o card (ele é role="button"), Esc fecha o visor.
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      fecharVisor();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    var card = event.target.closest && event.target.closest('[data-action="open-cam"]');
    if (!card) return;
    event.preventDefault();
    abrirVisor(Number(card.dataset.idx));
  });

  // ---- canvas scaling ----
  var applyScale = initResponsiveCanvas({
    desktopPageId: "appCameraPage",
    desktopWrapperSelector: ".app-camera-wrapper",
    mobilePageId: "mAppCameraPage",
    mobileWrapperSelector: ".m-app-camera-wrapper",
  });

  // Foto nova analisada (o backend avisa pelo WebSocket): recarrega a tela.
  GrowAI.aoVivo(function (msg) {
    if (msg && msg.tipo === "foto") load();
  });

  load();
})();
