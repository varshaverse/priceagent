import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendReceiptToHistory,
  deleteReceiptFromHistory
} from '../server/tracking-store.js';

test('new receipts append to history and increment the saved receipt count', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pricedrop-tracking-'));
  const receiptsFile = path.join(directory, 'receipts.json');
  const firstReceipt = {
    id: 'first-receipt',
    storedFile: 'first-receipt.jpg',
    products: [{ id: 'first-product' }]
  };
  const secondReceipt = {
    id: 'second-receipt',
    storedFile: 'second-receipt.jpg',
    products: [{ id: 'second-product' }]
  };

  try {
    await writeFile(receiptsFile, JSON.stringify([firstReceipt]));
    await appendReceiptToHistory({ receiptsFile, receipt: secondReceipt });

    const savedReceipts = JSON.parse(await readFile(receiptsFile, 'utf8'));
    assert.deepEqual(savedReceipts, [firstReceipt, secondReceipt]);
    assert.equal(savedReceipts.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retrying a receipt save does not duplicate that receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pricedrop-tracking-'));
  const receiptsFile = path.join(directory, 'receipts.json');
  const receipt = { id: 'same-receipt', products: [] };

  try {
    await writeFile(receiptsFile, JSON.stringify([receipt]));
    await appendReceiptToHistory({ receiptsFile, receipt });

    assert.deepEqual(JSON.parse(await readFile(receiptsFile, 'utf8')), [receipt]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deleting a receipt removes its monitoring record and uploaded file only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pricedrop-tracking-'));
  const uploadsDirectory = path.join(directory, 'uploads');
  const receiptsFile = path.join(directory, 'receipts.json');
  const deletedReceipt = {
    id: 'deleted-receipt',
    storedFile: 'deleted-receipt.jpg',
    products: [{ id: 'tracked-product' }]
  };
  const retainedReceipt = {
    id: 'retained-receipt',
    storedFile: 'retained-receipt.jpg',
    products: [{ id: 'retained-product' }]
  };

  try {
    await mkdir(uploadsDirectory);
    await writeFile(receiptsFile, JSON.stringify([deletedReceipt, retainedReceipt]));
    await writeFile(path.join(uploadsDirectory, deletedReceipt.storedFile), 'delete');
    await writeFile(path.join(uploadsDirectory, retainedReceipt.storedFile), 'keep');

    const result = await deleteReceiptFromHistory({
      receiptsFile,
      uploadsDirectory,
      receiptId: deletedReceipt.id
    });

    assert.deepEqual(result, { deleted: true, uploadCleanupWarning: '' });
    assert.deepEqual(JSON.parse(await readFile(receiptsFile, 'utf8')), [retainedReceipt]);
    await assert.rejects(readFile(path.join(uploadsDirectory, deletedReceipt.storedFile)));
    assert.equal(
      await readFile(path.join(uploadsDirectory, retainedReceipt.storedFile), 'utf8'),
      'keep'
    );
    assert.deepEqual(
      await deleteReceiptFromHistory({
        receiptsFile,
        uploadsDirectory,
        receiptId: 'missing-receipt'
      }),
      { deleted: false, uploadCleanupWarning: '' }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
