import * as cheerio from 'cheerio';

function textValue(value) {
  if (Array.isArray(value)) return textValue(value[0]);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    return String(value.name || value['@id'] || value.url || '');
  }
  return '';
}

function parsePrice(value) {
  const cleaned = String(value || '')
    .replace(/[^0-9.,]/g, '')
    .replace(/,(?=\d{3}\b)/g, '');
  const price = Number(cleaned);
  return cleaned && Number.isFinite(price) && price > 0 ? price : null;
}

export function extractRetailerProductPage(html, productUrl) {
  const parsedUrl = new URL(productUrl);
  const $ = cheerio.load(html);
  const entities = [];
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const types = (Array.isArray(value['@type']) ? value['@type'] : [value['@type']])
      .map(type => String(type || '').split(/[\/#]/).at(-1).toLowerCase());
    if (types.includes('product')) entities.push(value);
    Object.values(value).forEach(child => {
      if (child && typeof child === 'object') visit(child);
    });
  };

  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      visit(JSON.parse($(script).text()));
    } catch {
      continue;
    }
  }

  const offers = entities.flatMap(product => {
    const productOffers = Array.isArray(product.offers)
      ? product.offers
      : product.offers
        ? [product.offers]
        : [];
    return productOffers.filter(offer => {
      const availability = String(offer.availability || '').toLowerCase();
      return !availability.includes('outofstock') &&
        !availability.includes('discontinued');
    }).flatMap(offer => [offer.price, offer.lowPrice].map(value => ({
      value,
      currency: offer.priceCurrency || product.priceCurrency || '',
      source: 'schema.org Product/Offer'
    })));
  });
  const productScope = $('[itemtype*="Product"][itemscope]').first();
  const scopedPrice = productScope.find('[itemprop="price"]').first();
  const currency =
    $('meta[property="product:price:currency"]').attr('content') ||
    productScope.find('[itemprop="priceCurrency"]').first().attr('content') ||
    '';
  const candidates = [
    {
      value: $('meta[property="product:price:amount"]').attr('content'),
      currency,
      source: 'product-specific retailer metadata'
    },
    ...offers,
    {
      value: scopedPrice.attr('content') || scopedPrice.text(),
      currency,
      source: 'product-scoped microdata'
    }
  ];
  const verifiedPrice = candidates.find(candidate =>
    parsePrice(candidate.value) != null &&
    String(candidate.currency).toUpperCase() === 'USD'
  );
  const entity = entities.find(product =>
    product.name || product.brand || product.model || product.sku
  ) || {};
  const pageTitle = String(
    textValue(entity.name) ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    ''
  ).trim().slice(0, 300);
  const imageValue = textValue(entity.image) ||
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('[itemprop="image"]').first().attr('content') ||
    $('[itemprop="image"]').first().attr('src') ||
    '';
  let imageUrl = '';
  try {
    const parsedImage = new URL(imageValue, parsedUrl);
    if (['http:', 'https:'].includes(parsedImage.protocol)) {
      imageUrl = parsedImage.toString();
    }
  } catch {
    imageUrl = '';
  }

  return {
    url: parsedUrl.toString(),
    title: pageTitle,
    brand: textValue(entity.brand) ||
      $('meta[property="product:brand"]').attr('content') ||
      '',
    model: textValue(entity.model),
    sku: textValue(entity.sku || entity.mpn),
    description: String(
      textValue(entity.description) ||
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      ''
    ).slice(0, 500),
    imageUrl,
    price: verifiedPrice ? parsePrice(verifiedPrice.value) : null,
    currency: verifiedPrice ? 'USD' : '',
    verified: Boolean(verifiedPrice),
    priceSource: verifiedPrice?.source || null
  };
}
