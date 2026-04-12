import { appState } from './state.js';
import { showToast } from './utils.js';

// Default label dimensions used as fallback when DOM inputs are empty
const DEFAULT_WIDTH_MM = 58;
const DEFAULT_HEIGHT_MM = 40;

// Injected callbacks — set via initTemplate(); defaults are no-op placeholders
let _initStage = () => {};
let _restoreSavedNodes = () => {};
let _renderTableHeader = () => {};
let _pushHistory = () => {};
let _schedulePreviewUpdate = () => {};

/**
 * Initialize template module with required callbacks.
 * Must be called once, after all dependent functions are defined in app.js.
 *
 * @param {{ initStage: Function, restoreSavedNodes: Function, renderTableHeader: Function, pushHistory: Function, schedulePreviewUpdate: Function }} callbacks
 */
export function initTemplate({ initStage, restoreSavedNodes, renderTableHeader, pushHistory, schedulePreviewUpdate }) {
  _initStage = initStage;
  _restoreSavedNodes = restoreSavedNodes;
  _renderTableHeader = renderTableHeader;
  _pushHistory = pushHistory;
  _schedulePreviewUpdate = schedulePreviewUpdate;
}

/**
 * Serialize all layer nodes (text, image, qr, line) into a plain-object array.
 * Skips background Rect and Transformer nodes.
 *
 * @returns {Object[]} array of serialized node descriptors
 */
export function serializeLayerNodes() {
  if (!appState.layer) return [];

  const nodes = [];
  appState.layer.getChildren().forEach(node => {
    const cls = node.getClassName();
    if (cls === 'Rect' || cls === 'Transformer') return;
    if (cls === 'Text') {
      nodes.push({
        type:     'text',
        text:     node.text(),
        x:        node.x(),
        y:        node.y(),
        rotation: node.rotation(),
        scaleX:   node.scaleX(),
        scaleY:   node.scaleY(),
        fontSize: node.fontSize(),
        fill:     node.fill(),
        width:    node.width(),
        height:   node.height(),
        align:    node.align(),
        verticalAlign: node.verticalAlign(),
      });
    } else if (cls === 'Image') {
      if (node._isQrNode) {
        nodes.push({
          type:     'qr',
          x:        node.x(),
          y:        node.y(),
          rotation: node.rotation(),
          scaleX:   node.scaleX(),
          scaleY:   node.scaleY(),
          width:    node.width(),
          height:   node.height(),
          content:  node._qrContent,
        });
      } else if (node._isUrlNode) {
        nodes.push({
          type:        'image',
          isUrl:       true,
          urlTemplate: node._srcTemplate,
          src:         null,
          x:           node.x(),
          y:           node.y(),
          rotation:    node.rotation(),
          scaleX:      node.scaleX(),
          scaleY:      node.scaleY(),
          width:       node.width(),
          height:      node.height(),
        });
      } else {
        nodes.push({
          type:     'image',
          x:        node.x(),
          y:        node.y(),
          rotation: node.rotation(),
          scaleX:   node.scaleX(),
          scaleY:   node.scaleY(),
          width:    node.width(),
          height:   node.height(),
          src:      node._srcDataUrl,
        });
      }
    } else if (cls === 'Line') {
      nodes.push({
        type:        'line',
        points:      node.points().slice(),
        x:           node.x(),
        y:           node.y(),
        rotation:    node.rotation(),
        scaleX:      node.scaleX(),
        scaleY:      node.scaleY(),
        stroke:      node.stroke(),
        strokeWidth: node.strokeWidth(),
      });
    }
  });

  return nodes;
}

/**
 * Serialize the current canvas state and trigger a JSON file download.
 * DOM elements are resolved inside the function to avoid timing issues.
 */
export function saveTemplate() {
  const nodes = serializeLayerNodes();

  const inputWidth  = document.getElementById('input-width');
  const inputHeight = document.getElementById('input-height');

  const tpl = {
    version: 1,
    widthMm: parseFloat(inputWidth.value) || DEFAULT_WIDTH_MM,
    heightMm: parseFloat(inputHeight.value) || DEFAULT_HEIGHT_MM,
    zoom: parseInt(document.getElementById('input-zoom').value, 10) || 200,
    columnCount: appState.entityColumnCount,
    nodes,
  };
  const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Build filename with current date/time: template_YYYY-MM-DD_HH-MM-SS.json
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  a.download = `template_${datePart}_${timePart}.json`;
  // Append to DOM so Firefox and older browsers trigger the download correctly
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Persist the current canvas state (template) to localStorage.
 * DOM elements are resolved inside the function to avoid timing issues.
 */
export function autoSaveTemplate() {
  if (!appState.layer) return;

  const nodes = serializeLayerNodes();

  const inputWidth  = document.getElementById('input-width');
  const inputHeight = document.getElementById('input-height');

  const tpl = {
    version: 1,
    widthMm: parseFloat(inputWidth.value) || DEFAULT_WIDTH_MM,
    heightMm: parseFloat(inputHeight.value) || DEFAULT_HEIGHT_MM,
    zoom: parseInt(document.getElementById('input-zoom').value, 10) || 200,
    nodes,
  };
  localStorage.setItem('lm_template', JSON.stringify(tpl));
}

/**
 * Load a template from the given file input and restore canvas + settings.
 * Uses injected callbacks set by initTemplate().
 *
 * @param {HTMLInputElement} input - the file input element whose files[0] is read
 */
export function loadTemplate(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const tpl = JSON.parse(e.target.result);
      if (!tpl.nodes || !Array.isArray(tpl.nodes)) throw new Error('Invalid template');

      const inputWidth  = document.getElementById('input-width');
      const inputHeight = document.getElementById('input-height');

      if (tpl.widthMm) inputWidth.value = tpl.widthMm;
      if (tpl.heightMm) inputHeight.value = tpl.heightMm;
      if (tpl.zoom) {
        document.getElementById('input-zoom').value = tpl.zoom;
        document.getElementById('zoom-label').textContent = tpl.zoom + '%';
      }
      // Restore column count if present in template
      if (Number.isInteger(tpl.columnCount) && tpl.columnCount > 0) {
        appState.entityColumnCount = tpl.columnCount;
      }
      _renderTableHeader();

      _initStage(false);
      _restoreSavedNodes(tpl.nodes);

      // Guard against transformer/layer being null if _initStage failed
      if (appState.transformer) appState.transformer.nodes([]);
      if (appState.layer) appState.layer.batchDraw();
      _schedulePreviewUpdate();
      _pushHistory();
      showToast('Template loaded!', 'success');
    } catch (err) {
      showToast('Failed to load template: ' + err.message, 'danger');
    }
  };
  reader.readAsText(file);
}
