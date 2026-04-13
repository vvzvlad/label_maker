import {
  appState,
  PDF_DPI, PREVIEW_PIXEL_RATIO, PREVIEW_DEBOUNCE_MS,
  DEFAULT_FONT_SIZE,
} from './modules/state.js';
import { initStageModule, selectWithTransformer, applyZoom, initStage, pushHistory, applyHistory, undoHistory, redoHistory } from './modules/stage.js';
import { initContextMenu, showContextMenu, hideContextMenu } from './modules/context-menu.js';
import { initEntityTable, renderTableHeader, addEntityRow, getRows, autoSaveTable, updateCounter, serializeTableRows } from './modules/entity-table.js';
import { initTemplate, serializeLayerNodes, saveTemplate, autoSaveTemplate, loadTemplate } from './modules/template.js';
import {
  isCanvasReadBlocked,
  generateQrDataUrl,
  loadImage,
  createUrlPlaceholderImage,
  fitImageToCanvas,
  loadImageFromUrl,
  loadImageCached,
  substituteEntityPlaceholders,
  buildUrlNodePreviewImage,
  showToast,
} from './modules/utils.js';
import { applyOtsuBinarization, rotateImageData90cw } from './modules/image-processing.js';
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

async function renderOffscreenLabel(serializedNodes, row, stageW, stageH, pixelRatio) {
  const offscreenContainer = document.createElement('div');
  offscreenContainer.style.position = 'absolute';
  offscreenContainer.style.left = '0';
  offscreenContainer.style.top = '0';
  offscreenContainer.style.width = '0';
  offscreenContainer.style.height = '0';
  offscreenContainer.style.overflow = 'hidden';
  offscreenContainer.style.opacity = '0';
  offscreenContainer.style.pointerEvents = 'none';
  document.body.appendChild(offscreenContainer);

  let offStage = null;
  try {
    offStage = new Konva.Stage({
      container: offscreenContainer,
      width: stageW,
      height: stageH,
    });
    const offLayer = new Konva.Layer();
    offStage.add(offLayer);

    const offBgRect = new Konva.Rect({
      x: 0,
      y: 0,
      width: stageW,
      height: stageH,
      fill: '#ffffff',
      listening: false,
    });
    offLayer.add(offBgRect);

    for (const n of serializedNodes) {
      if (n.type === 'text') {
        const textNode = new Konva.Text({
          text: substituteEntityPlaceholders(n.text, row),
          x: n.x,
          y: n.y,
          rotation: n.rotation || 0,
          scaleX: n.scaleX !== undefined ? n.scaleX : 1,
          scaleY: n.scaleY !== undefined ? n.scaleY : 1,
          fontSize: n.fontSize,
          fill: n.fill,
          width: n.width,
          align: n.align || 'left',
          verticalAlign: n.verticalAlign || 'top',
          // Default height equals font size (matches the creation-time default)
          height: n.height !== undefined ? n.height : n.fontSize,
          wrap: 'word',
        });
        offLayer.add(textNode);
      } else if (n.type === 'qr') {
        const content = substituteEntityPlaceholders(n.content || '', row);
        const qrCanvas = document.createElement('canvas');
        new QRious({ element: qrCanvas, value: content || ' ', size: 256 });
        const qrNode = new Konva.Image({
          image: qrCanvas,
          x: n.x,
          y: n.y,
          rotation: n.rotation || 0,
          scaleX: n.scaleX !== undefined ? n.scaleX : 1,
          scaleY: n.scaleY !== undefined ? n.scaleY : 1,
          width: n.width,
          height: n.height,
        });
        offLayer.add(qrNode);
      } else if (n.type === 'image' && n.isUrl === true) {
        const resolvedUrl = substituteEntityPlaceholders(n.urlTemplate || '', row);
        let imageForRow = createUrlPlaceholderImage();
        if (resolvedUrl) {
          try {
            imageForRow = await loadImageCached(resolvedUrl);
          } catch {
            imageForRow = createUrlPlaceholderImage();
          }
        }
        const imageNode = new Konva.Image({
          image: imageForRow instanceof HTMLImageElement
            ? fitImageToCanvas(imageForRow, n.width, n.height)
            : imageForRow,
          x: n.x,
          y: n.y,
          rotation: n.rotation || 0,
          scaleX: n.scaleX !== undefined ? n.scaleX : 1,
          scaleY: n.scaleY !== undefined ? n.scaleY : 1,
          width: n.width,
          height: n.height,
        });
        offLayer.add(imageNode);
      } else if (n.type === 'image' && n.src) {
        const imgEl = await loadImageCached(n.src);
        const imageNode = new Konva.Image({
          image: imgEl,
          x: n.x,
          y: n.y,
          rotation: n.rotation || 0,
          scaleX: n.scaleX !== undefined ? n.scaleX : 1,
          scaleY: n.scaleY !== undefined ? n.scaleY : 1,
          width: n.width,
          height: n.height,
        });
        offLayer.add(imageNode);
      } else if (n.type === 'line') {
        const lineNode = new Konva.Line({
          points: n.points,
          x: n.x || 0,
          y: n.y || 0,
          rotation: n.rotation || 0,
          scaleX: n.scaleX !== undefined ? n.scaleX : 1,
          scaleY: n.scaleY !== undefined ? n.scaleY : 1,
          stroke: n.stroke || '#000000',
          strokeWidth: n.strokeWidth || 2,
          lineCap: 'square',
        });
        offLayer.add(lineNode);
      }
    }

    offLayer.batchDraw();
    const rawDataUrl = offStage.toDataURL({ pixelRatio: pixelRatio });
    return await applyOtsuBinarization(rawDataUrl);
  } finally {
    if (offStage) offStage.destroy();
    offscreenContainer.remove();
  }
}

// ── PDF generation ───────────────────────────────────────────────

/**
 * Generate a PDF with one label per page.
 * Placeholders matching %%ANYTHING%% in text nodes are replaced per label line.
 * The stage is exported as a PNG via stage.toDataURL() at 300 DPI equivalent.
 */
async function generatePDF() {
  const rows = getRows();
  if (rows.length === 0) {
    showToast('No labels to generate. Add at least one row first.', 'danger');
    return;
  }

  const widthMm  = parseFloat(inputWidth.value)  || 58;
  const heightMm = parseFloat(inputHeight.value) || 40;
  const rotatePdf = document.getElementById('input-rotate-90').checked;
  // For rotated export: page dimensions are swapped (label is placed rotated)
  const pdfPageWidthMm  = rotatePdf ? heightMm : widthMm;
  const pdfPageHeightMm = rotatePdf ? widthMm  : heightMm;

  const isLandscape = pdfPageWidthMm > pdfPageHeightMm;
  const orientation = isLandscape ? 'landscape' : 'portrait';

  const doc = new window.jspdf.jsPDF({
    orientation,
    unit: 'mm',
    format: [pdfPageWidthMm, pdfPageHeightMm],
  });

  // Collect all text nodes (skip background rect and transformer)
  const textNodes = appState.layer.getChildren().filter(n => n.getClassName() === 'Text');
  const qrNodes = appState.layer.getChildren().filter(n => n._isQrNode === true);
  const urlImageNodes = appState.layer.getChildren().filter(n => n._isUrlNode === true);

  // Remember original texts for restoration after each export
  const originalTexts = textNodes.map(n => n.text());
  const originalQrImages = qrNodes.map(n => n.image());
  const originalUrlImages = urlImageNodes.map(n => n.image());

  // Detach transformer so it doesn't appear in exported image
  const prevSelected = appState.transformer.nodes().slice();
  appState.transformer.nodes([]);

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (idx > 0) doc.addPage([pdfPageWidthMm, pdfPageHeightMm], orientation);

    // Substitute ENTITY placeholders; convert literal \n sequences to real newlines
    textNodes.forEach((node, ni) => {
      node.text(substituteEntityPlaceholders(originalTexts[ni], row));
    });

    // Substitute placeholders in QR content and regenerate QR image synchronously
    qrNodes.forEach((node) => {
      const content = substituteEntityPlaceholders(node._qrContent || '', row);

      // Render QR at high resolution so it stays sharp in high-DPI PDF export
      const qrCanvas = document.createElement('canvas');
      new QRious({ element: qrCanvas, value: content || ' ', size: 512 });
      node.image(qrCanvas);
    });

    await Promise.all(urlImageNodes.map(async (node) => {
      const resolvedUrl = substituteEntityPlaceholders(node._srcTemplate || '', row);
      let imageForRow = createUrlPlaceholderImage();
      if (resolvedUrl) {
        try {
          imageForRow = await loadImageCached(resolvedUrl);
        } catch {
          imageForRow = createUrlPlaceholderImage();
        }
      }
      if (imageForRow instanceof HTMLImageElement) {
        node.image(fitImageToCanvas(imageForRow, node.width(), node.height()));
      } else {
        node.image(imageForRow);
      }
    }));

    appState.layer.batchDraw();

    // Export stage as PNG at PDF_DPI resolution
    let imgData = await applyOtsuBinarization(appState.stage.toDataURL({ pixelRatio: PDF_DPI / 96 }));
    // If rotation is requested, rotate the exported image 90 degrees clockwise
    if (rotatePdf) {
      imgData = await rotateImageData90cw(imgData);
    }
    doc.addImage(imgData, 'PNG', 0, 0, pdfPageWidthMm, pdfPageHeightMm);

    // Restore original texts
    textNodes.forEach((node, ni) => node.text(originalTexts[ni]));
    qrNodes.forEach((node, ni) => node.image(originalQrImages[ni]));
    urlImageNodes.forEach((node, ni) => node.image(originalUrlImages[ni]));
  }

  // Restore transformer selection
  appState.transformer.nodes(prevSelected);
  appState.layer.batchDraw();

  // Open PDF in viewer overlay instead of downloading
  const pdfBlobUrl = doc.output('bloburl');
  openPdfModal(pdfBlobUrl);
  showToast(`PDF with ${rows.length} label${rows.length > 1 ? 's' : ''} generated!`, 'success');
}

// ── PDF viewer modal ─────────────────────────────────────────────

// Encapsulate modal state in a single object to avoid polluting the global scope
const pdfModal = { blobUrl: null, isOpen: false };

function openPdfModal(blobUrl) {
  // Store blob URL for later revocation on close
  pdfModal.blobUrl = blobUrl;
  pdfModal.isOpen = true;
  document.getElementById('pdf-modal-iframe').src = blobUrl;
  document.getElementById('pdf-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden'; // prevent background scroll
}

function closePdfModal() {
  pdfModal.isOpen = false;
  document.getElementById('pdf-modal').style.display = 'none';
  document.getElementById('pdf-modal-iframe').src = ''; // stop loading
  document.body.style.overflow = ''; // restore scroll
  if (pdfModal.blobUrl) {
    URL.revokeObjectURL(pdfModal.blobUrl); // free memory
    pdfModal.blobUrl = null;
  }
}

document.getElementById('pdf-modal-close').addEventListener('click', closePdfModal);
document.getElementById('pdf-modal-backdrop').addEventListener('click', closePdfModal);

async function renderPreviewStrip() {
  autoSaveTemplate();

  const rows = getRows();
  const strip = document.getElementById('preview-strip');

  if (rows.length === 0) {
    strip.innerHTML = '<span style="color:#666; font-size:0.82rem; padding:8px;">No labels — add at least one row.</span>';
    strip.style.display = 'flex';
    return;
  }

  const stageW = appState.stage.width();
  const stageH = appState.stage.height();
  const serializedNodes = serializeLayerNodes();
  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const dataUrl = await renderOffscreenLabel(serializedNodes, row, stageW, stageH, PREVIEW_PIXEL_RATIO);

    // Create thumbnail element
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-thumb';
    const img = document.createElement('img');
    img.src = dataUrl;
    const label = document.createElement('span');
    label.textContent = row.entities.find(e => e?.trim()) || '(empty)';
    wrapper.appendChild(img);
    wrapper.appendChild(label);
    fragment.appendChild(wrapper);
  }

  strip.innerHTML = '';
  strip.appendChild(fragment);
  strip.style.display = 'flex';
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

