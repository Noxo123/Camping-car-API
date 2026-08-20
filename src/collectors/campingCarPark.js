import axios from 'axios';

const BASE = 'https://www.campingcarpark.com';
const USER_AGENT = process.env.COLLECTOR_USER_AGENT || 'Camping-car-API/1.1 (+public-html-collector)';
const TIMEOUT = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 15000), 3000, 60000);
const DELAY = clamp(Number(process.env.SCRAPER_DELAY_MS || 1200), 250, 30000);
const MAX_PAGES = clamp(Number(process.env.SCRAPER_MAX_PAGES || 100), 1, 500);
const MAX_AREAS = clamp(Number(process.env.SCRAPER_MAX_AREAS || 2000), 1, 10000);
const MAX_RETRIES = clamp(Number(process.env.SCRAPER_MAX_RETRIES || 3), 0, 6);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = axios.create({
  timeout: TIMEOUT,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7'
  },
  maxRedirects: 5,
  validateStatus: s => s >= 200 && s < 400
});

export async function collectCampingCarPark() {
  const started = Date.now();
  const catalogUrls = await discoverCatalogUrls();
  const areaUrls = new Set();
  const errors = [];

  for (const catalogUrl of catalogUrls) {
    if (areaUrls.size >= MAX_AREAS) break;
    try {
      for (const url of await crawlCatalog(catalogUrl)) {
        areaUrls.add(canonicalizeUrl(url));
        if (areaUrls.size >= MAX_AREAS) break;
      }
    } catch (error) {
      errors.push({ stage: 'catalog', url: catalogUrl, error: error.message });
    }
  }

  const records = [];
  let failed = 0;

  for (const url of areaUrls) {
    try {
      const html = await getHtml(url);
      const record = parseAreaPage(html, url);
      if (record) records.push(record);
      else failed++;
    } catch (error) {
      failed++;
      if (errors.length < 50) errors.push({ stage: 'area', url, error: error.message });
    }
    await sleep(DELAY);
  }

  return {
    source: 'Camping-Car Park',
    sourceId: 'camping-car-park',
    method: 'public-html-scraping',
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    discoveredCatalogs: catalogUrls.length,
    discoveredUrls: areaUrls.size,
    failed,
    errors,
    records: deduplicateRecords(records)
  };
}

async function getHtml(url) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.get(url);
      return String(response.data || '');
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await sleep(Math.min(5000, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function discoverCatalogUrls() {
  const urls = new Set([`${BASE}/fr_FR/camping-car/frankreich`]);

  try {
    const html = await getHtml(`${BASE}/fr_FR`);
    for (const href of extractLinks(html)) {
      if (isCatalogUrl(href)) urls.add(href);
    }
  } catch {}

  return [...urls];
}

async function crawlCatalog(startUrl) {
  const found = new Set();
  const visited = new Set();
  let url = startUrl;

  for (let page = 1; page <= MAX_PAGES && url; page++) {
    const current = canonicalizeUrl(url);
    if (visited.has(current)) break;
    visited.add(current);

    const html = await getHtml(current);
    const links = extractLinks(html);

    for (const href of links) {
      if (isAreaUrl(href)) found.add(canonicalizeUrl(href));
    }

    const next = findNextPage(html, current, links);
    if (!next || visited.has(canonicalizeUrl(next))) break;
    url = next;
    await sleep(DELAY);
  }

  return [...found];
}

function isCatalogUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === BASE && /\/fr_FR\/camping-car\//i.test(u.pathname) && !isAreaUrl(u.href);
  } catch {
    return false;
  }
}

function isAreaUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (u.origin !== BASE || !path.includes('/fr_fr/')) return false;
    if (!path.includes('/camping-car/')) return false;
    if (/(?:recherche|search|carte|map|destination|frankreich|france)$/i.test(path)) return false;
    if (u.searchParams.has('page')) return false;
    return path.split('/').filter(Boolean).length >= 4;
  } catch {
    return false;
  }
}

function extractLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>/gi)) {
    try {
      const u = new URL(decodeHtml(m[1]), BASE);
      if (u.origin === BASE && /^https?:$/.test(u.protocol)) out.add(u.href);
    } catch {}
  }
  return [...out];
}

function findNextPage(html, currentUrl, links) {
  const relNext = html.match(/<link\b[^>]*rel=["'][^"']*next[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1];
  if (relNext) return new URL(decodeHtml(relNext), currentUrl).href;

  const explicit = links.find(href => /(?:page|suivant|next)/i.test(href));
  if (explicit) return explicit;

  try {
    const u = new URL(currentUrl);
    const page = Number(u.searchParams.get('page'));
    if (Number.isFinite(page)) {
      u.searchParams.set('page', String(page + 1));
      return u.href;
    }
    u.searchParams.set('page', '2');
    return u.href;
  } catch {
    return null;
  }
}

function parseAreaPage(html, url) {
  const jsonLdItems = extractJsonLdItems(html);
  const jsonLd = chooseStructuredPlace(jsonLdItems) || {};
  const flatText = htmlToText(html);
  const name = clean(first(jsonLd, ['name'])) || clean(meta(html, 'og:title')) || title(html);
  if (!name) return null;

  const address = jsonLd.address && typeof jsonLd.address === 'object' ? jsonLd.address : {};
  const geo = jsonLd.geo && typeof jsonLd.geo === 'object' ? jsonLd.geo : {};
  const id = String(jsonLd.identifier || jsonLd.sku || jsonLd.productID || slugFromUrl(url) || name);
  const price = findPrice(flatText);
  const rating = findNumber(flatText, /(?:note|rating|sur\s*5)[^\d]{0,30}(\d+(?:[,.]\d+)?)/i);
  const reviews = findInteger(flatText, /(?:avis|reviews?)[^\d]{0,30}(\d[\d\s.]*)/i);
  const available = findInteger(flatText, /(?:places?|emplacements?)\s+(?:disponibles?|libres?)[^\d]{0,20}(\d[\d\s.]*)/i);
  const total = findInteger(flatText, /(?:capacit[ée]|places?|emplacements?)\s*(?:totale?|total)?[^\d]{0,20}(\d[\d\s.]*)/i);

  return {
    id: `ccp:${id}`,
    source: {
      platform: 'Camping-Car Park',
      sourceId: 'camping-car-park',
      type: 'public-html-scraping',
      url,
      collectedAt: new Date().toISOString()
    },
    identity: {
      name,
      slug: slugFromUrl(url),
      externalId: id
    },
    location: {
      country: clean(address.addressCountry) || 'France',
      region: clean(address.addressRegion),
      department: null,
      city: clean(address.addressLocality),
      postalCode: clean(address.postalCode),
      address: clean(address.streetAddress),
      latitude: numberOrNull(geo.latitude),
      longitude: numberOrNull(geo.longitude)
    },
    type: clean(jsonLd.additionalType),
    status: detectStatus(flatText),
    capacity: {
      total,
      available,
      occupied: total != null && available != null ? Math.max(0, total - available) : null
    },
    pricing: price == null ? [] : [{
      amount: price,
      currency: 'EUR',
      period: '24h',
      source: 'Camping-Car Park'
    }],
    rating: { score: rating, reviews },
    services: extractServices(flatText),
    description: clean(jsonLd.description) || clean(meta(html, 'description')) || '',
    images: extractImages(html, jsonLd),
    url,
    raw: { jsonLd },
    scrapedAt: new Date().toISOString()
  };
}

function extractJsonLdItems(html) {
  const items = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(m[1].trim());
      if (Array.isArray(value)) items.push(...value);
      else if (value?.['@graph'] && Array.isArray(value['@graph'])) items.push(...value['@graph']);
      else items.push(value);
    } catch {}
  }
  return items;
}

function chooseStructuredPlace(items) {
  return items.find(x => /Place|LocalBusiness|Campground|TouristAttraction|Product/i.test(String(x?.['@type'] || ''))) || items.find(x => x?.name && (x?.address || x?.geo));
}

function extractImages(html, jsonLd) {
  const result = new Set();
  const images = Array.isArray(jsonLd?.image) ? jsonLd.image : [jsonLd?.image];
  for (const image of images) {
    if (typeof image === 'string') result.add(image);
    else if (image?.url) result.add(image.url);
  }
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi)) result.add(decodeHtml(m[1]));
  return [...result].filter(Boolean).slice(0, 30);
}

function extractServices(text) {
  const normalized = text.toLowerCase();
  const known = [
    'eau potable', 'vidange', 'électricité', 'wifi', 'toilettes', 'douche',
    'poubelles', 'aire de jeux', 'restaurant', 'laverie', 'pain', 'épicerie',
    'animaux', 'parking', 'borne de recharge'
  ];
  return known.filter(service => normalized.includes(service));
}

function detectStatus(text) {
  const normalized = text.toLowerCase();
  if (/\b(?:fermée?|closed|indisponible)\b/.test(normalized)) return 'closed';
  if (/\b(?:ouverte?|open|disponible)\b/.test(normalized)) return 'open';
  return null;
}

function findPrice(text) {
  const patterns = [
    /(?:à\s*partir\s*de|prix|tarif|24\s*h|24h)[^\d]{0,40}(\d+[,.]\d{1,2})\s*€/i,
    /(\d+[,.]\d{1,2})\s*€[^\n]{0,30}(?:24\s*h|24h)/i
  ];
  for (const pattern of patterns) {
    const value = findNumber(text, pattern);
    if (value != null) return value;
  }
  return null;
}

function htmlToText(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function meta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i');
  return re1.exec(html)?.[1] || re2.exec(html)?.[1] || null;
}

function title(html) {
  return clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}

function slugFromUrl(url) {
  return new URL(url).pathname.split('/').filter(Boolean).pop() || null;
}

function canonicalizeUrl(url) {
  const u = new URL(url, BASE);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
  }
  return u.href.replace(/\/$/, '');
}

function first(obj, keys) {
  for (const key of keys) if (obj?.[key]) return obj[key];
  return null;
}

function clean(value) {
  if (value == null) return null;
  const text = decodeHtml(String(value)).replace(/\s+/g, ' ').trim();
  return text || null;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function findNumber(text, re) {
  const match = re.exec(text);
  return match ? numberOrNull(match[1]) : null;
}

function findInteger(text, re) {
  const match = re.exec(text);
  if (!match) return null;
  const n = Number(String(match[1]).replace(/[\s.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function deduplicateRecords(records) {
  const map = new Map();
  for (const record of records) map.set(record.id || record.url, record);
  return [...map.values()];
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
