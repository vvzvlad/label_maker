import { appState, DEFAULT_FONT_SIZE } from './state.js';
import { selectWithTransformer, pushHistory } from './stage.js';
import { showContextMenu } from './context-menu.js';
import {
  generateQrDataUrl,
  loadImage,
  createUrlPlaceholderImage,
  fitImageToCanvas,
  buildUrlNodePreviewImage,
  loadImageCached,
} from './utils.js';

// Warn if a node function is called before initNodes() wires the real implementation.
let _schedulePreviewUpdate = () => {
  console.warn('[nodes] initNodes() was not called before a node function — preview will not update.');
};

export function initNodes({ schedulePreviewUpdate }) {
  _schedulePreviewUpdate = schedulePreviewUpdate;
}

export function onDragEnd() {
  _schedulePreviewUpdate();
  pushHistory();
}

export function onTransformEnd() {
  _schedulePreviewUpdate();
  pushHistory();
}

// ── Text node creation ───────────────────────────────────────────

/**
 * Create and register a Konva.Text node with interaction handlers.
 */
export function addTextNodeWithProps(text, x, y, fontSize, fill, width = 200, align = 'left', verticalAlign = 'top', textHeight = undefined) {
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
export function startTextEdit(textNode) {
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
    _schedulePreviewUpdate();
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
export function addTextNode() {
  const fontSize = DEFAULT_FONT_SIZE;
  const cx = appState.stage.width()  / 2;
  const cy = appState.stage.height() / 2;
  const node = addTextNodeWithProps('New text', cx - 30, cy - fontSize / 2, fontSize, '#000000');
  // Select the newly created node
  selectWithTransformer([node]);
  _schedulePreviewUpdate();
  pushHistory();
}

export function attachImageNodeHandlers(kImg) {
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

export async function editUrlNodeTemplate(node) {
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
  _schedulePreviewUpdate();
  pushHistory();
}

export async function addImageNodeFromUrl() {
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
  _schedulePreviewUpdate();
  pushHistory();
}

export function addImageNode(input) {
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
      _schedulePreviewUpdate();
      pushHistory();
    };
    imgEl.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

export function attachQrNodeHandlers(qrNode) {
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
    _schedulePreviewUpdate();
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

export function addQrNode() {
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
    _schedulePreviewUpdate();
    pushHistory();
  });
}

export function addLineNode() {
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
  _schedulePreviewUpdate();
  pushHistory();
}

export function attachLineNodeHandlers(line) {
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

export function restoreUrlImageNode(n) {
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
  _schedulePreviewUpdate();

  buildUrlNodePreviewImage(kImg._srcTemplate).then((previewImage) => {
    if (!kImg.getStage()) return;
    if (previewImage instanceof HTMLImageElement) {
      kImg.image(fitImageToCanvas(previewImage, kImg.width(), kImg.height()));
    } else {
      kImg.image(previewImage);
    }
    appState.layer.batchDraw();
    _schedulePreviewUpdate();
  });
}

export function restoreSavedNodes(nodes) {
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
        _schedulePreviewUpdate();
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
        _schedulePreviewUpdate();
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
