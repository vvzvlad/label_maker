import { appState, PX_PER_MM, HISTORY_MAX } from './state.js';
import { serializeLayerNodes, autoSaveTemplate } from './template.js';

// ── DI callbacks ─────────────────────────────────────────────────
// These are injected via initStageModule() to avoid circular dependencies.

let _hideContextMenu = () => {};
let _schedulePreviewUpdate = () => {};
// Warn if initStage() is called before initStageModule() wires the real implementation.
let _restoreSavedNodes = () => {
  console.warn('[stage] initStageModule() was not called before initStage() u2014 nodes will not be restored.');
};

/**
 * Initialize stage module with required callbacks from app.js.
 * Must be called once during app initialization.
 *
 * @param {{ hideContextMenu: Function, schedulePreviewUpdate: Function, restoreSavedNodes: Function }} callbacks
 */
export function initStageModule({ hideContextMenu, schedulePreviewUpdate, restoreSavedNodes }) {
  _hideContextMenu = hideContextMenu;
  _schedulePreviewUpdate = schedulePreviewUpdate;
  _restoreSavedNodes = restoreSavedNodes;
}

/**
 * Select the given Konva nodes with the transformer, set anchor types, and
 * move the transformer to the top of the layer so its anchors are never
 * occluded by other elements.
 *
 * @param {Konva.Node[]} nodes - nodes to select
 * @param {string[]|null} anchors - anchor names; if null, current setting is kept
 * @param {boolean} addToSelection - when true, toggles first node in/out of current selection
 */
export function selectWithTransformer(nodes, anchors = null, addToSelection = false) {
  const fullSelectionAnchors = [
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
    'middle-left', 'middle-right', 'top-center', 'bottom-center',
  ];

  if (addToSelection) {
    const currentNodes = appState.transformer.nodes();
    const clickedNode = nodes[0];
    let updatedNodes = currentNodes.slice();

    if (clickedNode) {
      const existingIndex = updatedNodes.indexOf(clickedNode);
      if (existingIndex >= 0) {
        updatedNodes.splice(existingIndex, 1);
      } else {
        updatedNodes.push(clickedNode);
      }
    }

    if (updatedNodes.length > 1) {
      appState.transformer.enabledAnchors(fullSelectionAnchors);
    } else if (anchors !== null) {
      appState.transformer.enabledAnchors(anchors);
    }

    appState.transformer.nodes(updatedNodes);
  } else {
    if (anchors !== null) {
      appState.transformer.enabledAnchors(anchors);
    }
    appState.transformer.nodes(nodes);
  }

  appState.transformer.moveToTop();
  appState.layer.batchDraw();
}

export function applyZoom() {
  const pct = parseInt(document.getElementById('input-zoom').value, 10);
  const zoom = pct / 100;
  document.getElementById('zoom-label').textContent = pct + '%';
  const stageW = appState.stage.width();
  const stageH = appState.stage.height();
  const zoomSpacer = document.getElementById('zoom-spacer');
  const scaleWrap = document.getElementById('konva-scale-wrap');
  zoomSpacer.style.width = (stageW * zoom) + 'px';
  zoomSpacer.style.height = (stageH * zoom) + 'px';
  scaleWrap.style.transform = `scale(${zoom})`;
}

// ── Konva stage initialization ───────────────────────────────────

/**
 * Initialize (or reinitialize) the Konva stage with the current mm dimensions.
 * Existing text nodes are preserved when re-creating the stage.
 */
export function initStage(preserveNodes = true) {
  // Resolve DOM inputs inside function to avoid top-level timing issues
  const inputWidth  = document.getElementById('input-width');
  const inputHeight = document.getElementById('input-height');

  appState.imageCache.clear();
  const widthMm  = parseFloat(inputWidth.value)  || 58;
  const heightMm = parseFloat(inputHeight.value) || 40;
  const stageW   = Math.round(widthMm  * PX_PER_MM);
  const stageH   = Math.round(heightMm * PX_PER_MM);

  // Collect existing nodes before destroying stage
  const savedNodes = [];
  if (preserveNodes && appState.layer) {
    appState.layer.getChildren().forEach(node => {
      const cls = node.getClassName();
      if (cls === 'Text') {
        savedNodes.push({
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
           savedNodes.push({
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
           savedNodes.push({
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
           savedNodes.push({
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
         savedNodes.push({
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
   }

  // Destroy old stage if present
  if (appState.stage) {
    appState.stage.destroy();
    appState.stage = null;
    appState.layer = null;
    appState.transformer = null;
    appState.bgRect = null;
  }

  // Create new stage
  appState.stage = new Konva.Stage({
    container: 'konva-container',
    width:  stageW,
    height: stageH,
  });

  appState.layer = new Konva.Layer();
  appState.stage.add(appState.layer);

  // White background rect (non-interactive)
  appState.bgRect = new Konva.Rect({
    x: 0,
    y: 0,
    width:  stageW,
    height: stageH,
    fill:   '#ffffff',
    listening: false,
  });
  appState.layer.add(appState.bgRect);

  // Shared transformer for selection handles
  // anchorSize increased to 10px for easier grab; transformer is moved to top on every selection
  appState.transformer = new Konva.Transformer({
    enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    anchorSize: 7,
    boundBoxFunc: (oldBox, newBox) => newBox,
  });
  appState.layer.add(appState.transformer);

  // Restore previously saved nodes
  _restoreSavedNodes(savedNodes);

  // Deselect when clicking on empty stage area
  appState.stage.on('click tap', (e) => {
    if (e.target === appState.stage || e.target === appState.bgRect) {
      _hideContextMenu();
      appState.transformer.nodes([]);
      appState.layer.batchDraw();
    }
  });

  appState.layer.batchDraw();
  applyZoom();
}

export function pushHistory() {
  if (!appState.layer) return;

  // Discard forward history when recording a new snapshot.
  appState.historyStack = appState.historyStack.slice(0, appState.historyIndex + 1);
  appState.historyStack.push(serializeLayerNodes());

  // Enforce maximum history depth.
  if (appState.historyStack.length > HISTORY_MAX) {
    appState.historyStack.shift();
  }

  appState.historyIndex = appState.historyStack.length - 1;
}

export function applyHistory(snapshot) {
  initStage(false);
  _restoreSavedNodes(snapshot || []);
  appState.transformer.nodes([]);
  appState.layer.batchDraw();
  autoSaveTemplate();
  _schedulePreviewUpdate();
}

export function undoHistory() {
  if (appState.historyIndex <= 0) return;
  appState.historyIndex -= 1;
  applyHistory(appState.historyStack[appState.historyIndex]);
}

export function redoHistory() {
  if (appState.historyIndex >= appState.historyStack.length - 1) return;
  appState.historyIndex += 1;
  applyHistory(appState.historyStack[appState.historyIndex]);
}

// Register the gray-area deselect listener once (not inside initStage) to prevent
// listener accumulation on repeated initStage() calls (e.g. undo/redo, resize).
document.getElementById('konva-stage-wrap').addEventListener('click', (e) => {
  if (e.target === document.getElementById('konva-stage-wrap')) {
    _hideContextMenu();
    if (appState.transformer) appState.transformer.nodes([]);
    if (appState.layer) appState.layer.batchDraw();
  }
});
