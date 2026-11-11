export function monitoringBadgeClass({ status, priceStatus, url, validDrop }) {
  if (validDrop) return 'drop';
  if (status === 'OFF WATCH') return 'expired';
  if (status === 'PURCHASE DATE NEEDS CONFIRMATION' || priceStatus === 'PRICE UNAVAILABLE') {
    return 'unavailable';
  }
  if (status === 'ON WATCH' && url) return 'linked';
  return 'monitoring';
}
