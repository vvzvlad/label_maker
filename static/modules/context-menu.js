import { appState } from './state.js';
import { pushHistory, undoHistory, redoHistory, selectWithTransformer } from './stage.js';

// ── DI callbacks ─────────────────────────────────────────────────

let _addTextNodeWithProps = () => {};
let _attachLineNodeHandlers = () => {};
let _attachQrNodeHandlers = () => {};
let _attachImageNodeHandlers = () => {};
let _closePdfModal = () => {};
let _schedulePreviewUpdate = () => {};
// Guard to prevent duplicate event listener registration if initContextMenu is called more than once.
let _listenersRegistered = false;

export function initContextMenu({ addTextNodeWithProps, attachLineNodeHandlers, attachQrNodeHandlers, attachImageNodeHandlers, closePdfModal, schedulePreviewUpdate }) {
  _addTextNodeWithProps = addTextNodeWithProps;
  _attachLineNodeHandlers = attachLineNodeHandlers;
  _attachQrNodeHandlers = attachQrNodeHandlers;
  _attachImageNodeHandlers = attachImageNodeHandlers;
  _closePdfModal = closePdfModal;
  _schedulePreviewUpdate = schedulePreviewUpdate;

  _registerEventListeners();
}

// ── DOM references ────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────

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
export function showContextMenu(x, y, node) {
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

export function hideContextMenu() {
  ctxMenu.style.display = 'none';
  ctxTarget = null;
  ctxIsMultiSelect = false;
}

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
  _schedulePreviewUpdate();
  pushHistory();
  hideContextMenu();
}

// ── Event listeners ───────────────────────────────────────────────

function _registerEventListeners() {
  if (_listenersRegistered) return;
  _listenersRegistered = true;

  // Delete action
  ctxDelete.addEventListener('click', () => {
    const nodesToDelete = appState.transformer.nodes().length >= 2
      ? appState.transformer.nodes().slice()
      : (ctxTarget ? [ctxTarget] : []);

    if (nodesToDelete.length > 0) {
      nodesToDelete.forEach((node) => node.destroy());
      appState.transformer.nodes([]);
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
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
        const textNode = _addTextNodeWithProps(
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
        _attachLineNodeHandlers(line);
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
        _attachQrNodeHandlers(qrNode);
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
        _attachImageNodeHandlers(urlNode);
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
        _attachImageNodeHandlers(imageNode);
        newNodes.push(imageNode);
      }
    });

    if (newNodes.length > 0) {
      selectWithTransformer(newNodes);
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
      pushHistory();
    }

    hideContextMenu();
  });

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
    _schedulePreviewUpdate();
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
    _schedulePreviewUpdate();
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
    _schedulePreviewUpdate();
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
    _schedulePreviewUpdate();
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
      _schedulePreviewUpdate();
      pushHistory();
    }
  });
  ctxAlignCenter.addEventListener('click', (e) => {
    e.preventDefault();
    if (ctxTarget && ctxTarget.getClassName() === 'Text') {
      ctxTarget.align('center');
      setAlignButtonsActive('center');
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
      pushHistory();
    }
  });
  ctxAlignRight.addEventListener('click', (e) => {
    e.preventDefault();
    if (ctxTarget && ctxTarget.getClassName() === 'Text') {
      ctxTarget.align('right');
      setAlignButtonsActive('right');
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
      pushHistory();
    }
  });

  ctxValignTop.addEventListener('click', (e) => {
    e.preventDefault();
    if (ctxTarget && ctxTarget.getClassName() === 'Text') {
      ctxTarget.verticalAlign('top');
      setVerticalAlignButtonsActive('top');
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
      pushHistory();
    }
  });
  ctxValignMiddle.addEventListener('click', (e) => {
    e.preventDefault();
    if (ctxTarget && ctxTarget.getClassName() === 'Text') {
      ctxTarget.verticalAlign('middle');
      setVerticalAlignButtonsActive('middle');
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
      pushHistory();
    }
  });
  ctxValignBottom.addEventListener('click', (e) => {
    e.preventDefault();
    if (ctxTarget && ctxTarget.getClassName() === 'Text') {
      ctxTarget.verticalAlign('bottom');
      setVerticalAlignButtonsActive('bottom');
      appState.layer.batchDraw();
      _schedulePreviewUpdate();
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
      _closePdfModal();
    }

    // Arrow key nudging: move selected nodes by 1px per keypress.
    // Skip when focus is inside text inputs to avoid interfering with typing.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
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
        _schedulePreviewUpdate();
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
    _schedulePreviewUpdate();
    pushHistory();
  });
}
