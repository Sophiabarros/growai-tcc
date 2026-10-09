(function () {
  "use strict";

  // Modal de criar/editar estação, compartilhado pelas páginas Estações e
  // Câmera. O markup é injetado aqui (uma fonte só) na primeira vez que o
  // modal abre; o visual está em css/station-modal.css e depende de js/api.js
  // (GrowAI.createStation / GrowAI.updateStation).
  //
  //   StationModal.open("create", null, function (station) { ... });
  //   StationModal.open("edit", station, function (station) { ... });
  //
  // O callback roda depois que a API salvou, com a estação criada/atualizada.

  var MARKUP = [
    '<div class="station-modal" id="stationModal" hidden>',
    '  <div class="station-modal__backdrop" data-action="close-modal"></div>',
    '  <form class="station-modal__panel" id="stationForm">',
    '    <h2 class="station-modal__title" id="stationModalTitle">Nova Estação</h2>',
    '    <div class="station-modal__field">',
    '      <label for="stationName">Nome</label>',
    '      <input type="text" id="stationName" name="name" required />',
    "    </div>",
    '    <div class="station-modal__field">',
    '      <label for="stationPlant">Planta</label>',
    '      <input type="text" id="stationPlant" name="plant" required />',
    "    </div>",
    '    <div class="station-modal__field">',
    // "Finalidade", nao "Categoria": e deste campo que a IA tira para QUE o
    // usuario cultiva a planta, e dai qual parte dela importa (flor, folha,
    // raiz) e o que a rotina deveria favorecer. Com o rotulo "Categoria" o
    // usuario escrevia uma classificacao ("erva", "medicinal"), que nao diz
    // nada sobre o que ele espera colher.
    '      <label for="stationTag">Finalidade</label>',
    '      <input type="text" id="stationTag" name="tag" placeholder="Ex: Calmante, Digestiva, Anti-inflamatória" />',
    "    </div>",
    '    <div class="station-modal__row">',
    '      <div class="station-modal__field">',
    '        <label for="stationWater">Rega a cada (h)</label>',
    '        <input type="number" id="stationWater" name="water_interval_h" min="1" step="1" required />',
    "      </div>",
    '      <div class="station-modal__field">',
    '        <label for="stationLight">Luz diária (h)</label>',
    '        <input type="number" id="stationLight" name="light_hours" min="0" max="24" step="1" required />',
    "      </div>",
    "    </div>",
    '    <div class="station-modal__row">',
    '      <div class="station-modal__field">',
    '        <label for="stationHumidity">Umidade alvo (%)</label>',
    '        <input type="number" id="stationHumidity" name="humidity_target" min="0" max="100" step="1" required />',
    "      </div>",
    '      <div class="station-modal__field">',
    '        <label for="stationPh">pH alvo</label>',
    '        <input type="number" id="stationPh" name="ph_target" min="0" max="14" step="0.1" required />',
    "      </div>",
    "    </div>",
    '    <p class="station-modal__error" id="stationModalError" hidden></p>',
    '    <div class="station-modal__actions">',
    '      <button type="button" class="station-modal__cancel" data-action="close-modal">Cancelar</button>',
    '      <button type="submit" class="station-modal__submit" id="stationModalSubmit">Salvar</button>',
    "    </div>",
    "  </form>",
    "</div>",
  ].join("\n");

  // Aviso de rotina inadequada, mostrado depois que a IA avalia o que foi
  // salvo. Reaproveita o visual do modal de estação (mesmo painel e botões).
  var ALERT_MARKUP = [
    '<div class="station-modal routine-alert" id="routineAlert" hidden>',
    '  <div class="station-modal__backdrop" data-action="close-alert"></div>',
    '  <div class="station-modal__panel routine-alert__panel" role="alertdialog" aria-modal="true" aria-labelledby="routineAlertTitle" aria-describedby="routineAlertText">',
    '    <p class="routine-alert__eyebrow" id="routineAlertEyebrow"></p>',
    '    <h2 class="station-modal__title routine-alert__title" id="routineAlertTitle">',
    '      <img class="routine-alert__icon" src="assets/icons/app/icon-app-warning.svg" alt="" />',
    "      Rotina inadequada",
    "    </h2>",
    '    <p class="routine-alert__text" id="routineAlertText"></p>',
    '    <div class="routine-alert__changes" id="routineAlertChanges" hidden>',
    '      <p class="routine-alert__label" id="routineAlertLabel"></p>',
    '      <ul class="routine-alert__list" id="routineAlertList"></ul>',
    '      <p class="routine-alert__why" id="routineAlertWhy"></p>',
    "    </div>",
    '    <p class="routine-alert__note" id="routineAlertNote" hidden></p>',
    '    <div class="station-modal__actions">',
    '      <button type="button" class="station-modal__submit" data-action="close-alert">Fechar</button>',
    "    </div>",
    "  </div>",
    "</div>",
  ].join("\n");

  // Como cada campo da rotina aparece no aviso.
  var CAMPOS = {
    light_hours: { nome: "Luz diária", un: " h" },
    humidity_target: { nome: "Umidade alvo", un: "%" },
    water_interval_h: { nome: "Rega a cada", un: " h" },
    ph_target: { nome: "pH alvo", un: "" },
    temp_max: { nome: "Ventilar acima de", un: " °C" },
    vent_min_por_hora: { nome: "Ventilação", un: " min/h" },
    nutri_s: { nome: "Nutriente", un: " s/dia" },
  };

  // Campos que, ao mudar, pedem nova avaliação da IA.
  var CAMPOS_AVALIADOS = ["plant", "tag", "water_interval_h", "light_hours", "humidity_target", "ph_target"];

  var modal = null;
  var modalTitle = null;
  var form = null;
  var modalError = null;
  var modalSubmit = null;

  var editingId = null;
  var onSaved = null;
  var original = null;

  var alertBox = null;

  function ensureModal() {
    if (modal) return;

    document.body.insertAdjacentHTML("beforeend", MARKUP);
    modal = document.getElementById("stationModal");
    modalTitle = document.getElementById("stationModalTitle");
    form = document.getElementById("stationForm");
    modalError = document.getElementById("stationModalError");
    modalSubmit = document.getElementById("stationModalSubmit");

    modal.addEventListener("click", function (event) {
      if (event.target.closest('[data-action="close-modal"]')) closeModal();
    });
    form.addEventListener("submit", handleSubmit);
  }

  function open(mode, station, callback) {
    ensureModal();

    editingId = mode === "edit" ? station.id : null;
    onSaved = callback || null;
    original = mode === "edit" ? station : null;
    modalTitle.textContent = mode === "edit" ? "Editar Estação" : "Nova Estação";
    modalError.hidden = true;
    modal.classList.remove("is-closing");
    form.reset();

    if (mode === "edit") {
      form.name.value = station.name;
      form.plant.value = station.plant;
      form.tag.value = station.tag || "";
      form.water_interval_h.value = station.water_interval_h;
      form.light_hours.value = station.light_hours;
      form.humidity_target.value = station.humidity_target;
      form.ph_target.value = station.ph_target;
    }

    /* Nome, planta e finalidade são editáveis também na edição.
       Antes ficavam `disabled` no modo edição, com a ideia de que "só fazem
       sentido ao criar". Na prática o usuário renomeia o canteiro, corrige a
       espécie que digitou errado e troca a finalidade — e não conseguia.

       A finalidade (`tag`) virou ainda mais importante depois que a IA passou
       a julgar a rotina contra a espécie E a finalidade: deixá-la travada
       significaria não poder corrigir o que a IA usa para decidir. */
    form.name.disabled = false;
    form.plant.disabled = false;
    form.tag.disabled = false;

    modal.hidden = false;
  }

  function closeModal() {
    modal.classList.add("is-closing");
    window.setTimeout(function () {
      modal.hidden = true;
      modal.classList.remove("is-closing");
    }, 180);
    editingId = null;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    modalError.hidden = true;
    modalSubmit.disabled = true;
    modalSubmit.textContent = "Salvando...";

    var payload = {
      name: form.name.value,
      plant: form.plant.value,
      tag: form.tag.value || null,
      water_interval_h: Number(form.water_interval_h.value),
      light_hours: Number(form.light_hours.value),
      humidity_target: Number(form.humidity_target.value),
      ph_target: Number(form.ph_target.value),
    };

    try {
      var saved = editingId
        ? await GrowAI.updateStation(editingId, payload)
        : await GrowAI.createStation(payload);
      if (onSaved) await onSaved(saved, editingId ? "edit" : "create");

      var avaliar = saved && saved.id && GrowAI.evaluateRoutine && rotinaMudou(payload);
      var callback = onSaved;
      closeModal();

      /* A IA confere a rotina DEPOIS de o modal fechar: a chamada leva ~6 s e
         salvar tem que ser imediato. Sem await de propósito. */
      if (avaliar) avaliarRotina(saved, callback);
    } catch (err) {
      modalError.textContent = err.message;
      modalError.hidden = false;
    } finally {
      modalSubmit.disabled = false;
      modalSubmit.textContent = "Salvar";
    }
  }

  // Na criação sempre avalia; na edição, só se algo que a IA julga mudou.
  // Salvar só o nome de novo não gasta chamada da API (cota de 20 por dia).
  //
  // Exceção: se a última avaliação desta estação falhou (IA sobrecarregada,
  // sem rede), salvar de novo os MESMOS valores tem que tentar de novo — é o
  // que o aviso de erro manda o usuário fazer.
  var semAvaliacao = {};

  function rotinaMudou(payload) {
    if (!original) return true;
    if (semAvaliacao[original.id]) return true;
    return CAMPOS_AVALIADOS.some(function (campo) {
      var antes = original[campo];
      var depois = payload[campo];
      if (campo === "plant" || campo === "tag") return String(antes || "").trim() !== String(depois || "").trim();
      return Number(antes) !== Number(depois);
    });
  }

  function toast(msg, tipo) {
    if (typeof window.showToast === "function") window.showToast(msg, tipo);
  }

  function fmt(campo, valor) {
    var c = CAMPOS[campo];
    if (valor === null || valor === undefined || valor === "") return "—";
    var n = Number(valor);
    var texto = Number.isFinite(n) ? String(Math.round(n * 10) / 10).replace(".", ",") : String(valor);
    return texto + (c ? c.un : "");
  }

  /* Pede a avaliação e mostra o resultado:
     - rotina boa: só um toast;
     - rotina ruim: o aviso, com o que a IA já corrigiu (ou sugeriu);
     - IA fora do ar: um toast, e a rotina fica como o usuário salvou.
     Nunca vira erro de salvamento: a estação já está gravada. */
  async function avaliarRotina(saved, callback) {
    toast("A IA está conferindo a rotina de " + (saved.plant || "sua planta") + "…");
    var r;
    try {
      r = await GrowAI.evaluateRoutine(saved.id, true);
    } catch (e) {
      r = null;
    }
    if (!r || !r.avaliado) {
      semAvaliacao[saved.id] = true;
      var cheia = r && /(503|500|502|504)|high demand|não respondeu/i.test(r.motivo || "");
      toast(
        cheia
          ? "A IA está sobrecarregada agora e não conferiu a rotina. Salve de novo em alguns minutos."
          : "Não foi possível conferir a rotina agora. Salve de novo em alguns minutos.",
        "error"
      );
      return;
    }
    delete semAvaliacao[saved.id];
    if (r.health_status !== "atencao") {
      toast("Rotina adequada para " + (saved.plant || "a planta") + ".");
      return;
    }

    // A IA corrigiu a estação: a página passa a mostrar os valores novos.
    if (r.aplicada && r.station && callback) {
      try {
        await callback(r.station, "edit");
      } catch (e) {
        /* a tela atualiza no próximo carregamento */
      }
    }
    mostrarAviso(saved, r);
  }

  function ensureAlert() {
    if (alertBox) return;
    document.body.insertAdjacentHTML("beforeend", ALERT_MARKUP);
    alertBox = document.getElementById("routineAlert");
    alertBox.addEventListener("click", function (event) {
      if (event.target.closest('[data-action="close-alert"]')) fecharAviso();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !alertBox.hidden) fecharAviso();
    });
  }

  function mostrarAviso(saved, r) {
    ensureAlert();
    var sg = r.sugestao;
    var depois = (sg && sg.config) || {};
    var antes = (sg && sg.config_anterior) || {};
    var campos = Object.keys(depois).filter(function (c) {
      return CAMPOS[c];
    });

    document.getElementById("routineAlertEyebrow").textContent =
      "Avaliação da IA · " + (saved.plant || "") + (saved.tag ? " · " + saved.tag : "");
    document.getElementById("routineAlertText").textContent = r.analysis_text || "";

    var list = document.getElementById("routineAlertList");
    list.innerHTML = "";
    campos.forEach(function (c) {
      var li = document.createElement("li");
      li.className = "routine-alert__item";
      var nome = document.createElement("span");
      nome.className = "routine-alert__name";
      nome.textContent = CAMPOS[c].nome;
      var de = document.createElement("s");
      de.className = "routine-alert__old";
      de.textContent = fmt(c, antes[c] !== undefined ? antes[c] : saved[c]);
      var seta = document.createElement("span");
      seta.className = "routine-alert__arrow";
      seta.setAttribute("aria-hidden", "true");
      seta.textContent = "→";
      var para = document.createElement("strong");
      para.className = "routine-alert__new";
      para.textContent = fmt(c, depois[c]);
      li.append(nome, de, seta, para);
      list.appendChild(li);
    });
    document.getElementById("routineAlertChanges").hidden = campos.length === 0;
    document.getElementById("routineAlertLabel").textContent = r.aplicada
      ? "A IA já ajustou a rotina:"
      : "A IA sugere ajustar:";
    document.getElementById("routineAlertWhy").textContent = (sg && sg.message) || "";

    var note = document.getElementById("routineAlertNote");
    if (campos.length && !r.aplicada) {
      note.textContent = "O ajuste automático não foi aplicado" + (r.motivo ? " (" + r.motivo + ")" : "") +
        ". Você pode aplicar a sugestão na tela Relatórios.";
      note.hidden = false;
    } else if (campos.length && r.aplicada) {
      note.textContent = "Se preferir a rotina anterior, desfaça o ajuste na tela Relatórios.";
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    alertBox.classList.remove("is-closing");
    alertBox.hidden = false;
    alertBox.querySelector(".station-modal__submit").focus();
  }

  function fecharAviso() {
    alertBox.classList.add("is-closing");
    window.setTimeout(function () {
      alertBox.hidden = true;
      alertBox.classList.remove("is-closing");
    }, 180);
  }

  window.StationModal = { open: open };
})();
