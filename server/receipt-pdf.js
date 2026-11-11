import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const standardFonts = path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts',
  path.sep
);
const MAX_PAGES = 3;
const MAX_DIMENSION = 2000;

export async function renderReceiptPdf(buffer) {
  const task = getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: standardFonts,
    isEvalSupported: false,
    stopAtErrors: true,
    maxImageSize: 40000000
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES) {
      throw new Error(`PDF receipts may contain at most ${MAX_PAGES} pages.`);
    }
    const images = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, MAX_DIMENSION / Math.max(base.width, base.height));
        if (!Number.isFinite(scale) || scale <= 0) {
          throw new Error(`PDF page ${number} has invalid dimensions.`);
        }
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          background: 'white'
        }).promise;
        images.push(canvas.toBuffer('image/png'));
      } finally {
        page.cleanup();
      }
    }
    return images;
  } finally {
    await task.destroy();
  }
}
