import {
  appState,
  PDF_DPI, PREVIEW_PIXEL_RATIO, PREVIEW_DEBOUNCE_MS,
  DEFAULT_FONT_SIZE,
} from './modules/state.js';
import { initStageModule, selectWithTransformer, applyZoom, initStage, pushHistory, applyHistory, undoHistory, redoHistory } from './modules/stage.js';
import { initEntityTable, renderTableHeader, addEntityRow, getRows, autoSaveTable, updateCounter } from './modules/entity-table.js';
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

// ── DOM references ──────────────────────────────────────────────
const inputWidth    = document.getElementById('input-width');
const inputHeight   = document.getElementById('input-height');

function schedulePreviewUpdate() {
  clearTimeout(appState.previewTimer);
  appState.previewTimer = setTimeout(renderPreviewStrip, PREVIEW_DEBOUNCE_MS);
}

function onDragEnd() {
  schedulePreviewUpdate();
  pushHistory();
}

function onTransformEnd() {
  schedulePreviewUpdate();
  pushHistory();
}

// ── Context menu ─────────────────────────────────────────────
const ctxMenu         = document.getElementById('ctx-menu');
const ctxDelete       = document.getElementById('ctx-delete');
const ctxDuplicate    = document.getElementById('ctx-duplicate');
const ctxSizesRow     = document.getElementById('ctx-sizes-row');
const ctxAlignsRow    = document.getElementById('ctx-aligns-row');
const ctxFontInput    = document.getElementById('ctx-fontsize');
const ctxTextHeightInput = document.getElementById('ctx-textheight');
const ctxStrokeInput  = document.getElementById('ctx-strokewidth');
const ctxAlignLine    = document.getElementById('ctx-align-line');
const ctxAlignLeft    = document.getElementById('ctx-align-left');
const ctxAlignCenter  = document.getElementById('ctx-align-center');
const ctxAlignRight   = document.getElementById('ctx-align-right');
const ctxValignTop    = document.getElementById('ctx-valign-top');
const ctxValignMiddle = document.getElementById('ctx-valign-middle');
const ctxValignBottom = document.getElementById('ctx-valign-bottom');
const ctxMultiAlign   = document.getElementById('ctx-multi-align');
let ctxTarget       = null;
let ctxIsMultiSelect = false;

function setAlignButtonsActive(align) {
  const value = align || 'left';
  const buttons = [
    { el: ctxAlignLeft, value: 'left' },
    { el: ctxAlignCenter, value: 'center' },
    { el: ctxAlignRight, value: 'right' },
  ];
  buttons.forEach(({ el, value: btnValue }) => {
    const isActive = value === btnValue;
    el.classList.toggle('active', isActive);
  });
}

function setVerticalAlignButtonsActive(verticalAlign) {
  const value = verticalAlign || 'top';
  const buttons = [
    { el: ctxValignTop, value: 'top' },
    { el: ctxValignMiddle, value: 'middle' },
    { el: ctxValignBottom, value: 'bottom' },
  ];
  buttons.forEach(({ el, value: btnValue }) => {
    const isActive = value === btnValue;
    el.classList.toggle('active', isActive);
  });
}

/** Show context menu near the given screen position for the given node. */
function showContextMenu(x, y, node) {
  ctxTarget = node;
  ctxIsMultiSelect = appState.transformer.nodes().length >= 2;
  const cls = node.getClassName();

  ctxFontInput.value = cls === 'Text' ? node.fontSize() : '';
  ctxTextHeightInput.value = cls === 'Text' ? Math.round(node.height()) : '';
  ctxStrokeInput.value = cls === 'Line' ? node.strokeWidth() : '';

  // Show menu, then reposition to stay within viewport
  ctxMenu.style.display = 'block';
  const mw = ctxMenu.offsetWidth;
  const mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = (x + mw > window.innerWidth ? x - mw : x) + 'px';
  ctxMenu.style.top = (y + mh > window.innerHeight ? y - mh : y) + 'px';

  const isText = cls === 'Text';
  const isLine = cls === 'Line';
  const isMulti = ctxIsMultiSelect;
  // Show font size + area height row (flex layout) for text nodes
  ctxSizesRow.style.display = (!isMulti && isText) ? 'flex' : 'none';
  // Show alignment row (flex layout) for text nodes
  ctxAlignsRow.style.display = (!isMulti && isText) ? 'flex' : 'none';
  ctxMenu.querySelectorAll('[data-stroke-row]').forEach(el => {
    el.style.display = (!isMulti && isLine) ? '' : 'none';
  });
  ctxMultiAlign.style.display = isMulti ? '' : 'none';

  if (isText) {
    setAlignButtonsActive(node.align() || 'left');
    setVerticalAlignButtonsActive(node.verticalAlign() || 'top');
  } else {
    setAlignButtonsActive('left');
    setVerticalAlignButtonsActive('top');
  }
}

function hideContextMenu() {
  ctxMenu.style.display = 'none';
  ctxTarget = null;
  ctxIsMultiSelect = false;
}

// Delete action
ctxDelete.addEventListener('click', () => {
  const nodesToDelete = appState.transformer.nodes().length >= 2
    ? appState.transformer.nodes().slice()
    : (ctxTarget ? [ctxTarget] : []);

  if (nodesToDelete.length > 0) {
    nodesToDelete.forEach((node) => node.destroy());
    appState.transformer.nodes([]);
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
  hideContextMenu();
});

ctxDuplicate.addEventListener('click', () => {
  const nodesToDuplicate = appState.transformer.nodes().length >= 2
    ? appState.transformer.nodes().slice()
    : (ctxTarget ? [ctxTarget] : []);

  const newNodes = [];

  nodesToDuplicate.forEach((node) => {
    const cls = node.getClassName();

    if (cls === 'Text') {
      const textNode = addTextNodeWithProps(
        node.text(),
        node.x() + 10,
        node.y() + 10,
        node.fontSize(),
        node.fill(),
        node.width(),
        node.align(),
        node.verticalAlign(),
        node.height(),
      );
      textNode.rotation(node.rotation() || 0);
      textNode.scaleX(node.scaleX() !== undefined ? node.scaleX() : 1);
      textNode.scaleY(node.scaleY() !== undefined ? node.scaleY() : 1);
      newNodes.push(textNode);
      return;
    }

    if (cls === 'Line') {
      const line = new Konva.Line({
        points: node.points().slice(),
        x: node.x() + 10,
        y: node.y() + 10,
        rotation: node.rotation() || 0,
        scaleX: node.scaleX() !== undefined ? node.scaleX() : 1,
        scaleY: node.scaleY() !== undefined ? node.scaleY() : 1,
        stroke: node.stroke(),
        strokeWidth: node.strokeWidth(),
        lineCap: node.lineCap() || 'square',
        draggable: true,
        hitStrokeWidth: 20,
      });
      appState.layer.add(line);
      attachLineNodeHandlers(line);
      newNodes.push(line);
      return;
    }

    if (cls === 'Image' && node._isQrNode === true) {
      const qrNode = new Konva.Image({
        image: node.image(),
        x: node.x() + 10,
        y: node.y() + 10,
        width: node.width(),
        height: node.height(),
        rotation: node.rotation() || 0,
        scaleX: node.scaleX() !== undefined ? node.scaleX() : 1,
        scaleY: node.scaleY() !== undefined ? node.scaleY() : 1,
        draggable: true,
      });
      qrNode._isQrNode = true;
      qrNode._qrContent = node._qrContent;
      appState.layer.add(qrNode);
      attachQrNodeHandlers(qrNode);
      newNodes.push(qrNode);
      return;
    }

    if (cls === 'Image' && node._isUrlNode === true) {
      const urlNode = new Konva.Image({
        image: node.image(),
        x: node.x() + 10,
        y: node.y() + 10,
        width: node.width(),
        height: node.height(),
        rotation: node.rotation() || 0,
        scaleX: node.scaleX() !== undefined ? node.scaleX() : 1,
        scaleY: node.scaleY() !== undefined ? node.scaleY() : 1,
        draggable: true,
      });
      urlNode._isUrlNode = true;
      urlNode._srcTemplate = node._srcTemplate;
      urlNode._srcDataUrl = null;
      appState.layer.add(urlNode);
      attachImageNodeHandlers(urlNode);
      newNodes.push(urlNode);
      return;
    }

    if (cls === 'Image') {
      const imageNode = new Konva.Image({
        image: node.image(),
        x: node.x() + 10,
        y: node.y() + 10,
        width: node.width(),
        height: node.height(),
        rotation: node.rotation() || 0,
        scaleX: node.scaleX() !== undefined ? node.scaleX() : 1,
        scaleY: node.scaleY() !== undefined ? node.scaleY() : 1,
        draggable: true,
      });
      imageNode._srcDataUrl = node._srcDataUrl;
      imageNode._isUrlNode = false;
      imageNode._srcTemplate = null;
      appState.layer.add(imageNode);
      attachImageNodeHandlers(imageNode);
      newNodes.push(imageNode);
    }
  });

  if (newNodes.length > 0) {
    selectWithTransformer(newNodes);
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }

  hideContextMenu();
});

function alignSelectedNodes(type) {
  const nodes = appState.transformer.nodes();
  if (nodes.length < 2) return;

  // Get bounding rects for all selected nodes in layer coordinates
  const rects = nodes.map(node => node.getClientRect({ relativeTo: appState.layer }));

  let targetValue;
  switch (type) {
    case 'left':
      targetValue = Math.min(...rects.map(r => r.x));
      break;
    case 'center':
      targetValue = (Math.min(...rects.map(r => r.x)) + Math.max(...rects.map(r => r.x + r.width))) / 2;
      break;
    case 'right':
      targetValue = Math.max(...rects.map(r => r.x + r.width));
      break;
    case 'top':
      targetValue = Math.min(...rects.map(r => r.y));
      break;
    case 'middle':
      targetValue = (Math.min(...rects.map(r => r.y)) + Math.max(...rects.map(r => r.y + r.height))) / 2;
      break;
    case 'bottom':
      targetValue = Math.max(...rects.map(r => r.y + r.height));
      break;
    default:
      return;
  }

  nodes.forEach((node, index) => {
    const rect = rects[index];
    if (type === 'left') node.x(node.x() + (targetValue - rect.x));
    if (type === 'center') node.x(node.x() + (targetValue - (rect.x + rect.width / 2)));
    if (type === 'right') node.x(node.x() + (targetValue - (rect.x + rect.width)));
    if (type === 'top') node.y(node.y() + (targetValue - rect.y));
    if (type === 'middle') node.y(node.y() + (targetValue - (rect.y + rect.height / 2)));
    if (type === 'bottom') node.y(node.y() + (targetValue - (rect.y + rect.height)));
  });

  appState.layer.batchDraw();
  schedulePreviewUpdate();
  pushHistory();
  hideContextMenu();
}

document.getElementById('ctx-multi-align-left').addEventListener('click', () => alignSelectedNodes('left'));
document.getElementById('ctx-multi-align-center').addEventListener('click', () => alignSelectedNodes('center'));
document.getElementById('ctx-multi-align-right').addEventListener('click', () => alignSelectedNodes('right'));
document.getElementById('ctx-multi-align-top').addEventListener('click', () => alignSelectedNodes('top'));
document.getElementById('ctx-multi-align-middle').addEventListener('click', () => alignSelectedNodes('middle'));
document.getElementById('ctx-multi-align-bottom').addEventListener('click', () => alignSelectedNodes('bottom'));

// Font size change — apply live on input
ctxFontInput.addEventListener('input', () => {
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    const fs = parseInt(ctxFontInput.value, 10);
    if (fs > 0) {
      ctxTarget.fontSize(fs);
      appState.layer.batchDraw();
    }
  }
});
ctxFontInput.addEventListener('change', () => {
  schedulePreviewUpdate();
  pushHistory();
});

ctxTextHeightInput.addEventListener('input', () => {
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    const h = parseInt(ctxTextHeightInput.value, 10);
    if (h > 0) {
      ctxTarget.height(h);
      appState.layer.batchDraw();
    }
  }
});
ctxTextHeightInput.addEventListener('change', () => {
  schedulePreviewUpdate();
  pushHistory();
});

// Stroke width change — apply live on input
ctxStrokeInput.addEventListener('input', () => {
  if (ctxTarget && ctxTarget.getClassName() === 'Line') {
    const sw = parseInt(ctxStrokeInput.value, 10);
    if (sw > 0) {
      ctxTarget.strokeWidth(sw);
      appState.layer.batchDraw();
    }
  }
});
ctxStrokeInput.addEventListener('change', () => {
  schedulePreviewUpdate();
  pushHistory();
});

// Align line to nearest horizontal or vertical axis
ctxAlignLine.addEventListener('click', () => {
  if (!ctxTarget || ctxTarget.getClassName() !== 'Line') return;
  const line = ctxTarget;
  const pts = line.points();
  const transform = line.getAbsoluteTransform();
  const abs0 = transform.point({ x: pts[0], y: pts[1] });
  const abs1 = transform.point({ x: pts[2], y: pts[3] });
  const dx = abs1.x - abs0.x;
  const dy = abs1.y - abs0.y;

  // Snap to horizontal if |dy| < |dx|, otherwise snap to vertical
  if (Math.abs(dy) < Math.abs(dx)) {
    abs1.y = abs0.y; // horizontal alignment
  } else {
    abs1.x = abs0.x; // vertical alignment
  }

  // Rewrite line in canonical form: no rotation/scale, points from origin
  line.x(abs0.x);
  line.y(abs0.y);
  line.points([0, 0, abs1.x - abs0.x, abs1.y - abs0.y]);
  line.rotation(0);
  line.scaleX(1);
  line.scaleY(1);

  selectWithTransformer([line], ['middle-left', 'middle-right', 'top-center', 'bottom-center']);
  appState.layer.batchDraw();
  schedulePreviewUpdate();
  pushHistory();
  hideContextMenu();
});

// Text alignment change — apply on button click
ctxAlignLeft.addEventListener('click', (e) => {
  e.preventDefault();
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    ctxTarget.align('left');
    setAlignButtonsActive('left');
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
});
ctxAlignCenter.addEventListener('click', (e) => {
  e.preventDefault();
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    ctxTarget.align('center');
    setAlignButtonsActive('center');
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
});
ctxAlignRight.addEventListener('click', (e) => {
  e.preventDefault();
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    ctxTarget.align('right');
    setAlignButtonsActive('right');
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
});

ctxValignTop.addEventListener('click', (e) => {
  e.preventDefault();
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    ctxTarget.verticalAlign('top');
    setVerticalAlignButtonsActive('top');
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
});
ctxValignMiddle.addEventListener('click', (e) => {
  e.preventDefault();
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    ctxTarget.verticalAlign('middle');
    setVerticalAlignButtonsActive('middle');
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
});
ctxValignBottom.addEventListener('click', (e) => {
  e.preventDefault();
  if (ctxTarget && ctxTarget.getClassName() === 'Text') {
    ctxTarget.verticalAlign('bottom');
    setVerticalAlignButtonsActive('bottom');
    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  }
});

// Hide on outside click or Escape
document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
    // Use boolean flag instead of fragile style.display check
    if (pdfModal.isOpen) closePdfModal();
  }

  // Arrow key nudging: move selected nodes by 1px per keypress.
  // Skip when focus is inside text inputs to avoid interfering with typing.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const modifierPressed = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  const isUndo = modifierPressed && key === 'z' && !e.shiftKey;
  const isRedo = modifierPressed && e.shiftKey && key === 'z';

  if (isUndo) {
    e.preventDefault();
    undoHistory();
    return;
  }
  if (isRedo) {
    e.preventDefault();
    redoHistory();
    return;
  }

  // Delete/Backspace: remove all currently selected canvas nodes.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const nodesToDelete = appState.transformer.nodes().slice();
    if (nodesToDelete.length > 0) {
      e.preventDefault();
      nodesToDelete.forEach((node) => node.destroy());
      appState.transformer.nodes([]);
      appState.layer.batchDraw();
      schedulePreviewUpdate();
      pushHistory();
    }
    return;
  }

  const arrows = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = arrows[e.key];
  if (!delta) return;

  const nodes = appState.transformer?.nodes();
  if (!nodes || nodes.length === 0) return;

  e.preventDefault(); // Prevent page scrolling on arrow keys when nudging.
  nodes.forEach((node) => {
    node.x(node.x() + delta[0]);
    node.y(node.y() + delta[1]);
  });
  appState.layer.batchDraw();
  schedulePreviewUpdate();
  pushHistory();
});

// selectWithTransformer and applyZoom are imported from ./modules/stage.js

// initStage, pushHistory, applyHistory, undoHistory, redoHistory are imported from ./modules/stage.js

// ── Text node creation ───────────────────────────────────────────

/**
 * Create and register a Konva.Text node with interaction handlers.
 */
function addTextNodeWithProps(text, x, y, fontSize, fill, width = 200, align = 'left', verticalAlign = 'top', textHeight = undefined) {
  const textNode = new Konva.Text({
    text:      text,
    x:         x,
    y:         y,
    fontSize:  fontSize,
    fill:      fill || '#000000',
    width:     width,
    align:     align,
    verticalAlign: verticalAlign,
    // Default height equals font size so the area exactly fits one line of text
    height:    textHeight !== undefined ? textHeight : fontSize,
    wrap:      'word',
    draggable: true,
  });

  appState.layer.add(textNode);

  // Single click → select (attach transformer)
  textNode.on('click tap', (e) => {
    if (e.evt.button === 2) return; // ignore right-clicks; contextmenu handler handles them
    e.cancelBubble = true;
    const isMultiSelect = e.evt.ctrlKey || e.evt.metaKey;
    const anchors = isMultiSelect
      ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center']
      : ['middle-left', 'middle-right', 'top-center', 'bottom-center'];
    selectWithTransformer([textNode], anchors, isMultiSelect);
  });

  // Double-click → in-place textarea editing
  textNode.on('dblclick dbltap', () => {
    startTextEdit(textNode);
  });

  // Right-click → context menu
  textNode.on('contextmenu', (e) => {
    e.evt.preventDefault();
    const currentNodes = appState.transformer.nodes();
    if (currentNodes.length < 2 || !currentNodes.includes(textNode)) {
      selectWithTransformer([textNode], ['middle-left', 'middle-right', 'top-center', 'bottom-center']);
    }
    showContextMenu(e.evt.clientX, e.evt.clientY, textNode);
  });

  textNode.on('dragend', onDragEnd);

  textNode.on('transform', () => {
    textNode.width(Math.max(20, textNode.width() * textNode.scaleX()));
    textNode.scaleX(1);
    textNode.height(Math.max(4, textNode.height() * textNode.scaleY()));
    textNode.scaleY(1);
    appState.layer.batchDraw();
  });
  textNode.on('transformend', onTransformEnd);

  appState.layer.batchDraw();
  return textNode;
}

// ── In-place text editing ────────────────────────────────────────

/**
 * Show a <textarea> overlay positioned and styled to match the given text node,
 * allowing the user to edit its content in-place.
 * On blur or Enter (not Shift+Enter): commit changes and remove textarea.
 */
function startTextEdit(textNode) {
  // Hide the node while editing
  textNode.hide();
  appState.transformer.nodes([]);
  appState.layer.batchDraw();

  // Determine absolute position on screen, accounting for CSS zoom applied to #konva-scale-wrap
  const stageBox    = appState.stage.container().getBoundingClientRect();
  const absPos      = textNode.getAbsolutePosition();
  // CSS zoom factor from the zoom selector (not Konva's own scale, which stays at 1)
  const cssZoom     = parseInt(document.getElementById('input-zoom').value, 10) / 100;

  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);

  textarea.value = textNode.text();
  textarea.style.position   = 'fixed';
  textarea.style.top        = (stageBox.top  + absPos.y * cssZoom) + 'px';
  textarea.style.left       = (stageBox.left + absPos.x * cssZoom) + 'px';
  textarea.style.fontSize   = (textNode.fontSize() * cssZoom) + 'px';
  textarea.style.color      = textNode.fill();
  textarea.style.background = 'rgba(255,255,255,0.92)';
  textarea.style.border     = '1px solid #5A9A4A';
  textarea.style.borderRadius = '2px';
  textarea.style.padding    = '0';
  textarea.style.margin     = '0';
  textarea.style.lineHeight = '1.2';
  textarea.style.fontFamily = 'sans-serif';
  // Fix textarea dimensions to match the Konva text node dimensions (scaled by CSS zoom)
  textarea.style.width      = (textNode.width()  * cssZoom) + 'px';
  textarea.style.height     = (textNode.height() * cssZoom) + 'px';
  textarea.style.outline    = 'none';
  textarea.style.resize     = 'none';
  textarea.style.overflow   = 'auto';
  textarea.style.zIndex     = '10000';
  textarea.style.whiteSpace = 'pre-wrap';
  textarea.style.boxSizing  = 'border-box';

  textarea.focus();
  textarea.select();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;

    const newText = textarea.value.trim() !== '' ? textarea.value : textNode.text();
    textNode.text(newText);
    textNode.show();
    selectWithTransformer([textNode], ['middle-left', 'middle-right', 'top-center', 'bottom-center']);
    schedulePreviewUpdate();
    pushHistory();
    textarea.remove();
  }

  textarea.addEventListener('blur', commit);

  textarea.addEventListener('keydown', (e) => {
    // Enter without Shift commits; Shift+Enter inserts a newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      textarea.blur();
    }
    // Escape cancels — restore original text
    if (e.key === 'Escape') {
      committed = true;
      textNode.show();
      selectWithTransformer([textNode], ['middle-left', 'middle-right', 'top-center', 'bottom-center']);
      textarea.remove();
    }
  });
}

// ── Add / Delete text node buttons ───────────────────────────────

/** Add a new text node at the centre of the stage. */
function addTextNode() {
  const fontSize = DEFAULT_FONT_SIZE;
  const cx = appState.stage.width()  / 2;
  const cy = appState.stage.height() / 2;
  const node = addTextNodeWithProps('New text', cx - 30, cy - fontSize / 2, fontSize, '#000000');
  // Select the newly created node
  selectWithTransformer([node]);
  schedulePreviewUpdate();
  pushHistory();
}

function attachImageNodeHandlers(kImg) {
  kImg.on('click tap', (ev) => {
    if (ev.evt.button === 2) return; // ignore right-clicks
    ev.cancelBubble = true;
    const isMultiSelect = ev.evt.ctrlKey || ev.evt.metaKey;
    const anchors = isMultiSelect
      ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center']
      : ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    selectWithTransformer([kImg], anchors, isMultiSelect);
  });
  kImg.on('contextmenu', (ev) => {
    ev.evt.preventDefault();
    const currentNodes = appState.transformer.nodes();
    if (currentNodes.length < 2 || !currentNodes.includes(kImg)) {
      selectWithTransformer([kImg], ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    }
    showContextMenu(ev.evt.clientX, ev.evt.clientY, kImg);
  });
  kImg.on('dblclick dbltap', () => {
    if (kImg._isUrlNode) {
      editUrlNodeTemplate(kImg);
    }
  });
  kImg.on('dragend', onDragEnd);
  kImg.on('transformend', onTransformEnd);
}

async function editUrlNodeTemplate(node) {
  const updated = window.prompt('Image URL template:', node._srcTemplate || '');
  if (updated === null) return;
  const trimmed = updated.trim();
  if (!trimmed) return;

  node._srcTemplate = trimmed;
  const previewImage = await buildUrlNodePreviewImage(trimmed);
  if (previewImage instanceof HTMLImageElement) {
    node.image(fitImageToCanvas(previewImage, node.width(), node.height()));
  } else {
    node.image(previewImage);
  }
  appState.layer.batchDraw();
  schedulePreviewUpdate();
  pushHistory();
}

async function addImageNodeFromUrl() {
  const urlTemplateInput = window.prompt('Image URL template:', '');
  if (urlTemplateInput === null) return;
  const urlTemplate = urlTemplateInput.trim();
  if (!urlTemplate) return;

  const previewImage = await buildUrlNodePreviewImage(urlTemplate);
  const defaultSize = 80;
  let nodeImage = previewImage;
  let nodeWidth = defaultSize;
  let nodeHeight = defaultSize;

  if (previewImage instanceof HTMLImageElement) {
    const sourceW = previewImage.naturalWidth || previewImage.width || defaultSize;
    const sourceH = previewImage.naturalHeight || previewImage.height || defaultSize;
    const scale = Math.min(defaultSize / sourceW, defaultSize / sourceH);
    nodeWidth = Math.max(1, Math.round(sourceW * scale));
    nodeHeight = Math.max(1, Math.round(sourceH * scale));
    nodeImage = fitImageToCanvas(previewImage, nodeWidth, nodeHeight);
  }

  const kImg = new Konva.Image({
    image: nodeImage,
    x: (appState.stage.width() - nodeWidth) / 2,
    y: (appState.stage.height() - nodeHeight) / 2,
    width: nodeWidth,
    height: nodeHeight,
    draggable: true,
  });
  kImg._isUrlNode = true;
  kImg._srcTemplate = urlTemplate;
  kImg._srcDataUrl = null;
  appState.layer.add(kImg);
  attachImageNodeHandlers(kImg);

  selectWithTransformer([kImg], ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
  schedulePreviewUpdate();
  pushHistory();
}

function addImageNode(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = (e) => {
    const imgEl = new Image();
    imgEl.onload = () => {
      const maxW = appState.stage.width() * 0.8;
      const maxH = appState.stage.height() * 0.8;
      let w = imgEl.width;
      let h = imgEl.height;
      if (w > maxW) {
        h = h * maxW / w;
        w = maxW;
      }
      if (h > maxH) {
        w = w * maxH / h;
        h = maxH;
      }

      const kImg = new Konva.Image({
        image: imgEl,
        x: (appState.stage.width() - w) / 2,
        y: (appState.stage.height() - h) / 2,
        width: w,
        height: h,
        draggable: true,
      });
      kImg._srcDataUrl = e.target.result;
      kImg._isUrlNode = false;
      kImg._srcTemplate = null;
      appState.layer.add(kImg);
      attachImageNodeHandlers(kImg);

      selectWithTransformer([kImg]);
      schedulePreviewUpdate();
      pushHistory();
    };
    imgEl.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function attachQrNodeHandlers(qrNode) {
  qrNode.on('click tap', (ev) => {
    if (ev.evt.button === 2) return; // ignore right-clicks
    ev.cancelBubble = true;
    const isMultiSelect = ev.evt.ctrlKey || ev.evt.metaKey;
    const anchors = isMultiSelect
      ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center']
      : ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    selectWithTransformer([qrNode], anchors, isMultiSelect);
  });

  qrNode.on('dblclick dbltap', () => {
    const newContent = window.prompt('QR code content:', qrNode._qrContent);
    if (newContent === null || newContent === '') return;

    qrNode._qrContent = newContent;

    // Render at high resolution for crisp display; Konva.Image scales it down to node dimensions
    const qrCanvas = document.createElement('canvas');
    new QRious({ element: qrCanvas, value: qrNode._qrContent || ' ', size: 512 });
    qrNode.image(qrCanvas);

    appState.layer.batchDraw();
    schedulePreviewUpdate();
    pushHistory();
  });

  qrNode.on('contextmenu', (ev) => {
    ev.evt.preventDefault();
    const currentNodes = appState.transformer.nodes();
    if (currentNodes.length < 2 || !currentNodes.includes(qrNode)) {
      selectWithTransformer([qrNode], ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    }
    showContextMenu(ev.evt.clientX, ev.evt.clientY, qrNode);
  });

  qrNode.on('dragend', onDragEnd);
  qrNode.on('transformend', onTransformEnd);
}

function addQrNode() {
  const defaultContent = '%E1%';
  const defaultSize = 80; // display size in px on canvas
  // Render at 512px for crispness; Konva.Image will scale it to defaultSize for display
  const dataUrl = generateQrDataUrl(defaultContent, 512);

  loadImage(dataUrl, (imgEl) => {
    const qrNode = new Konva.Image({
      image: imgEl,
      x: (appState.stage.width() - defaultSize) / 2,
      y: (appState.stage.height() - defaultSize) / 2,
      width: defaultSize,
      height: defaultSize,
      draggable: true,
    });

    qrNode._isQrNode = true;
    qrNode._qrContent = defaultContent;
    appState.layer.add(qrNode);
    attachQrNodeHandlers(qrNode);

    selectWithTransformer([qrNode], ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    schedulePreviewUpdate();
    pushHistory();
  });
}

function addLineNode() {
  const cx = appState.stage.width() / 2;
  const cy = appState.stage.height() / 2;
  const line = new Konva.Line({
    points: [cx - 40, cy, cx + 40, cy],
    stroke: '#000000',
    strokeWidth: 2,
    lineCap: 'square',
    draggable: true,
    hitStrokeWidth: 20, // wider hit area so thin lines are easy to click
  });
  appState.layer.add(line);
  attachLineNodeHandlers(line);

  selectWithTransformer([line], ['middle-left', 'middle-right', 'top-center', 'bottom-center']);
  schedulePreviewUpdate();
  pushHistory();
}

function attachLineNodeHandlers(line) {
  line.on('click tap', (e) => {
    if (e.evt.button === 2) return; // ignore right-clicks
    e.cancelBubble = true;
    const isMultiSelect = e.evt.ctrlKey || e.evt.metaKey;
    const anchors = isMultiSelect
      ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center']
      : ['middle-left', 'middle-right', 'top-center', 'bottom-center'];
    selectWithTransformer([line], anchors, isMultiSelect);
  });
  line.on('contextmenu', (e) => {
    e.evt.preventDefault();
    const currentNodes = appState.transformer.nodes();
    if (currentNodes.length < 2 || !currentNodes.includes(line)) {
      selectWithTransformer([line], ['middle-left', 'middle-right', 'top-center', 'bottom-center']);
    }
    showContextMenu(e.evt.clientX, e.evt.clientY, line);
  });
  line.on('dragend', onDragEnd);
  line.on('transformend', onTransformEnd);
}

function restoreUrlImageNode(n) {
  const defaultImage = createUrlPlaceholderImage();
  const kImg = new Konva.Image({
    image: defaultImage,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    rotation: n.rotation || 0,
    scaleX: n.scaleX !== undefined ? n.scaleX : 1,
    scaleY: n.scaleY !== undefined ? n.scaleY : 1,
    draggable: true,
  });
  kImg._isUrlNode = true;
  kImg._srcTemplate = n.urlTemplate || '';
  kImg._srcDataUrl = null;
  appState.layer.add(kImg);
  attachImageNodeHandlers(kImg);
  appState.layer.batchDraw();
  schedulePreviewUpdate();

  buildUrlNodePreviewImage(kImg._srcTemplate).then((previewImage) => {
    if (!kImg.getStage()) return;
    if (previewImage instanceof HTMLImageElement) {
      kImg.image(fitImageToCanvas(previewImage, kImg.width(), kImg.height()));
    } else {
      kImg.image(previewImage);
    }
    appState.layer.batchDraw();
    schedulePreviewUpdate();
  });
}

function restoreSavedNodes(nodes) {
  nodes.forEach(n => {
    if (n.type === 'text') {
      const node = addTextNodeWithProps(n.text, n.x, n.y, n.fontSize, n.fill, n.width, n.align || 'left', n.verticalAlign || 'top', n.height);
      // Restore transform attributes that Transformer may have applied
      if (n.rotation) node.rotation(n.rotation);
      if (n.scaleX   !== undefined) node.scaleX(n.scaleX);
      if (n.scaleY   !== undefined) node.scaleY(n.scaleY);
    } else if (n.type === 'image' && n.isUrl === true) {
      restoreUrlImageNode(n);
    } else if (n.type === 'image' && n.src) {
      const imgEl = new Image();
      imgEl.onload = () => {
        const kImg = new Konva.Image({
          image:    imgEl,
          x:        n.x,
          y:        n.y,
          width:    n.width,
          height:   n.height,
          rotation: n.rotation || 0,
          scaleX:   n.scaleX   !== undefined ? n.scaleX : 1,
          scaleY:   n.scaleY   !== undefined ? n.scaleY : 1,
          draggable: true,
        });
        kImg._srcDataUrl = n.src;
        kImg._isUrlNode = false;
        kImg._srcTemplate = null;
        appState.layer.add(kImg);
        attachImageNodeHandlers(kImg);
        appState.layer.batchDraw();
        schedulePreviewUpdate();
      };
      imgEl.src = n.src;
    } else if (n.type === 'qr') {
      const qrWidth = n.width || 80;
      const qrHeight = n.height || 80;
      const qrContent = n.content || '%E1%';
      // Always render at high resolution; Konva.Image scales to qrWidth/qrHeight for display
      const dataUrl = generateQrDataUrl(qrContent, 512);

      loadImage(dataUrl, (imgEl) => {
        const qrNode = new Konva.Image({
          image:    imgEl,
          x:        n.x,
          y:        n.y,
          width:    qrWidth,
          height:   qrHeight,
          rotation: n.rotation || 0,
          scaleX:   n.scaleX   !== undefined ? n.scaleX : 1,
          scaleY:   n.scaleY   !== undefined ? n.scaleY : 1,
          draggable: true,
        });
        qrNode._isQrNode = true;
        qrNode._qrContent = qrContent;
        appState.layer.add(qrNode);
        attachQrNodeHandlers(qrNode);
        appState.layer.batchDraw();
        schedulePreviewUpdate();
      });
    } else if (n.type === 'line') {
      const line = new Konva.Line({
        points:      n.points,
        x:           n.x           || 0,
        y:           n.y           || 0,
        rotation:    n.rotation    || 0,
        scaleX:      n.scaleX      !== undefined ? n.scaleX : 1,
        scaleY:      n.scaleY      !== undefined ? n.scaleY : 1,
        stroke:      n.stroke      || '#000000',
        strokeWidth: n.strokeWidth || 2,
        lineCap:     'square',
        draggable:   true,
        hitStrokeWidth: 20, // wider hit area so thin lines are easy to click
      });
      appState.layer.add(line);
      attachLineNodeHandlers(line);
      appState.layer.batchDraw();
    }
  });
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
    label.textContent = row.entities.find(e => e) || '(empty)';
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

  // Capture table state (same logic as autoSaveTable but returns the object)
  const tbody = document.getElementById('entities-tbody');
  const rows = [];
  tbody.querySelectorAll('tr').forEach((tr) => {
    const inputs = tr.querySelectorAll('input.entity-input');
    const entities = [];
    for (let i = 0; i < appState.entityColumnCount; i += 1) {
      entities.push(inputs[i]?.value || '');
    }
    rows.push({ entities });
  });

  return {
    template: { version: 1, widthMm, heightMm, zoom, nodes },
    table: { columnCount: appState.entityColumnCount, rows },
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

// Wire stage module FIRST — initTemplate may call initStage() internally during restore.
try {
  initStageModule({ hideContextMenu, schedulePreviewUpdate, restoreSavedNodes });
} catch (e) {
  console.error('Failed to initialize stage module:', e);
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

