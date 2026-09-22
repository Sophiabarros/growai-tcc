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
    '      <label for="stationTag">Categoria</label>',
    '      <input type="text" id="stationTag" name="tag" placeholder="Ex: Calmante" />',
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

  var modal = null;
  var modalTitle = null;
  var form = null;
  var modalError = null;
  var modalSubmit = null;

  var editingId = null;
  var onSaved = null;

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

    // Nome/planta só fazem sentido ao criar uma estação nova.
    form.name.disabled = mode === "edit";
    form.plant.disabled = mode === "edit";
    form.tag.disabled = mode === "edit";

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
      closeModal();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.hidden = false;
    } finally {
      modalSubmit.disabled = false;
      modalSubmit.textContent = "Salvar";
    }
  }

  window.StationModal = { open: open };
})();
