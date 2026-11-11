export function mostRecentlyUploadedReceipt(receipts) {
  let latest = null;
  let latestTime = -Infinity;
  for (const receipt of receipts) {
    const parsed = Date.parse(receipt.uploadedAt || '');
    const time = Number.isFinite(parsed) ? parsed : -Infinity;
    if (!latest || time >= latestTime) {
      latest = receipt;
      latestTime = time;
    }
  }
  return latest;
}

export function receiptWatchLabel(receipt) {
  if (receipt.extractionStatus === 'retry_pending') return 'RETRY PENDING';
  return receipt.status === 'WATCH EXPIRED' ? 'OFF WATCH' : receipt.status;
}
