(function () {
  "use strict";

  // Painel "Controlar placa": mostra a placa principal de uma estação ao vivo
  // e manda comandos manuais para os relés. Markup injetado na primeira
  // abertura, como o js/station-modal.js; visual em css/control-modal.css
  // (painel e overlay reaproveitados de css/station-modal.css).
  //
  //   ControlModal.open(station);
  //
  // De onde vem cada coisa:
  //   - estado ao vivo: GrowAI.aoVivo (WebSocket), a cada fala da placa;
  //   - reserva: GET readings/latest a cada 5 s, caso o WebSocket caia;
  //   - comandos: POST commands. A placa pega na próxima telemetria (5 s com
  //     o app aberto) e confirma em ~1 s. Os limites de segurança são do
  //     firmware; o app só não oferece o que a placa vai recusar.

  var RELES = [
    { id: "bomba", nome: "Bomba d'água", ligar: "Regar 30 s", dur: 30 },
    { id: "nutri", nome: "Nutriente", ligar: "Dosar 5 s", dur: 5 },
    { id: "luz", nome: "Luz", ligar: "Acender 1 h", dur: 3600 },
    // Ventiladores e luz UV no mesmo relé: ligar um liga o outro.
    { id: "vent", nome: "Ventilação + luz UV", ligar: "Ligar 5 min", dur: 300 },
  ];
  var ESTADOS = { MONITORANDO: "Monitorando", REGANDO: "Regando", ABSORVENDO: "Absorvendo" };
  var NUTRI_MAX_S = 30;
  // Sem confirmação nesse prazo, o comando provavelmente não chegou. A bomba
  // tinha mais folga porque a placa antiga (até main-1.2.0) não falava com o
  // servidor durante a rega; a main-1.3.0 fala, mas a folga fica para ela.
  var PRAZO_CONFIRMA_MS = { bomba: 90000, nutri: 45000, luz: 45000, vent: 45000 };

  var MARKUP = [
    '<div class="station-modal ctrl" id="ctrlModal" hidden>',
    '  <div class="station-modal__backdrop" data-ctrl="fechar"></div>',
    '  <div class="station-modal__panel ctrl__panel" role="dialog" aria-modal="true" aria-labelledby="ctrlTitulo">',
    '    <h2 class="station-modal__title" id="ctrlTitulo">Controlar placa</h2>',
    '    <p class="ctrl__status" id="ctrlStatus"><span class="ctrl__dot"></span><span id="ctrlStatusTexto">Carregando…</span></p>',
    '    <div id="ctrlAvisos"></div>',
    '    <div class="ctrl__leituras" id="ctrlLeituras"></div>',
    '    <p class="ctrl__rotulo">Relés</p>',
    '    <ul class="ctrl__reles" id="ctrlReles"></ul>',
    '    <p class="ctrl__nota">“Automático” devolve o relé à placa, que decide pela umidade, pelo horário da luz e pela temperatura. Por segurança, a bomba liga no máximo 50 s por vez e o nutriente soma no máximo 30 s por dia — quem corta é a própria placa.</p>',
    '    <p class="ctrl__nota ctrl__nota--uv">A luz UV liga junto com os ventiladores. Não olhe direto para ela e evite expor a pele por muito tempo. O tempo ligado manualmente conta no limite de UV do dia.</p>',
    '    <div class="station-modal__actions">',
    '      <button type="button" class="station-modal__submit" data-ctrl="fechar">Fechar</button>',
    "    </div>",
    "  </div>",
    "</div>",
  ].join("\n");

  var modal = null;
  var station = null;
  var placa = null; // { online, last_seen } da placa main, ou null se não há
  var leitura = null;
  var leituraEm = 0; // Date.now() de quando a leitura chegou (contagem do manual)
  var pendentes = {}; // rele -> { id, em }
  var cancelarAoVivo = null;
  var timers = [];
  var carregado = false;

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function toast(msg, tipo) {
    if (typeof window.showToast === "function") window.showToast(msg, tipo);
  }

  function haQuanto(data) {
    if (!data) return "";
    var s = Math.max(0, Math.round((Date.now() - new Date(data).getTime()) / 1000));
    if (s < 60) return "há " + s + " s";
    var m = Math.round(s / 60);
    if (m < 60) return "há " + m + " min";
    var h = Math.round(m / 60);
    if (h < 48) return "há " + h + " h";
    return "há " + Math.round(h / 24) + " dias";
  }

  function mmss(seg) {
    seg = Math.max(0, Math.round(seg));
    var m = Math.floor(seg / 60);
    var s = seg % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function ensureModal() {
    if (modal) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    modal = document.getElementById("ctrlModal");
    modal.addEventListener("click", function (ev) {
      var alvo = ev.target.closest("[data-ctrl]");
      if (!alvo) return;
      if (alvo.dataset.ctrl === "fechar") fechar();
      else if (alvo.dataset.ctrl === "comando") enviar(alvo.dataset.rele, alvo.dataset.acao);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && modal && !modal.hidden) fechar();
    });
  }

  // ---------------------------------------------------------------- dados
  function aplicarLeitura(nova) {
    if (!nova) return;
    if (placa) placa.online = nova.online !== false;
    // Mesma leitura de novo (a consulta de reserva repete): não reinicia a
    // contagem do manual, que parte de leituraEm.
    if (leitura && leitura.recorded_at && nova.recorded_at &&
        new Date(nova.recorded_at) <= new Date(leitura.recorded_at)) return;
    leitura = nova;
    leituraEm = Date.now();
    if (placa) {
      placa.online = nova.online !== false;
      if (placa.online) placa.last_seen = nova.recorded_at;
    }
  }

  function confirmar(ids) {
    if (!ids || !ids.length) return;
    Object.keys(pendentes).forEach(function (rele) {
      if (ids.indexOf(pendentes[rele].id) >= 0) delete pendentes[rele];
    });
  }

  async function carregar() {
    var r = await Promise.all([
      GrowAI.getDevices(station.id).catch(function () { return []; }),
      GrowAI.getLatestReading(station.id).catch(function () { return null; }),
    ]);
    var main = (r[0] || []).filter(function (d) { return d.tipo === "main"; })[0];
    placa = main ? { online: !!main.online, last_seen: main.last_seen } : null;
    aplicarLeitura(r[1]);
    carregado = true;
    render();
  }

  // Reserva do WebSocket: confere leitura e comandos pendentes.
  async function atualizar() {
    if (!station || !carregado) return;
    var r = await GrowAI.getLatestReading(station.id).catch(function () { return null; });
    if (r) aplicarLeitura(r);
    if (Object.keys(pendentes).length) {
      var cmds = await GrowAI.getCommands(station.id).catch(function () { return []; });
      cmds.forEach(function (c) {
        var p = pendentes[c.rele];
        if (!p || p.id !== c.id) return;
        if (c.status === "confirmado") delete pendentes[c.rele];
        else if (c.status === "expirado") {
          delete pendentes[c.rele];
          toast("O comando expirou antes de a placa buscar. Confira se ela está ligada.", "error");
        }
      });
    }
    render();
  }

  function aoVivo(msg) {
    if (!station || !msg || Number(msg.station_id) !== Number(station.id)) return;
    if (msg.tipo !== "telemetria") return;
    if (!placa) placa = { online: true, last_seen: null };
    aplicarLeitura(msg.leitura);
    confirmar(msg.confirmados);
    render();
  }

  async function enviar(rele, acao) {
    var def = RELES.filter(function (r) { return r.id === rele; })[0];
    if (!def || pendentes[rele]) return;
    var corpo = { rele: rele, acao: acao };
    if (acao === "ligar") corpo.dur_s = def.dur;
    pendentes[rele] = { id: null, em: Date.now() };
    render();
    try {
      var cmd = await GrowAI.createCommand(station.id, corpo);
      pendentes[rele].id = cmd.id;
    } catch (e) {
      delete pendentes[rele];
      toast(e.message || "Não foi possível enviar o comando.", "error");
    }
    render();
  }

  function vencerPendentes() {
    Object.keys(pendentes).forEach(function (rele) {
      var p = pendentes[rele];
      if (Date.now() - p.em > (PRAZO_CONFIRMA_MS[rele] || 45000)) {
        delete pendentes[rele];
        toast("A placa não confirmou o comando. Ela está ligada e na internet?", "error");
      }
    });
  }

  // ---------------------------------------------------------------- tela
  function render() {
    if (!modal || modal.hidden) return;
    vencerPendentes();

    var online = !!(placa && placa.online);
    var status = document.getElementById("ctrlStatus");
    var statusTexto = document.getElementById("ctrlStatusTexto");
    status.classList.toggle("ctrl__status--online", online);
    if (!carregado) statusTexto.textContent = "Carregando…";
    else if (!placa) statusTexto.textContent = "Nenhuma placa principal cadastrada";
    else if (online) statusTexto.textContent = "Placa online · atualizado " + haQuanto(leitura && leitura.recorded_at);
    else statusTexto.textContent = "Placa offline" + (placa.last_seen ? " · último contato " + haQuanto(placa.last_seen) : " · nunca se conectou");

    renderAvisos(online);
    renderLeituras();
    renderReles(online);
  }

  function renderAvisos(online) {
    var avisos = [];
    if (carregado && !placa) {
      avisos.push({ erro: false, texto: "Cadastre a placa principal em Configurações → Placas e grave a chave nela pelo portal GrowAI-setup." });
    } else if (carregado && !online) {
      avisos.push({ erro: false, texto: "Sem contato com a placa. Ligue-a e confira o Wi-Fi: o controle volta assim que ela falar com o servidor. A irrigação e a luz continuam funcionando sozinhas nela." });
    }
    if (leitura && online) {
      if (leitura.erro) {
        avisos.push({
          erro: true,
          texto: "Sensor: " + leitura.erro +
            (leitura.temperatura_fonte === "sao_paulo" ? ". Enquanto isso, a temperatura mostrada é a de São Paulo (internet), não a da estufa." : ""),
        });
      }
      if (leitura.erro_cfg) avisos.push({ erro: true, texto: "A placa recusou a rotina: " + leitura.erro_cfg });
      if (leitura.hora_valida === false) avisos.push({ erro: false, texto: "A placa ainda não acertou o relógio pela internet. Até lá a luz fica acesa e o nutriente não é dosado." });
      if (!leitura.erro_cfg && leitura.cfg_versao_placa != null && leitura.cfg_versao_servidor != null &&
          Number(leitura.cfg_versao_placa) !== Number(leitura.cfg_versao_servidor)) {
        avisos.push({ erro: false, texto: "Enviando a rotina nova para a placa…" });
      }
      /* Queda de energia: a placa reiniciou porque a tensão caiu (brownout).
         Quase sempre é a bomba arrancando na mesma fonte do ESP32. */
      if (leitura.reset === "queda_energia" && Number(leitura.uptime_s) < 6 * 3600) {
        avisos.push({
          erro: true,
          texto: "A placa reiniciou por queda de energia " + haQuanto(Date.now() - Number(leitura.uptime_s) * 1000) +
            ". Isso costuma ser a bomba puxando corrente demais da mesma fonte do ESP32: alimente a bomba e os relés por uma fonte separada.",
        });
      }
      excessosDoDia().forEach(function (t) { avisos.push({ erro: true, texto: t }); });
    }
    document.getElementById("ctrlAvisos").innerHTML = avisos
      .map(function (a) {
        return '<p class="ctrl__aviso' + (a.erro ? " ctrl__aviso--erro" : "") + '">' + esc(a.texto) + "</p>";
      })
      .join("");
  }

  // 7380 -> "2h 3min"; 2700 -> "45 min"; 40 -> "40 s"
  function duracao(seg) {
    seg = Math.max(0, Math.round(Number(seg) || 0));
    if (seg < 60) return seg + " s";
    var min = Math.round(seg / 60);
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60);
    var resto = min % 60;
    return h + "h" + (resto ? " " + resto + "min" : "");
  }

  /* O que a rotina recomenda por dia, para comparar com o tempo ligado hoje.
     A ventilação carrega a luz UV no mesmo relé, então o limite dela é o de UV.
     Bomba e nutriente não entram: a bomba segue o sensor, e o nutriente já
     tem o limite de 30 s cortado pela própria placa. */
  function recomendadoHoje(rele) {
    var l = leitura || {};
    if (rele === "luz") {
      var h = l.light_hours != null ? l.light_hours : station && station.light_hours;
      return h != null ? Number(h) * 3600 : null;
    }
    if (rele === "vent") return uvLimite() * 60;
    return null;
  }

  function excessosDoDia() {
    var l = leitura || {};
    var hoje = l.hoje_s || {};
    var man = l.manual_hoje_s || {};
    var textos = [];
    [["luz", "Luz"], ["vent", "Ventilação + luz UV"]].forEach(function (par) {
      var limite = recomendadoHoje(par[0]);
      var usado = Number(hoje[par[0]]) || 0;
      // 1 min de folga: o contador corre em segundos e a rotina em minutos.
      if (limite == null || usado <= limite + 60) return;
      textos.push(
        par[1] + " acima do recomendado hoje: " + duracao(usado) + " de " + duracao(limite) +
          (Number(man[par[0]]) ? " (" + duracao(man[par[0]]) + " no manual)" : "") +
          (par[0] === "vent" ? ". Excesso de UV pode queimar as folhas." : ".")
      );
    });
    return textos;
  }

  function uvLimite() {
    var l = leitura || {};
    var v = l.uv_min_dia != null ? l.uv_min_dia : station && station.uv_min_dia;
    return v != null ? v : 30;
  }

  function sinalWifi(rssi) {
    var r = Number(rssi);
    if (rssi == null || !isFinite(r) || r === 0) return "—";
    return r >= -60 ? "Ótimo" : r >= -70 ? "Bom" : r >= -80 ? "Fraco" : "Muito fraco";
  }

  function renderLeituras() {
    var l = leitura || {};
    var temNum = function (v) { return v !== null && v !== undefined && v !== "" && isFinite(Number(v)); };
    var itens = [
      ["Umidade do solo", temNum(l.humidity) ? Math.round(l.humidity) + "%" : "—"],
      [l.temperatura_fonte === "sao_paulo" ? "Temperatura (São Paulo)" : "Temperatura",
        temNum(l.temperature) ? String(Math.round(l.temperature * 10) / 10).replace(".", ",") + " °C" : "—"],
      ["Situação", ESTADOS[l.estado] || "—"],
      ["Nutriente hoje", temNum(l.nutri_s_hoje) ? l.nutri_s_hoje + " de " + NUTRI_MAX_S + " s" : "—"],
      ["Luz UV hoje", temNum(l.uv_s_hoje)
        ? (l.uv_s_hoje > 0 && l.uv_s_hoje < 60 ? "<1" : Math.round(l.uv_s_hoje / 60)) + " de " + uvLimite() + " min"
        : "—"],
      ["Sinal Wi-Fi", sinalWifi(l.rssi)],
    ];
    document.getElementById("ctrlLeituras").innerHTML = itens
      .map(function (i) {
        return (
          '<div class="ctrl__leitura"><p class="ctrl__leitura-rotulo">' + i[0] +
          '</p><p class="ctrl__leitura-valor">' + esc(i[1]) + "</p></div>"
        );
      })
      .join("");
  }

  // Por que a rotina ligou este relé agora (só o que dá para saber com certeza).
  function porqueLigou(rele, l) {
    if (rele === "bomba" && l.estado === "REGANDO") return " (solo seco)";
    if (rele === "luz") return l.hora_valida === false ? " (sem relógio: acesa por segurança)" : " (horário de luz)";
    if (rele === "vent") {
      var tmax = station && station.temp_max != null ? Number(station.temp_max) : null;
      if (tmax != null && l.temperature != null && Number(l.temperature) > tmax) return " (calor acima de " + tmax + " °C)";
      return " (ciclo de ventilação/UV)";
    }
    if (rele === "nutri") return " (dose do dia)";
    return "";
  }

  function renderReles(online) {
    var l = leitura || {};
    var reles = l.reles || {};
    var manual = l.manual || {};
    var passou = (Date.now() - leituraEm) / 1000;

    document.getElementById("ctrlReles").innerHTML = RELES.map(function (r) {
      var ligado = Number(reles[r.id]) === 1;
      var resta = manual[r.id] != null ? Number(manual[r.id]) - passou : null;
      var emManual = resta != null && resta > 0;
      var pend = pendentes[r.id];
      var bloqueio = "";
      if (r.id === "bomba" && online && l.humidity == null) bloqueio = "Bloqueada: sensor de umidade sem leitura";
      if (r.id === "nutri" && Number(l.nutri_s_hoje) >= NUTRI_MAX_S) bloqueio = "Limite de hoje atingido";

      var estado;
      var classe = "ctrl__rele-estado";
      if (pend) estado = "Enviando comando para a placa…";
      else if (bloqueio && !emManual) estado = bloqueio;
      else if (emManual) { estado = "Ligado manualmente · resta " + mmss(resta); classe += " ctrl__rele-estado--ligado"; }
      else if (!online || !l.reles) estado = "—";
      else if (ligado) {
        estado = "Ligado pela rotina" + porqueLigou(r.id, l);
        classe += " ctrl__rele-estado--ligado";
      }
      else estado = "Desligado · rotina no automático";

      // Tempo ligado hoje, separando a rotina do manual.
      var hoje = l.hoje_s && l.hoje_s[r.id] != null ? Number(l.hoje_s[r.id]) : null;
      var man = l.manual_hoje_s && l.manual_hoje_s[r.id] != null ? Number(l.manual_hoje_s[r.id]) : 0;
      var limite = recomendadoHoje(r.id);
      var linhaHoje = "";
      if (hoje != null && online) {
        linhaHoje = "Hoje: " + duracao(hoje) +
          (man ? " (" + duracao(Math.max(0, hoje - man)) + " rotina · " + duracao(man) + " manual)" : "") +
          (limite != null ? " · recomendado " + duracao(limite) : "");
      }
      var excedeu = limite != null && hoje != null && hoje > limite + 60;

      var acao = emManual ? "desligar" : "ligar";
      var rotulo = emManual ? "Automático" : r.ligar;
      var desabilitado = !online || !!pend || (!emManual && !!bloqueio);

      return (
        '<li class="ctrl__rele">' +
        '<div class="ctrl__rele-info"><p class="ctrl__rele-nome">' + r.nome + "</p>" +
        '<p class="' + classe + '">' + esc(estado) + "</p>" +
        (linhaHoje ? '<p class="ctrl__rele-hoje' + (excedeu ? " ctrl__rele-hoje--excesso" : "") + '">' + esc(linhaHoje) + "</p>" : "") +
        "</div>" +
        '<button type="button" class="ctrl__btn' + (emManual ? " ctrl__btn--auto" : "") + '" data-ctrl="comando" data-rele="' + r.id +
        '" data-acao="' + acao + '"' + (desabilitado ? " disabled" : "") + ">" + (pend ? "Enviando…" : rotulo) + "</button>" +
        "</li>"
      );
    }).join("");
  }

  // ---------------------------------------------------------------- abrir
  function open(st) {
    ensureModal();
    fechar(true);
    station = st;
    placa = null;
    leitura = null;
    leituraEm = 0;
    pendentes = {};
    carregado = false;
    document.getElementById("ctrlTitulo").textContent = "Controlar · " + (st.name || st.plant || "estação");
    modal.hidden = false;
    render();

    cancelarAoVivo = GrowAI.aoVivo(aoVivo);
    timers.push(setInterval(atualizar, 5000));
    timers.push(setInterval(render, 1000)); // contagem do manual e "há X s"
    carregar();
  }

  function fechar(silencioso) {
    timers.forEach(clearInterval);
    timers = [];
    if (cancelarAoVivo) cancelarAoVivo();
    cancelarAoVivo = null;
    station = null;
    if (modal && !silencioso) modal.hidden = true;
  }

  window.ControlModal = { open: open };
})();
