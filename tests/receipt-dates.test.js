import assert from 'node:assert/strict';
import test from 'node:test';
import {
  receiptDateForMerchant,
  recoverReceiptDate
} from '../server/receipt-dates.js';
import {
  checkMonitoredProduct,
  monitoringStatusFor,
  shouldAutomaticallyDiscoverProduct
} from '../server/monitoring.js';

const now = new Date('2026-11-08T12:00:00-08:00');

test('known US retailer receipts interpret printed numeric dates as month/day/year', () => {
  assert.equal(receiptDateForMerchant('11/06/2026', 'COSTCO WHOLESALE'), '2026-11-06');
  assert.equal(receiptDateForMerchant('UZ 11/06/2026 10:01', 'Costco'), '2026-11-06');
  assert.equal(receiptDateForMerchant('11/06/2026', 'Unknown merchant'), null);
  assert.equal(receiptDateForMerchant('11/22/2026', 'Unknown merchant'), '2026-11-22');
  assert.equal(receiptDateForMerchant('02/30/2026', 'Costco'), null);
});

test('existing receipt evidence repairs missing dates and propagates the watch state', () => {
  const receipt = {
    merchant: 'Costco',
    purchaseDate: null,
    purchaseDateEvidence: 'UZ 11/06/2026 10:01',
    status: 'PURCHASE DATE NEEDS CONFIRMATION',
    products: [{
      date: null,
      purchaseDate: null,
      purchaseDateNeedsConfirmation: true,
      discoveryStatus: 'queued',
      monitoringStatus: 'PURCHASE DATE NEEDS CONFIRMATION',
      nextProductDiscoveryAt: '2026-11-09T12:00:00-08:00'
    }]
  };
  recoverReceiptDate(receipt, now);
  assert.equal(receipt.purchaseDate, '2026-11-06');
  assert.equal(receipt.status, 'WATCH');
  assert.equal(receipt.watch, 'yes');
  assert.equal(receipt.products[0].purchaseDate, '2026-11-06');
  assert.equal(receipt.products[0].purchaseDateNeedsConfirmation, false);
  assert.equal(receipt.products[0].nextProductDiscoveryAt, '2026-11-09T12:00:00-08:00');
  assert.equal(shouldAutomaticallyDiscoverProduct(receipt.products[0], receipt.purchaseDate, now), false);
  assert.equal(monitoringStatusFor(receipt.products[0], now), 'ON WATCH');
  assert.equal(recoverReceiptDate(JSON.parse(JSON.stringify(receipt)), now).status, 'WATCH');
});

test('recovery does not overwrite existing or user-confirmed purchase dates', () => {
  for (const receipt of [
    { merchant: 'Costco', purchaseDate: '2026-11-05', purchaseDateEvidence: '11/06/2026' },
    { merchant: 'Costco', purchaseDate: null, purchaseDateConfirmedByUser: true, purchaseDateEvidence: '11/06/2026' }
  ]) {
    const before = structuredClone(receipt);
    recoverReceiptDate(receipt, now);
    assert.deepEqual(receipt, before);
  }
});

test('recovered expired and future dates retain their appropriate watch states', () => {
  for (const [evidence, status, watch] of [
    ['10/05/2026', 'WATCH EXPIRED', 'no'],
    ['11/09/2026', 'PURCHASE DATE NEEDS CONFIRMATION', 'no']
  ]) {
    const receipt = { merchant: 'Costco', purchaseDate: null, purchaseDateEvidence: evidence };
    recoverReceiptDate(receipt, now);
    assert.equal(receipt.status, status);
    assert.equal(receipt.watch, watch);
  }
});

test('automatic discovery requires an active watch and respects retry times', () => {
  for (const date of [null, '2026-11-06', '2026-11-09']) {
    assert.equal(shouldAutomaticallyDiscoverProduct({ url: '' }, date, now), date === '2026-11-06');
  }
  const previouslyAttempted = JSON.parse(JSON.stringify({
    url: '',
    lastProductDiscoveryAt: '2026-11-07T12:00:00.000Z',
    nextProductDiscoveryAt: '2026-11-08T12:00:00.000Z'
  }));
  assert.equal(shouldAutomaticallyDiscoverProduct(previouslyAttempted, '2026-11-06', now), true);
  assert.equal(shouldAutomaticallyDiscoverProduct({
    ...previouslyAttempted,
    nextProductDiscoveryAt: '2026-11-09T12:00:00-08:00'
  }, '2026-11-06', now), false);
  assert.equal(shouldAutomaticallyDiscoverProduct(previouslyAttempted, '2026-10-05', now), false);
  assert.equal(shouldAutomaticallyDiscoverProduct({
    url: 'https://www.costco.com/product/123',
    originalUrlVerified: true
  }, null, now), false);
});

test('discovering a URL never enables price monitoring without a valid date', async () => {
  let fetched = false;
  const product = {
    purchaseDate: null,
    purchasePrice: 10,
    url: 'https://www.costco.com/product/123',
    originalUrlVerified: true
  };
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs: 3600000,
    fetchVerifiedPrice: async () => { fetched = true; },
    sendNotification: async () => {}
  });
  assert.equal(result.status, 'PURCHASE DATE NEEDS CONFIRMATION');
  assert.equal(product.monitoringStatus, 'PURCHASE DATE NEEDS CONFIRMATION');
  assert.equal(product.originalUrlVerified, true);
  assert.equal(fetched, false);
});
