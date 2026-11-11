import assert from 'node:assert/strict';
import test from 'node:test';
import { mostRecentlyUploadedReceipt, receiptWatchLabel } from '../src/receipt-view.js';

test('dashboard selects the latest upload without removing earlier receipts', () => {
  const receipts = [
    { id: 'first', uploadedAt: '2026-11-01T10:00:00Z' },
    { id: 'second', uploadedAt: '2026-11-02T10:00:00Z' },
    { id: 'older', uploadedAt: '2026-10-31T10:00:00Z' }
  ];
  assert.equal(mostRecentlyUploadedReceipt(receipts).id, 'second');
  assert.equal(receipts.length, 3);
  assert.equal(mostRecentlyUploadedReceipt([]), null);
  assert.equal(mostRecentlyUploadedReceipt([{ id: 'a' }, { id: 'b' }]).id, 'b');
});

test('expired receipts are displayed as off watch without masking unknown dates', () => {
  assert.equal(receiptWatchLabel({ status: 'WATCH EXPIRED' }), 'OFF WATCH');
  assert.equal(receiptWatchLabel({ status: 'WATCH' }), 'WATCH');
  assert.equal(receiptWatchLabel({ status: 'PURCHASE DATE NEEDS CONFIRMATION' }), 'PURCHASE DATE NEEDS CONFIRMATION');
  assert.equal(receiptWatchLabel({ extractionStatus: 'retry_pending', status: 'WATCH' }), 'RETRY PENDING');
});
