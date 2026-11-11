import assert from 'node:assert/strict';
import test from 'node:test';
import { monitoringBadgeClass } from '../src/monitor-view.js';

test('on-watch saved links use the same badge regardless of identity verification', () => {
  for (const originalUrlVerified of [true, false]) {
    assert.equal(monitoringBadgeClass({
      status: 'ON WATCH',
      url: 'https://www.costco.com/product',
      originalUrlVerified
    }), 'linked');
  }
  assert.equal(monitoringBadgeClass({ status: 'ON WATCH' }), 'monitoring');
});

test('drop, unavailable, and off-watch statuses remain distinct', () => {
  assert.equal(monitoringBadgeClass({ status: 'ON WATCH', url: 'https://www.costco.com/product', validDrop: true }), 'drop');
  assert.equal(monitoringBadgeClass({ status: 'ON WATCH', priceStatus: 'PRICE UNAVAILABLE' }), 'unavailable');
  assert.equal(monitoringBadgeClass({ status: 'PURCHASE DATE NEEDS CONFIRMATION' }), 'unavailable');
  assert.equal(monitoringBadgeClass({ status: 'OFF WATCH', priceStatus: 'PRICE UNAVAILABLE', url: 'https://www.costco.com/product' }), 'expired');
});
