import { appState } from './state.js';

// ── Helpers ─────────────────────────────────────────────────────

// Check if canvas pixel read-back is blocked by anti-fingerprinting protection
export function isCanvasReadBlocked() {
  try {
    const c = document.createElement('canvas');
    c.width = 10;
    c.height = 10;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#4d2d7a'; // distinctive color unlikely to appear by chance
    ctx.fillRect(2, 2, 6, 6);
    const d = ctx.getImageData(3, 3, 1, 1).data;
    return d[0] !== 0x4d || d[1] !== 0x2d || d[2] !== 0x7a;
  } catch {
    return true;
  }
}

// Generate a QR code data URL for the given text at the given pixel size
export function generateQrDataUrl(text, size) {
  const canvas = document.createElement('canvas');
  new QRious({ element: canvas, value: text || ' ', size: size });
  return canvas.toDataURL();
}

// Load a dataURL as an HTMLImageElement; returns a Promise that resolves with the img element.
export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

export function createUrlPlaceholderImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#888888';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('URL Image', canvas.width / 2, canvas.height / 2);
  return canvas;
}

export function fitImageToCanvas(img, targetW, targetH) {
  const sourceW = img.naturalWidth || img.width || targetW;
  const sourceH = img.naturalHeight || img.height || targetH;
  if (sourceW <= 0 || sourceH <= 0) {
    // Fallback: return a white canvas of node dimensions.
    const fallback = document.createElement('canvas');
    fallback.width = Math.max(1, Math.round(targetW));
    fallback.height = Math.max(1, Math.round(targetH));
    const fc = fallback.getContext('2d');
    fc.fillStyle = '#ffffff';
    fc.fillRect(0, 0, fallback.width, fallback.height);
    return fallback;
  }

  // Contain scale: how much to shrink the image to fit into targetW x targetH.
  const containScale = Math.min(targetW / sourceW, targetH / sourceH);

  // Keep canvas aspect ratio equal to the node ratio, but increase resolution
  // so Konva can scale down without losing source-image detail.
  const resFactor = Math.max(1, 1 / containScale);
  const canvasW = Math.max(1, Math.round(targetW * resFactor));
  const canvasH = Math.max(1, Math.round(targetH * resFactor));

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // White background for contain padding areas.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Draw source at native resolution centered inside the high-res canvas.
  const drawX = (canvasW - sourceW) / 2;
  const drawY = (canvasH - sourceH) / 2;
  ctx.drawImage(img, drawX, drawY, sourceW, sourceH);

  return canvas;
}

export function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image URL'));
    img.src = url;
  });
}

// Maximum number of images kept in the URL image cache (oldest entry evicted first).
const IMAGE_CACHE_MAX_SIZE = 100;

export async function loadImageCached(url) {
  if (appState.imageCache.has(url)) {
    return appState.imageCache.get(url);
  }
  // Let the error from loadImageFromUrl propagate to the caller naturally.
  const img = await loadImageFromUrl(url);
  // Evict the oldest entry when the cache reaches its size limit (Map preserves insertion order).
  if (appState.imageCache.size >= IMAGE_CACHE_MAX_SIZE) {
    const oldestKey = appState.imageCache.keys().next().value;
    appState.imageCache.delete(oldestKey);
  }
  appState.imageCache.set(url, img);
  return img;
}

export function substituteEntityPlaceholders(value, row) {
  let result = value || '';
  // Support both current format (row.entities array) and legacy format (row.entity1/2/3)
  // for backwards compatibility with presets saved before the table format migration.
  const entities = Array.isArray(row?.entities)
    ? row.entities
    : [row?.entity1 || '', row?.entity2 || '', row?.entity3 || ''];
  for (let i = 0; i < entities.length; i += 1) {
    const replacement = (entities[i] || '').replace(/\\n/g, '\n');
    result = result.replace(new RegExp(`%E${i + 1}%`, 'g'), replacement);
  }
  return result;
}

export async function buildUrlNodePreviewImage(urlTemplate) {
  const hasPlaceholders = /%E\d+%/.test(urlTemplate || '');
  if (!urlTemplate || hasPlaceholders) {
    return createUrlPlaceholderImage();
  }
  try {
    return await loadImageFromUrl(urlTemplate);
  } catch {
    return createUrlPlaceholderImage();
  }
}

// bootstrap is a CDN global provided by Bootstrap's bundle script.
// It cannot be imported as an ES module in this non-bundled project.
/* global bootstrap */

// Monotonic counter ensures unique toast IDs even when called multiple times per millisecond.
let _toastSeq = 0;

/** Show a Bootstrap Toast with the given message. */
export function showToast(message, variant = 'danger') {
  const container = document.getElementById('toast-container');
  const id = 'toast-' + (++_toastSeq);
  const html = `
    <div id="${id}" class="toast align-items-center text-bg-${variant} border-0" role="alert" aria-live="assertive" aria-atomic="true">
      <div class="d-flex">
        <div class="toast-body"></div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
    </div>`;
  container.insertAdjacentHTML('beforeend', html);
  const el = document.getElementById(id);
  el.querySelector('.toast-body').textContent = message;
  const toast = new bootstrap.Toast(el, { delay: 4000 });
  toast.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}
