import axios from 'axios';

const headers = { 'User-Agent': process.env.COLLECTOR_USER_AGENT || 'Camping-car-API/1.0' };

export async function collectCampingCarPark() {
  const started = Date.now();
  const url = 'https://www.campingcarpark.com/fr_FR';
  const response = await axios.get(url, {headers, timeout:Number(process.env.REQUEST_TIMEOUT_MS || 15000)});
  const html = String(response.data || '');
  return {
    source: 'Camping-Car Park',
    sourceId: 'camping-car-park',
    collectedAt: new Date().toISOString(),
    durationMs: Date.now()-started,
    records: extractEmbeddedJson(html)
  };
}

function extractEmbeddedJson(html) {
  const records = [];
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try { records.push(JSON.parse(match[1])); } catch {}
  }
  return records;
}
