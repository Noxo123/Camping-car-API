import axios from 'axios';

const BASE = 'https://www.campingcarpark.com';
const USER_AGENT = process.env.COLLECTOR_USER_AGENT || 'Camping-car-API/1.0';
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const DELAY = Number(process.env.SCRAPER_DELAY_MS || 1200);
const MAX_PAGES = Number(process.env.SCRAPER_MAX_PAGES || 100);
const MAX_AREAS = Number(process.env.SCRAPER_MAX_AREAS || 2000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = axios.create({
  timeout: TIMEOUT,
  headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  maxRedirects: 5,
  validateStatus: s => s >= 200 && s < 400
});

export async function collectCampingCarPark() {
  const started = Date.now();
  const catalogUrls = await discoverCatalogUrls();
  const areaUrls = new Set();

  for (const catalogUrl of catalogUrls) {
    if (areaUrls.size >= MAX_AREAS) break;
    for (const url of await crawlCatalog(catalogUrl)) {
      areaUrls.add(url);
      if (areaUrls.size >= MAX_AREAS) break;
    }
  }

  const records = [];
  let failed = 0;
  for (const url of areaUrls) {
    try {
      const html = await getHtml(url);
      const record = parseAreaPage(html, url);
      if (record) records.push(record);
    } catch {
      failed++;
    }
    await sleep(DELAY);
  }

  return {
    source: 'Camping-Car Park',
    sourceId: 'camping-car-park',
    method: 'public-html-scraping',
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    discoveredUrls: areaUrls.size,
    failed,
    records
  };
}

async function getHtml(url) {
  const response = await client.get(url);
  return String(response.data || '');
}

async function discoverCatalogUrls() {
  const urls = new Set([`${BASE}/fr_FR/camping-car/frankreich`]);
  try {
    const html = await getHtml(`${BASE}/fr_FR`);
    for (const href of extractLinks(html)) {
      if (/\/fr_FR\/camping-car\//i.test(href)) urls.add(href);
    }
  } catch {}
  return [...urls];
}

async function crawlCatalog(startUrl) {
  const found = new Set();
  let url = startUrl;
  for (let page = 1; page <= MAX_PAGES && url; page++) {
    const html = await getHtml(url);
    for (const href of extractLinks(html)) {
      if (isAreaUrl(href)) found.add(href);
    }
    const next = extractLinks(html).find(h => /(?:page|suivant|next)/i.test(h) && /camping-car/i.test(h));
    if (!next || next === url) break;
    url = next;
    await sleep(DELAY);
  }
  return [...found];
}

function isAreaUrl(url) {
  return /camping-car/i.test(url) && /fr_FR/i.test(url) && !/(?:recherche|search|page=|\?)/i.test(url);
}

function extractLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    try {
      const u = new URL(m[1], BASE);
      if (u.origin === BASE) out.add(u.href);
    } catch {}
  }
  return [...out];
}

function parseAreaPage(html, url) {
  const jsonLd = extractJsonLd(html);
  const flatText = htmlToText(html);
  const name = first(jsonLd, ['name']) || meta(html, 'og:title') || title(html);
  if (!name) return null;

  const geo = jsonLd?.geo || jsonLd?.address?.geo || {};
  const address = jsonLd?.address || {};
  const id = String(jsonLd?.identifier || jsonLd?.sku || slugFromUrl(url) || name);
  const price = findNumber(flatText, /(?:à partir de|24\s*h|24h)[^\d]{0,30}(\d+[,.]\d{1,2})\s*€/i);
  const rating = findNumber(flatText, /(?:note|rating)[^\d]{0,20}(\d+[,.]\d?)/i);
  const reviews = findNumber(flatText, /(?:avis|reviews)[^\d]{0,20}(\d+)/i);
  const available = findNumber(flatText, /(?:places?\s+disponibles?|available)[^\d]{0,20}(\d+)/i);
  const total = findNumber(flatText, /(?:places?|emplacements?)[^\d]{0,20}(\d+)/i);

  return {
    id: `ccp:${id}`,
    source: {
      platform: 'Camping-Car Park',
      sourceId: 'camping-car-park',
      type: 'public-html-scraping',
      url,
      collectedAt: new Date().toISOString()
    },
    identity: { name, slug: slugFromUrl(url), externalId: id },
    location: {
      country: address.addressCountry || 'France',
      region: address.addressRegion || null,
      department: null,
      city: address.addressLocality || null,
      postalCode: address.postalCode || null,
      address: address.streetAddress || null,
      latitude: numberOrNull(geo.latitude),
      longitude: numberOrNull(geo.longitude)
    },
    type: jsonLd?.additionalType || null,
    status: /ferm[ée]|closed/i.test(flatText) ? 'closed' : /ouvert|open/i.test(flatText) ? 'open' : null,
    capacity: { total, available, occupied: total != null && available != null ? Math.max(0, total - available) : null },
    pricing: price == null ? [] : [{ amount: price, currency: 'EUR', period: '24h', source: 'Camping-Car Park' }],
    rating: { score: rating, reviews },
    services: extractServices(flatText),
    description: jsonLd?.description || meta(html, 'description') || '',
    images: extractImages(html, jsonLd),
    url,
    raw: { jsonLd },
    scrapedAt: new Date().toISOString()
  };
}

function extractJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(m[1]);
      const items = Array.isArray(value) ? value : [value, ...(value?.['@graph'] || [])];
      const place = items.find(x => /Place|LocalBusiness|Campground|TouristAttraction/i.test(String(x?.['@type'] || '')));
      if (place) return place;
    } catch {}
  }
  return {};
}

function extractImages(html, jsonLd) {
  const result = new Set();
  const images = Array.isArray(jsonLd?.image) ? jsonLd.image : [jsonLd?.image];
  for (const image of images) if (typeof image === 'string') result.add(image);
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi)) result.add(m[1]);
  return [...result].slice(0, 20);
}

function extractServices(text) {
  const known = ['eau potable', 'vidange', 'électricité', 'wifi', 'toilettes', 'douche', 'poubelles', 'aire de jeux', 'restaurant', 'laverie'];
  return known.filter(x => text.toLowerCase().includes(x));
}

function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name.replace('.', '\\.') }["'][^>]+content=["']([^"']*)["']`, 'i');
  return re.exec(html)?.[1] || null;
}
function title(html) { return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null; }
function slugFromUrl(url) { return new URL(url).pathname.split('/').filter(Boolean).pop() || null; }
function first(obj, keys) { for (const k of keys) if (obj?.[k]) return obj[k]; return null; }
function numberOrNull(v) { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function findNumber(text, re) { const m = re.exec(text); return m ? numberOrNull(m[1]) : null; }
