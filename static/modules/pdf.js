import { appState, PDF_DPI, PREVIEW_PIXEL_RATIO } from './state.js';
import { applyOtsuBinarization, rotateImageData90cw } from './image-processing.js';
import {
  substituteEntityPlaceholders,
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
        let imageForRow = null;
        if (resolvedUrl) {
          try {
            imageForRow = await loadImageCached(resolvedUrl);
          } catch {
            imageForRow = null;
          }
        }
        // When URL is missing or fails, render a blank white canvas (no placeholder text in output)
        if (!imageForRow) {
          const blank = document.createElement('canvas');
          blank.width  = Math.max(1, Math.round(n.width));
          blank.height = Math.max(1, Math.round(n.height));
          blank.getContext('2d').fillStyle = '#ffffff';
          blank.getContext('2d').fillRect(0, 0, blank.width, blank.height);
          imageForRow = blank;
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
 * Placeholders matching %E1%, %E2%, ... in text/QR nodes are substituted per row via renderOffscreenLabel.
 */
export async function generatePDF() {
  const rows = getRows();
  if (rows.length === 0) {
    showToast('No labels to generate. Add at least one row first.', 'danger');
    return;
  }

  const widthMm  = parseFloat(document.getElementById('input-width').value)  || 58;
  const heightMm = parseFloat(document.getElementById('input-height').value) || 40;
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

  const serializedNodes = serializeLayerNodes();
  const stageW = appState.stage.width();
  const stageH = appState.stage.height();

  const btn = document.getElementById('btn-generate');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;

  try {
    for (let idx = 0; idx < rows.length; idx += 1) {
      btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span> Generating ${idx + 1}/${rows.length}...`;

      const row = rows[idx];
      if (idx > 0) doc.addPage([pdfPageWidthMm, pdfPageHeightMm], orientation);

      let imgData = await renderOffscreenLabel(serializedNodes, row, stageW, stageH, PDF_DPI / 96);
      if (rotatePdf) imgData = await rotateImageData90cw(imgData);
      doc.addImage(imgData, 'PNG', 0, 0, pdfPageWidthMm, pdfPageHeightMm);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }

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
