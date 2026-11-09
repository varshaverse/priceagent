import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectRetailer,
  knownRetailerDomain,
  resolveReceiptRetailer
} from '../server/retailers.js';

test('retailer detection handles known aliases and common OCR character substitutions', () => {
  assert.equal(detectRetailer('COSTCO WHOLESALE #1234').id, 'costco');
  assert.equal(detectRetailer('C0STC0 WH0LESALE').id, 'costco');
  assert.equal(detectRetailer('BEST BUY CO').id, 'bestbuy');
  assert.equal(detectRetailer('WALMART SUPERCENTER').id, 'walmart');
  assert.equal(knownRetailerDomain('The Home Depot'), 'homedepot.com');
});

test('receipt merchant evidence resolves the official retailer when the merchant line is unclear', () => {
  const retailer = resolveReceiptRetailer('Unknown merchant', 'TARGET STORE #1234');
  assert.equal(retailer.merchant, 'Target');
  assert.equal(retailer.domain, 'target.com');
  assert.equal(retailer.known, true);
});
