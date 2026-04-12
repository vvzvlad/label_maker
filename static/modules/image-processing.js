// ── Image processing utilities ───────────────────────────────────

/**
 * Apply Otsu's binarization to a PNG data URL.
 * Returns a new data URL with pixels converted to pure black or white.
 * If the computed threshold is 0 (blank or all-black image), the original data URL is returned unchanged.
 */
export async function applyOtsuBinarization(dataUrl) {
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image for Otsu binarization'));
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const histogram = new Array(256).fill(0);
  const totalPixels = pixels.length / 4;

  // Build luminance histogram.
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
    histogram[luma] += 1;
  }

  // Otsu threshold calculation in O(256).
  let sumAll = 0;
  for (let i = 0; i < 256; i += 1) {
    sumAll += i * histogram[i];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxBetweenClassVariance = -1;
  let threshold = 0;
  // Flag to detect the degenerate case where all pixels share the same luminance
  // (e.g. a fully blank, fully white, or fully uniform-grey image). In that case
  // betweenClassVariance is 0 for every t, maxBetweenClassVariance stays at -1,
  // and threshold stays 0 — but there is nothing meaningful to binarize.
  let thresholdFound = false;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const meanDiff = meanBackground - meanForeground;
    const betweenClassVariance = weightBackground * weightForeground * meanDiff * meanDiff;

    if (betweenClassVariance > maxBetweenClassVariance) {
      maxBetweenClassVariance = betweenClassVariance;
      threshold = t;
      thresholdFound = true;
    }
  }

  // If no meaningful threshold was found (uniform image), return source unchanged.
  if (!thresholdFound || threshold === 0) {
    return dataUrl;
  }

  // Apply hard threshold to pure black/white.
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
    const value = luma <= threshold ? 0 : 255;
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Rotate an image data URL 90 degrees clockwise.
 * Returns a new data URL of the rotated image.
 */
export async function rotateImageData90cw(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Reject on load failure so callers are not left with a hanging promise.
    img.onerror = () => reject(new Error('Failed to load image for rotation'));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Swap width/height for 90-degree rotation
      canvas.width = img.height;
      canvas.height = img.width;
      const ctx = canvas.getContext('2d');
      // Rotate 90 degrees clockwise: translate to right edge, then rotate
      ctx.translate(img.height, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}
