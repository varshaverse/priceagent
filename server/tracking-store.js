import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

async function writeJsonFile(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error('Could not remove temporary tracking file:', cleanupError.message);
      }
    }
    throw error;
  }
}

export async function appendReceiptToHistory({ receiptsFile, receipt }) {
  const receipts = JSON.parse(await fs.readFile(receiptsFile, 'utf8'));
  const existingIndex = receipts.findIndex(item => item.id === receipt.id);
  if (existingIndex >= 0) {
    receipts[existingIndex] = receipt;
  } else {
    receipts.push(receipt);
  }
  await writeJsonFile(receiptsFile, receipts);
}

export async function deleteReceiptFromHistory({
  receiptsFile,
  uploadsDirectory,
  receiptId
}) {
  const receipts = JSON.parse(await fs.readFile(receiptsFile, 'utf8'));
  const receipt = receipts.find(item => item.id === receiptId);
  if (!receipt) return { deleted: false, uploadCleanupWarning: '' };

  await writeJsonFile(
    receiptsFile,
    receipts.filter(item => item.id !== receiptId)
  );

  let uploadCleanupWarning = '';
  if (receipt.storedFile) {
    try {
      await fs.unlink(path.join(uploadsDirectory, path.basename(receipt.storedFile)));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        uploadCleanupWarning = 'Receipt data was deleted, but its uploaded file could not be removed.';
        console.error(
          `Could not remove deleted receipt upload ${path.basename(receipt.storedFile)}:`,
          error.message
        );
      }
    }
  }

  return { deleted: true, uploadCleanupWarning };
}
