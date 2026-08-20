function clean(value) {
  if (value === undefined) return null;
  if (typeof value === 'string') return value.trim();
  return value;
}

export function normalizeResults(results) {
  const parks = [];
  const seen = new Set();
  for (const result of results) {
    for (const raw of result.records || []) {
      const candidates = Array.isArray(raw) ? raw : (Array.isArray(raw?.parks) ? raw.parks : []);
      for (const item of candidates) {
        if (!item || typeof item !== 'object') continue;
        const id = clean(item.id ?? item.externalId ?? item.slug ?? item.name);
        if (!id) continue;
        const key = `${result.sourceId}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        parks.push({
          id: key,
          source: {platform:result.source, sourceId:result.sourceId, collectedAt:result.collectedAt},
          name: clean(item.name ?? item.title),
          type: clean(item.type),
          location: {latitude:item.latitude ?? item.lat ?? null, longitude:item.longitude ?? item.lng ?? item.lon ?? null, city:clean(item.city), postalCode:clean(item.postalCode), address:clean(item.address)},
          services: item.services ?? [],
          pricing: item.pricing ?? item.prices ?? [],
          rating: item.rating ?? null,
          availability: item.availability ?? null,
          description: clean(item.description),
          url: clean(item.url),
          raw: item,
          lastUpdated: result.collectedAt
        });
      }
    }
  }
  return parks;
}
