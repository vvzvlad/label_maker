import { appState } from './state.js';
import { serializeLayerNodes, applyTemplateState } from './template.js';
import { serializeTableRows, renderTableHeader, addEntityRow, updateCounter, autoSaveTable } from './entity-table.js';
import { showToast } from './utils.js';

let _schedulePreviewUpdate = () => {};

export function initPresets({ schedulePreviewUpdate }) {
  _schedulePreviewUpdate = schedulePreviewUpdate;

  document.getElementById('presets-modal-close').addEventListener('click', () => {
    const modalEl = document.getElementById('presets-modal');
    bootstrap.Modal.getInstance(modalEl)?.hide();
  });
  document.getElementById('btn-save-preset').addEventListener('click', saveCurrentAsPreset);
}

/** Read and parse presets array from localStorage. Returns [] on error. */
function loadPresets() {
  try {
    const raw = localStorage.getItem('lm_presets');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write presets array to localStorage. */
function savePresets(presets) {
  try {
    localStorage.setItem('lm_presets', JSON.stringify(presets));
  } catch (e) {
    showToast('Failed to save preset: storage quota exceeded.', 'danger');
  }
}

/** Capture the current app state as a preset-compatible object. */
function captureCurrentState() {
  const nodes = serializeLayerNodes();
  const widthMm = parseFloat(document.getElementById('input-width').value) || 58;
  const heightMm = parseFloat(document.getElementById('input-height').value) || 40;
  const zoom = parseInt(document.getElementById('input-zoom').value, 10) || 200;

  return {
    template: { version: 1, widthMm, heightMm, zoom, nodes },
    table: { columnCount: appState.entityColumnCount, rows: serializeTableRows() },
  };
}

/** Restore the app state from a preset object. */
function applyPresetState(preset) {
  const tpl = preset.template;
  const tbl = preset.table;

  if (tpl) applyTemplateState(tpl);

  // Restore table
  if (tbl) {
    const tbody = document.getElementById('entities-tbody');
    tbody.innerHTML = '';
    appState.entityColumnCount = Number.isInteger(tbl.columnCount) && tbl.columnCount > 0
      ? tbl.columnCount
      : 3;
    renderTableHeader();
    if (Array.isArray(tbl.rows)) {
      tbl.rows.forEach((r) => {
        addEntityRow(r.entities || []);
      });
    }
    updateCounter();
    autoSaveTable();
  }

  // Single preview update after all state is restored
  _schedulePreviewUpdate();
}

/** Render the preset list into the modal body. */
function renderPresetsList() {
  const presets = loadPresets();
  const body = document.getElementById('presets-modal-body');
  body.innerHTML = '';

  if (presets.length === 0) {
    body.innerHTML = '<div class="presets-empty">No saved presets yet.</div>';
    return;
  }

  presets.forEach((preset, index) => {
    const dateStr = preset.createdAt
      ? new Date(preset.createdAt).toLocaleString()
      : '';
    const item = document.createElement('div');
    item.className = 'preset-item';
    // Build info section safely to prevent XSS via preset names
    const infoDiv = document.createElement('div');
    infoDiv.className = 'preset-item-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'preset-item-name';
    nameEl.textContent = preset.name || '(unnamed)'; // safe assignment
    nameEl.title = preset.name || '';               // safe assignment

    const dateEl = document.createElement('div');
    dateEl.className = 'preset-item-date';
    dateEl.textContent = dateStr;                   // safe assignment

    infoDiv.appendChild(nameEl);
    infoDiv.appendChild(dateEl);
    item.appendChild(infoDiv);

    // Actions section uses only static HTML with numeric data-index — safe to use innerHTML
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'preset-item-actions';
    actionsDiv.innerHTML = `
      <button type="button" class="btn btn-outline-secondary btn-sm btn-load-preset" data-index="${index}">
        <i class="bi bi-box-arrow-in-down me-1"></i>Load
      </button>
      <button type="button" class="btn btn-outline-danger btn-sm btn-delete-preset" data-index="${index}">
        <i class="bi bi-trash me-1"></i>Delete
      </button>
    `;
    item.appendChild(actionsDiv);
    body.appendChild(item);
  });

  // Attach Load button handlers
  body.querySelectorAll('.btn-load-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      if (isNaN(idx)) return;
      const preset = loadPresets()[idx];
      if (!preset) return;
      applyPresetState(preset);
      const modalEl = document.getElementById('presets-modal');
      bootstrap.Modal.getInstance(modalEl)?.hide();
      showToast('Preset loaded!', 'success');
    });
  });

  // Attach Delete button handlers
  body.querySelectorAll('.btn-delete-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.disabled = true; // prevent double-click race condition
      const idx = parseInt(btn.dataset.index, 10);
      if (isNaN(idx)) return;
      const currentPresets = loadPresets();
      currentPresets.splice(idx, 1);
      savePresets(currentPresets);
      renderPresetsList();
    });
  });
}

/** Open the presets modal and render the preset list. */
export function openPresetsModal() {
  renderPresetsList();
  const modalEl = document.getElementById('presets-modal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

/** Prompt for a preset name, capture current state, and save as a new preset. */
function saveCurrentAsPreset() {
  const name = window.prompt('Preset name:', '');
  if (name === null || name.trim() === '') return;

  const state = captureCurrentState();
  const presets = loadPresets();
  presets.push({
    name: name.trim(),
    createdAt: new Date().toISOString(),
    ...state,
  });
  savePresets(presets);
  renderPresetsList();
  showToast('Preset saved!', 'success');
}
