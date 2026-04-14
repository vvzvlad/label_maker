import {
  appState,
  PREVIEW_DEBOUNCE_MS,
  DEFAULT_FONT_SIZE,
} from './modules/state.js';
import { initStageModule, applyZoom, initStage, pushHistory } from './modules/stage.js';
import { initContextMenu, hideContextMenu } from './modules/context-menu.js';
import { initEntityTable, renderTableHeader, addEntityRow, updateCounter } from './modules/entity-table.js';
import { initTemplate, saveTemplate, loadTemplate, applyTemplateState } from './modules/template.js';
import { isCanvasReadBlocked } from './modules/utils.js';
import { initPdf, generatePDF, closePdfModal, renderPreviewStrip } from './modules/pdf.js';
import { initPresets, openPresetsModal } from './modules/presets.js';
import {
  initNodes,
  addTextNodeWithProps, addTextNode,
  attachImageNodeHandlers, addImageNodeFromUrl, addImageNode,
  attachQrNodeHandlers, addQrNode,
  addLineNode, attachLineNodeHandlers,
  restoreSavedNodes,
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

try {
  initPresets({ schedulePreviewUpdate });
} catch (e) {
  console.error('Failed to initialize presets module:', e);
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

function initDefaultTemplate() {
  initStage();
  // Add a default placeholder text node so users see an example
  addTextNodeWithProps('%E1%', 10, 10, DEFAULT_FONT_SIZE, '#000000');
  appState.transformer.nodes([]);
  appState.layer.batchDraw();
}

try {
  const savedTemplateRaw = localStorage.getItem('lm_template');
  if (savedTemplateRaw) {
    applyTemplateState(JSON.parse(savedTemplateRaw));
  } else {
    initDefaultTemplate();
  }
} catch {
  initDefaultTemplate();
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
