// Known retailers are resolved from receipt text, not from a fixed default.
// Aliases include common OCR distortions; unknown merchants fall through to
// the dynamic public-search domain resolution in product-discovery.js.
export const KNOWN_RETAILERS = [
  {
    id: 'costco',
    name: 'Costco',
    domain: 'costco.com',
    aliases: ['costco', 'costco wholesale', 'costco warehouse'],
    searchUrl: query => `https://www.costco.com/s?keyword=${encodeURIComponent(query)}`
  },
  {
    id: 'walmart',
    name: 'Walmart',
    domain: 'walmart.com',
    aliases: ['walmart', 'wal mart', 'wal-mart', 'walmart supercenter'],
    searchUrl: query => `https://www.walmart.com/search?q=${encodeURIComponent(query)}`
  },
  {
    id: 'target',
    name: 'Target',
    domain: 'target.com',
    aliases: ['target', 'target stores'],
    searchUrl: query => `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`
  },
  {
    id: 'amazon',
    name: 'Amazon',
    domain: 'amazon.com',
    aliases: ['amazon', 'amazon com', 'amzn'],
    searchUrl: query => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`
  },
  {
    id: 'bestbuy',
    name: 'Best Buy',
    domain: 'bestbuy.com',
    aliases: ['best buy', 'bestbuy', 'best buy co'],
    searchUrl: query => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(query)}`
  },
  {
    id: 'homedepot',
    name: 'The Home Depot',
    domain: 'homedepot.com',
    aliases: ['home depot', 'the home depot', 'homedepot'],
    searchUrl: query => `https://www.homedepot.com/s/${encodeURIComponent(query)}`
  }
];

const OCR_CHARACTERS = { 0: 'o', 1: 'l', 5: 's', 8: 'b', $: 's', '@': 'a', '|': 'l', '!': 'i' };

function squash(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[0158$@|!]/g, character => OCR_CHARACTERS[character])
    .replace(/[^a-z]/g, '');
}

function words(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[0158$@|!]/g, character => OCR_CHARACTERS[character])
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function allowedDistance(key) {
  if (key.length < 5) return 0;
  return key.length <= 7 ? 1 : 2;
}

function matchesAlias(tokens, retailer) {
  const aliasKeys = retailer.aliases.map(squash);
  for (let start = 0; start < tokens.length; start++) {
    let joined = '';
    for (let end = start; end < Math.min(tokens.length, start + 3); end++) {
      joined += tokens[end];
      for (const aliasKey of aliasKeys) {
        if (joined === aliasKey) return 0;
        if (Math.abs(joined.length - aliasKey.length) <= 2 &&
          editDistance(joined, aliasKey) <= allowedDistance(aliasKey)) {
          return editDistance(joined, aliasKey);
        }
      }
    }
  }
  return null;
}

// Returns the best known retailer for any of the supplied texts (merchant
// name first, then other receipt header text or printed web addresses).
export function detectRetailer(...texts) {
  for (const text of texts.filter(value => typeof value === 'string' && value.trim())) {
    const tokens = words(text);
    let best = null;
    for (const retailer of KNOWN_RETAILERS) {
      const distance = matchesAlias(tokens, retailer);
      if (distance != null && (!best || distance < best.distance)) {
        best = { retailer, distance };
      }
    }
    if (best) return { ...best.retailer, distance: best.distance };
  }
  return null;
}

export function knownRetailerDomain(name) {
  return detectRetailer(name)?.domain || '';
}

export function retailerSearchUrl(retailerOrDomain, query) {
  const text = String(retailerOrDomain || '');
  const retailer = KNOWN_RETAILERS.find(item =>
    text.toLowerCase().includes(item.domain) || detectRetailer(text)?.id === item.id
  );
  return retailer ? retailer.searchUrl(query) : '';
}

// Normalizes a (possibly distorted) merchant into a display name and domain.
export function resolveReceiptRetailer(merchant, ...evidenceTexts) {
  const known = detectRetailer(merchant, ...evidenceTexts);
  const cleaned = String(merchant || '').trim();
  const unknown = !cleaned || /^unknown\b/i.test(cleaned);
  if (known) {
    return { merchant: known.name, domain: known.domain, known: true };
  }
  return {
    merchant: unknown ? 'Unknown merchant' : cleaned.slice(0, 100),
    domain: '',
    known: false
  };
}
