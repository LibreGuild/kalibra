import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/*
 * Keeps an image under a file-size limit (e.g. 50 KB for a dataset of small test images).
 *
 * An image that already fits is kept exactly as it is. Otherwise it is re-encoded as JPEG, and
 * scaled down when even a low JPEG quality is too big:
 *   1. at the current size, try quality 30 (the floor); if that is still too big, shrink the image
 *      (by the square root of how far off it was, and at least ×0.85) and try again, down to 64 px;
 *   2. once quality 30 fits, binary-search the highest quality (≤ 95) that still fits.
 * Pure JavaScript (jpeg-js, pngjs), so it bundles into the single-file CLI.
 *
 * Sizes are in bytes; "KB" in the UI means 1000 bytes, so a "50 KB" file also shows as 50 KB or
 * less in Finder and Explorer.
 */

export const MIN_SIDE = 64;
const Q_FLOOR = 30;
const Q_CEIL = 95;
const MAX_STEPS = 40;

export interface FitResult {
  data: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  originalBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  /** False when the image already fitted and is returned untouched. */
  changed: boolean;
  /** JPEG quality used, when re-encoded. */
  quality?: number;
}

export class ImageSizeError extends Error {}

type Format = 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown';

export function detectFormat(data: Uint8Array): Format {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length > 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'webp';
  if (data.length > 6 && String.fromCharCode(...data.subarray(0, 4)) === 'GIF8') return 'gif';
  return 'unknown';
}

/** Width and height from the file header, without decoding the pixels (PNG and JPEG). */
export function imageDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  const fmt = detectFormat(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (fmt === 'png' && data.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (fmt === 'jpeg') {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = data[i + 1];
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}

interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

function decode(data: Uint8Array, fmt: Format): Pixels {
  if (fmt === 'png') {
    const png = PNG.sync.read(Buffer.from(data));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  }
  if (fmt === 'jpeg') {
    const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data };
  }
  const name = fmt === 'unknown' ? 'this image format' : fmt.toUpperCase();
  throw new ImageSizeError(`Can't shrink ${name} images to a file-size limit. Use a model that returns PNG or JPEG, or remove the limit.`);
}

/** Transparent pixels become white: JPEG has no transparency. */
function flattenOnWhite(px: Pixels): Pixels {
  const out = new Uint8Array(px.data.length);
  for (let i = 0; i < px.data.length; i += 4) {
    const a = px.data[i + 3] / 255;
    out[i] = px.data[i] * a + 255 * (1 - a);
    out[i + 1] = px.data[i + 1] * a + 255 * (1 - a);
    out[i + 2] = px.data[i + 2] * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return { ...px, data: out };
}

/** Area-average downscale (each output pixel averages the source pixels it covers). */
export function resize(px: Pixels, width: number, height: number): Pixels {
  if (width === px.width && height === px.height) return px;
  const out = new Uint8Array(width * height * 4);
  const rx = px.width / width;
  const ry = px.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * ry);
    const y1 = Math.max(y0 + 1, Math.min(px.height, Math.floor((y + 1) * ry)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * rx);
      const x1 = Math.max(x0 + 1, Math.min(px.width, Math.floor((x + 1) * rx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        let s = (sy * px.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, s += 4) {
          r += px.data[s];
          g += px.data[s + 1];
          b += px.data[s + 2];
          a += px.data[s + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width, height, data: out };
}

const encodeJpeg = (px: Pixels, quality: number) => {
  const out = jpeg.encode({ data: px.data, width: px.width, height: px.height }, quality).data;
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
};

const kb = (bytes: number) => `${Math.round(bytes / 100) / 10} KB`;

/**
 * Returns the image unchanged when it is at most `maxBytes`, otherwise a JPEG that fits.
 * Throws ImageSizeError when it cannot fit even at quality 30 and 64 px on the short side.
 */
export function fitImageToSize(data: Uint8Array, mime: string, maxBytes: number): FitResult {
  const dims = imageDimensions(data);
  const base = { originalBytes: data.length, originalWidth: dims?.width, originalHeight: dims?.height };
  if (data.length <= maxBytes) return { ...base, data, mime, width: dims?.width, height: dims?.height, changed: false };

  const original = flattenOnWhite(decode(data, detectFormat(data)));
  const minScale = Math.min(1, MIN_SIDE / Math.min(original.width, original.height));
  let scale = 1;
  let smallest = Infinity;
  for (let step = 0; step < MAX_STEPS; step++) {
    const w = Math.max(1, Math.round(original.width * scale));
    const h = Math.max(1, Math.round(original.height * scale));
    const px = resize(original, w, h);
    const floor = encodeJpeg(px, Q_FLOOR);
    smallest = Math.min(smallest, floor.length);
    if (floor.length <= maxBytes) {
      // Fits at the lowest quality: find the best quality that still fits.
      let best = { quality: Q_FLOOR, bytes: floor };
      let lo = Q_FLOOR + 1;
      let hi = Q_CEIL;
      while (lo <= hi) {
        const q = Math.floor((lo + hi) / 2);
        const enc = encodeJpeg(px, q);
        if (enc.length <= maxBytes) {
          best = { quality: q, bytes: enc };
          lo = q + 1;
        } else hi = q - 1;
      }
      return { ...base, data: best.bytes, mime: 'image/jpeg', width: w, height: h, changed: true, quality: best.quality };
    }
    if (scale <= minScale) break;
    // File size grows roughly with the pixel count, so shrink each side by the square root of the overshoot.
    const factor = Math.min(0.85, Math.sqrt(maxBytes / floor.length) * 0.97);
    scale = Math.max(minScale, scale * factor);
  }
  throw new ImageSizeError(`Could not get this image under ${kb(maxBytes)}: the smallest version (${MIN_SIDE} px on the short side, JPEG quality ${Q_FLOOR}) is ${kb(smallest)}. Raise the limit.`);
}
