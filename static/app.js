import {
  appState,
  PREVIEW_DEBOUNCE_MS,
  DEFAULT_FONT_SIZE,
} from './modules/state.js';
import { initStageModule, selectWithTransformer, applyZoom, initStage, pushHistory, applyHistory, undoHistory, redoHistory } from './modules/stage.js';
import { initContextMenu, showContextMenu, hideContextMenu } from './modules/context-menu.js';
import { initEntityTable, renderTableHeader, addEntityRow, getRows, autoSaveTable, updateCounter, serializeTableRows } from './modules/entity-table.js';
import { initTemplate, serializeLayerNodes, saveTemplate, autoSaveTemplate, loadTemplate } from './modules/template.js';
import { isCanvasReadBlocked, showToast } from './modules/utils.js';
import { initPdf, renderOffscreenLabel, generatePDF, openPdfModal, closePdfModal, renderPreviewStrip } from './modules/pdf.js';
import {
  initNodes,
  onDragEnd, onTransformEnd,
  addTextNodeWithProps, startTextEdit, addTextNode,
  attachImageNodeHandlers, editUrlNodeTemplate, addImageNodeFromUrl, addImageNode,
  attachQrNodeHandlers, addQrNode,
  addLineNode, attachLineNodeHandlers,
  restoreUrlImageNode, restoreSavedNodes,
} from './modules/nodes.js';

// ── DOM references ──────────────────────────────────────────────
const inputWidth    = document.getElementById('input-width');
const inputHeight   = document.getElementById('input-height');

function schedulePreviewUpdate() {
  clearTimeout(appState.previewTimer);
  appState.previewTimer = setTimeout(renderPreviewStrip, PREVIEW_DEBOUNCE_MS);
}

// ── Stage resize on mm-input change ──────────────────────────────

function handleDimensionChange() {
  initStage();
  schedulePreviewUpdate();
}

// ── Event listeners ──────────────────────────────────────────────

// Entity table listeners are registered via initEntityTable() below.

document.getElementById('btn-reset-template').addEventListener('click', () => {
  initStage(false);
  addTextNodeWithProps('%E1%', 10, 10, DEFAULT_FONT_SIZE, '#000000');
  appState.transformer.nodes([]);
  appState.layer.batchDraw();
  schedulePreviewUpdate();
  pushHistory();
  localStorage.removeItem('lm_template');
});

inputWidth.addEventListener('input',  handleDimensionChange);
inputHeight.addEventListener('input', handleDimensionChange);

document.getElementById('btn-generate').addEventListener('click', generatePDF);
document.getElementById('btn-save-template').addEventListener('click', saveTemplate);
document.getElementById('btn-load-template-trigger').addEventListener('click', () => document.getElementById('tpl-upload').click());
document.getElementById('tpl-upload').addEventListener('change', (e) => loadTemplate(e.target));
document.getElementById('btn-open-presets').addEventListener('click', openPresetsModal);
document.getElementById('btn-add-text').addEventListener('click', addTextNode);
document.getElementById('btn-upload-image-trigger').addEventListener('click', () => document.getElementById('img-upload').click());
document.getElementById('btn-add-image-url').addEventListener('click', addImageNodeFromUrl);
document.getElementById('img-upload').addEventListener('change', (e) => addImageNode(e.target));
document.getElementById('btn-add-line').addEventListener('click', addLineNode);
document.getElementById('btn-add-qr').addEventListener('click', addQrNode);
document.getElementById('input-zoom').addEventListener('input', applyZoom);

// ── Presets management ────────────────────────────────────────────

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
  const widthMm = parseFloat(inputWidth.value) || 58;
  const heightMm = parseFloat(inputHeight.value) || 40;
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

  // Keep in sync with the loadTemplate() file-reader callback
  // Restore template (same logic as loadTemplate file reader callback)
  if (tpl) {
    if (tpl.widthMm) inputWidth.value = tpl.widthMm;
    if (tpl.heightMm) inputHeight.value = tpl.heightMm;
    if (tpl.zoom) {
      document.getElementById('input-zoom').value = tpl.zoom;
      document.getElementById('zoom-label').textContent = tpl.zoom + '%';
    }
    initStage(false);
    if (Array.isArray(tpl.nodes)) {
      restoreSavedNodes(tpl.nodes);
    }
    appState.transformer.nodes([]);
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }

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
    schedulePreviewUpdate();
    autoSaveTable();
  }
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
      const currentPresets = loadPresets();
      currentPresets.splice(idx, 1);
      savePresets(currentPresets);
      renderPresetsList();
    });
  });
}

/** Open the presets modal and render the preset list. */
function openPresetsModal() {
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

// Wire up presets modal close button
document.getElementById('presets-modal-close').addEventListener('click', () => {
  const modalEl = document.getElementById('presets-modal');
  bootstrap.Modal.getInstance(modalEl)?.hide();
});

// Wire up "Save current state as preset" button in modal footer
document.getElementById('btn-save-preset').addEventListener('click', saveCurrentAsPreset);

// ── Initialise ───────────────────────────────────────────────────

// Wire nodes module FIRST — restoreSavedNodes is passed as DI to other modules.
try {
  initNodes({ schedulePreviewUpdate });
} catch (e) {
  console.error('Failed to initialize nodes module:', e);
}

// Wire stage module — receives restoreSavedNodes from nodes module.
try {
  initStageModule({ hideContextMenu, schedulePreviewUpdate, restoreSavedNodes });
} catch (e) {
  console.error('Failed to initialize stage module:', e);
}

// Wire context menu module with node handler callbacks.
try {
  initContextMenu({ addTextNodeWithProps, attachLineNodeHandlers, attachQrNodeHandlers, attachImageNodeHandlers, closePdfModal, schedulePreviewUpdate });
} catch (e) {
  console.error('Failed to initialize context menu module:', e);
}

// Wire pdf module with schedulePreviewUpdate callback.
try {
  initPdf({ schedulePreviewUpdate });
} catch (e) {
  console.error('Failed to initialize pdf module:', e);
}

// Wire entity-table module with the schedulePreviewUpdate callback.
try {
  initEntityTable({ schedulePreviewUpdate });
} catch (e) {
  console.error('Failed to initialize entity table:', e);
}

// Wire template module with all required callbacks.
try {
  initTemplate({ initStage, restoreSavedNodes, renderTableHeader, pushHistory, schedulePreviewUpdate });
} catch (e) {
  console.error('Failed to initialize template module:', e);
}
try {
  const savedTableRaw = localStorage.getItem('lm_table');
  if (savedTableRaw) {
    const savedTable = JSON.parse(savedTableRaw);
    let restoredRows = [];
    if (savedTable && typeof savedTable === 'object' && Array.isArray(savedTable.rows)) {
      appState.entityColumnCount = Number.isInteger(savedTable.columnCount) && savedTable.columnCount > 0
        ? savedTable.columnCount
        : 3;
      restoredRows = savedTable.rows.map((r) => ({
        entities: Array.isArray(r?.entities) ? r.entities : [],
      }));
    } else if (Array.isArray(savedTable)) {
      appState.entityColumnCount = 3;
      restoredRows = savedTable.map((r) => ({
        entities: [r?.entity1 || '', r?.entity2 || '', r?.entity3 || ''],
      }));
    }

    renderTableHeader();
    if (restoredRows.length > 0) {
      restoredRows.forEach((r) => {
        addEntityRow(r.entities);
      });
    } else {
      addEntityRow();
    }
  } else {
    renderTableHeader();
    addEntityRow();
  }
} catch {
  renderTableHeader();
  addEntityRow();
}

try {
  const savedTemplateRaw = localStorage.getItem('lm_template');
  if (savedTemplateRaw) {
    const tpl = JSON.parse(savedTemplateRaw);
    if (tpl.widthMm) inputWidth.value = tpl.widthMm;
    if (tpl.heightMm) inputHeight.value = tpl.heightMm;
    if (tpl.zoom) {
      document.getElementById('input-zoom').value = tpl.zoom;
      document.getElementById('zoom-label').textContent = tpl.zoom + '%';
    }

    initStage(false);
    if (Array.isArray(tpl.nodes)) {
      restoreSavedNodes(tpl.nodes);
    }

    appState.transformer.nodes([]);
    appState.layer.batchDraw();
  } else {
    initStage();
    // Add a default placeholder text node so users see an example
    addTextNodeWithProps('%E1%', 10, 10, DEFAULT_FONT_SIZE, '#000000');
    appState.transformer.nodes([]);
    appState.layer.batchDraw();
  }
} catch {
  initStage();
  // Add a default placeholder text node so users see an example
  addTextNodeWithProps('%E1%', 10, 10, DEFAULT_FONT_SIZE, '#000000');
  appState.transformer.nodes([]);
  appState.layer.batchDraw();
}

updateCounter();
schedulePreviewUpdate();
pushHistory();

// Detect canvas fingerprinting protection at startup
if (isCanvasReadBlocked()) {
  document.getElementById('canvas-block-warning').style.display = 'block';
  // Push entire page content down so the fixed banner does not overlap the top bar
  document.body.style.paddingTop = '42px';
}

