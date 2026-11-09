import {
  isValidDateOnly,
  receiptDateFromEvidence,
  receiptDateState
} from './monitoring.js';
import { knownRetailerDomain } from './retailers.js';

export function receiptDateForMerchant(evidence, merchant) {
  return receiptDateFromEvidence(
    evidence,
    knownRetailerDomain(merchant) ? { dateOrder: 'MDY' } : undefined
  );
}

export function recoverReceiptDate(receipt, now = new Date()) {
  if (receipt.purchaseDate || receipt.purchaseDateConfirmedByUser === true) return receipt;
  const date = receiptDateForMerchant(receipt.purchaseDateEvidence, receipt.merchant);
  if (!isValidDateOnly(date)) return receipt;

  const dateState = receiptDateState(date, now);
  receipt.purchaseDate = date;
  Object.assign(receipt, dateState);
  for (const product of receipt.products || []) {
    if (product.purchaseDateConfirmedByUser === true ||
      isValidDateOnly(product.purchaseDate || product.date)) continue;
    product.date = date;
    product.purchaseDate = date;
    Object.assign(product, dateState);
    if (dateState.watch === 'yes' && product.originalUrlVerified !== true) {
      product.nextProductDiscoveryAt = null;
    }
  }
  return receipt;
}
