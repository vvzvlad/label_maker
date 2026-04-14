import { appState, PDF_DPI, PREVIEW_PIXEL_RATIO } from './state.js';
import { applyOtsuBinarization, rotateImageData90cw } from './image-processing.js';
import {
  substituteEntityPlaceholders,
  createUrlPlaceholderImage,
  fitImageToCanvas,
  loadImageCached,
  showToast,
} from './utils.js';
import { serializeLayerNodes, autoSaveTemplate } from './template.js';
import { getRows } from './entity-table.js';

let _schedulePreviewUpdate = () => {};

export function initPdf({ schedulePreviewUpdate }) {
  _schedulePreviewUpdate = schedulePreviewUpdate;

  document.getElementById('pdf-modal-close').addEventListener('click', closePdfModal);
  document.getElementById('pdf-modal-backdrop').addEventListener('click', closePdfModal);
}

// Encapsulate modal state in a single object to avoid polluting the global scope
const pdfModal = { blobUrl: null, isOpen: false };

export async function renderOffscreenLabel(serializedNodes, row, stageW, stageH, pixelRatio) {
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
export async function generatePDF() {
  const rows = getRows();
  if (rows.length === 0) {
    showToast('No labels to generate. Add at least one row first.', 'danger');
    return;
  }

  const inputWidth  = document.getElementById('input-width');
  const inputHeight = document.getElementById('input-height');
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

export function openPdfModal(blobUrl) {
  // Store blob URL for later revocation on close
  pdfModal.blobUrl = blobUrl;
  pdfModal.isOpen = true;
  document.getElementById('pdf-modal-iframe').src = blobUrl;
  document.getElementById('pdf-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden'; // prevent background scroll
}

export function closePdfModal() {
  pdfModal.isOpen = false;
  document.getElementById('pdf-modal').style.display = 'none';
  document.getElementById('pdf-modal-iframe').src = ''; // stop loading
  document.body.style.overflow = ''; // restore scroll
  if (pdfModal.blobUrl) {
    URL.revokeObjectURL(pdfModal.blobUrl); // free memory
    pdfModal.blobUrl = null;
  }
}

export async function renderPreviewStrip() {
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
