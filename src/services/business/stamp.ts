import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

/**
 * Stamp & signature image for the invoice signatory box.
 *
 * A photographed stamp sits on paper (grey-white, often unevenly lit). makeTransparent() keeps the
 * ink exactly as photographed and only makes the paper transparent: each pixel's alpha comes from
 * how far its colour is from the local paper colour (estimated from a heavily smoothed copy, so
 * shadows and gradients are handled). The ink colour of soft edge pixels is recovered from the
 * paper blend so no grey halo remains. Nothing is redrawn and no wording is touched; empty
 * margins are trimmed. The original upload is always kept alongside.
 */
export const UPLOAD_DIR = path.join(__dirname, "../../../public/uploads/logos");
const MAX_WIDTH = 2000;

export async function describeImage(file: string) {
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || !["png", "jpeg", "webp"].includes(meta.format ?? "")) {
    throw new Error("Upload a PNG, JPEG or WEBP image of the stamp and signature.");
  }
  return { width: meta.width, height: meta.height, format: meta.format!, hasAlpha: !!meta.hasAlpha };
}

/** Writes a transparent-background PNG next to the upload and returns its public path. */
export async function makeTransparent(sourceFile: string): Promise<{ publicPath: string; width: number; height: number }> {
  const base = sharp(sourceFile).rotate(); // apply camera orientation
  const { data, info } = await base
    .clone()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Local paper colour: at 1/8 size, take the brightest pixel in each 9×9 neighbourhood (a max
  // filter: the paper, never the ink strokes), smooth it and scale it back up
  const smallW = Math.max(16, Math.round(width / 8));
  const reduced = await sharp(data, { raw: { width, height, channels: 3 } })
    .resize({ width: smallW, kernel: "cubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const paper = brightestNearby(reduced.data, reduced.info.width, reduced.info.height, 4);
  const { data: bg } = await sharp(paper, { raw: { width: reduced.info.width, height: reduced.info.height, channels: 3 } })
    .blur(2)
    .resize(width, height, { kernel: "cubic", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.alloc(width * height * 4);
  const T0 = 28; // score below which a pixel is paper
  const T1 = 95; // score above which a pixel is solid ink
  const TEXTURE = 18; // grey darkening ignored as paper grain, creases and shading
  const rows = new Uint32Array(height), cols = new Uint32Array(width);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const br = bg[p], bgc = bg[p + 1], bb = bg[p + 2];
    // Ink differs from the paper by colour (blue/violet/red stamp ink) or by being clearly darker
    // (black pen); grey grain and creases differ only slightly in brightness
    const darker = (br + bgc + bb - r - g - b) / 3;
    const dCb = b - (r + g) / 2 - (bb - (br + bgc) / 2);
    const dCr = r - g - (br - bgc);
    const chroma = Math.sqrt(dCb * dCb + dCr * dCr);
    const score = darker <= 0 ? 0 : Math.max(chroma * 1.4 * Math.min(1, darker / 12), darker - TEXTURE);
    let a = (score - T0) / (T1 - T0);
    a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
    const o = i * 4;
    if (a > 0) {
      // Un-blend the paper from soft edges: observed = paper·(1−a) + ink·a
      out[o] = Math.max(0, Math.min(255, Math.round((r - br * (1 - a)) / a)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round((g - bgc * (1 - a)) / a)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round((b - bb * (1 - a)) / a)));
      out[o + 3] = Math.round(a * 255);
      if (a > 0.5) {
        rows[(i / width) | 0]++;
        cols[i % width]++;
      }
    }
  }
  // Edges of the stamp: rows/columns with a few solid ink pixels (lone specks are ignored)
  const MIN = 3;
  const first = (arr: Uint32Array) => arr.findIndex((n) => n >= MIN);
  const last = (arr: Uint32Array) => arr.length - 1 - Array.from(arr).reverse().findIndex((n) => n >= MIN);
  const minY = first(rows), minX = first(cols);
  if (minX < 0 || minY < 0) throw new Error("No stamp or signature was found in the image. Try a clearer photo on plain paper.");
  const maxY = last(rows), maxX = last(cols);

  // Keep a small margin around the ink so nothing touches the edge
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03) + 4;
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
  const cropW = Math.min(width - left, maxX - minX + 1 + 2 * pad), cropH = Math.min(height - top, maxY - minY + 1 + 2 * pad);

  const name = `${crypto.randomUUID()}-transparent.png`;
  await sharp(out, { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: cropW, height: cropH })
    .png({ compressionLevel: 9 })
    .toFile(path.join(UPLOAD_DIR, name));
  return { publicPath: `/uploads/logos/${name}`, width: cropW, height: cropH };
}

/** For each pixel, the colour of the brightest pixel within `radius` (RGB, row-major). */
function brightestNearby(src: Buffer, w: number, h: number, radius: number): Buffer {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = src[i * 3] * 0.3 + src[i * 3 + 1] * 0.59 + src[i * 3 + 2] * 0.11;
  // Separable: best along rows, then along columns (by luminance)
  const rowBest = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = y * w + x;
      for (let k = Math.max(0, x - radius); k <= Math.min(w - 1, x + radius); k++) if (lum[y * w + k] > lum[best]) best = y * w + k;
      rowBest[y * w + x] = best;
    }
  }
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = rowBest[y * w + x];
      for (let k = Math.max(0, y - radius); k <= Math.min(h - 1, y + radius); k++) {
        const c = rowBest[k * w + x];
        if (lum[c] > lum[best]) best = c;
      }
      out[(y * w + x) * 3] = src[best * 3];
      out[(y * w + x) * 3 + 1] = src[best * 3 + 1];
      out[(y * w + x) * 3 + 2] = src[best * 3 + 2];
    }
  }
  return out;
}

export function clampWidthMm(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(80, Math.max(25, n)) : 50;
}
