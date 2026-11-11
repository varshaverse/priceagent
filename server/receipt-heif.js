import heicDecode from 'heic-decode';
import path from 'node:path';
import sharp from 'sharp';

const MAX_IMAGE_PIXELS = 40000000;
export const HEIF_CONVERSION_ERROR =
  'This HEIC receipt could not be converted. Please upload a JPG or PNG version.';

export async function convertReceiptHeif(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = file.mimetype.toLowerCase().split(';', 1)[0].trim();
  if (!['.heic', '.heif'].includes(extension) &&
      !['image/heic', 'image/heif'].includes(mimeType)) {
    return file;
  }

  const images = await heicDecode.all({ buffer: file.buffer });
  try {
    const image = images[0];
    if (!image || image.width <= 0 || image.height <= 0 ||
        image.width * image.height > MAX_IMAGE_PIXELS) {
      throw new Error('HEIF image exceeds the supported dimensions.');
    }
    const decoded = await image.decode();
    const buffer = await sharp(Buffer.from(decoded.data), {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
      limitInputPixels: MAX_IMAGE_PIXELS
    }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    return { ...file, buffer, mimetype: 'image/jpeg', size: buffer.length };
  } finally {
    images.dispose();
  }
}
