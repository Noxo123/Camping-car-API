import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readMemories, writeMemories } from './storage/memories.js';
import { sourceList } from './config/sources.js';
import { collectAll } from './collectors/index.js';
import { normalizeResults } from './normalizers/merge.js';

const app = express();
const port = Number(process.env.PORT || 3050);
const host = process.env.HOST || '0.0.0.0';
const intervalMinutes = Math.max(1, Number(process.env.COLLECT_INTERVAL_MINUTES || 360));

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

let collectionRunning = false;
let lastCollection = null;

function auth(req, res, next) {
  const key = process.env.API_KEY;
  if (!key) return next();
  const provided = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== key) return res.status(401).json({ error: 'Clé API invalide' });
  next();
}

async function runCollection(trigger = 'automatic') {
  if (collectionRunning) {
    return { ok: false, skipped: true, reason: 'Une collecte est déjà en cours', lastCollection };
  }

  collectionRunning = true;
  const startedAt = new Date().toISOString();

  try {
    const results = await collectAll();
    const memories = await readMemories();
    const parks = normalizeResults(results);

    memories.parks = parks;
    memories.metadata.sources = results.map((r) => ({
      id: r.sourceId,
      name: r.source,
      records: r.records?.length || 0,
      error: r.error || null,
      collectedAt: r.collectedAt || new Date().toISOString()
    }));

    await writeMemories(memories);

    lastCollection = {
      ok: true,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      total: parks.length,
      results: results.map((r) => ({
        source: r.source,
        records: r.records?.length || 0,
        error: r.error || null
      }))
    };

    console.log(`[COLLECT] ${trigger}: ${parks.length} aire(s) enregistrée(s).`);
    return lastCollection;
  } catch (error) {
    lastCollection = {
      ok: false,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error.message
    };
    console.error('[COLLECT] Échec:', error);
    return lastCollection;
  } finally {
    collectionRunning = false;
  }
}

app.get('/api/v1/health', (req, res) => res.json({
  ok: true,
  service: 'Camping-car-API',
  time: new Date().toISOString(),
  collector: {
    running: collectionRunning,
    intervalMinutes,
    lastCollection
  }
}));

app.get('/api/v1/sources', (req, res) => res.json({ sources: sourceList() }));

app.get('/api/v1/parks', auth, async (req, res) => {
  const d = await readMemories();
  res.json({ total: d.parks.length, parks: d.parks });
});

app.get('/api/v1/parks/:id', auth, async (req, res) => {
  const d = await readMemories();
  const p = d.parks.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Aire introuvable' });
  res.json(p);
});

app.get('/api/v1/search', auth, async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'q est requis' });
  const d = await readMemories();
  const parks = d.parks.filter((p) => JSON.stringify(p).toLowerCase().includes(q));
  res.json({ total: parks.length, parks });
});

app.get('/api/v1/nearby', auth, async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Number(req.query.radius || 25);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat et lon sont requis' });

  const d = await readMemories();
  const km = (a, b, c, e) => {
    if (![a, b, c, e].every(Number.isFinite)) return Infinity;
    const R = 6371;
    const x = (c - a) * Math.PI / 180;
    const y = (e - b) * Math.PI / 180;
    const h = Math.sin(x / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(y / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const parks = d.parks
    .map((p) => ({ ...p, distanceKm: km(lat, lon, Number(p.location?.latitude), Number(p.location?.longitude)) }))
    .filter((p) => p.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  res.json({ total: parks.length, radiusKm: radius, parks });
});

app.get('/api/v1/statistics', auth, async (req, res) => {
  const d = await readMemories();
  const bySource = {};
  for (const p of d.parks) {
    const s = p.source?.platform || 'unknown';
    bySource[s] = (bySource[s] || 0) + 1;
  }
  res.json({ total: d.parks.length, bySource, generatedAt: d.metadata.generatedAt, lastCollection });
});

app.get('/api/v1/admin/collect/status', auth, (req, res) => res.json({
  running: collectionRunning,
  automatic: true,
  intervalMinutes,
  nextApproximateCollection: lastCollection?.finishedAt
    ? new Date(new Date(lastCollection.finishedAt).getTime() + intervalMinutes * 60_000).toISOString()
    : 'au démarrage',
  lastCollection
}));

app.post('/api/v1/admin/collect', auth, async (req, res) => {
  const result = await runCollection('manual-api');
  res.status(result.ok || result.skipped ? 200 : 500).json(result);
});

app.use((err, req, res, next) => res.status(500).json({ error: 'Erreur interne' }));

app.listen(port, host, async () => {
  console.log(`Camping-car-API listening on ${host}:${port}`);
  console.log(`[COLLECT] Collecte automatique activée: toutes les ${intervalMinutes} minute(s).`);

  await runCollection('startup');
  setInterval(() => runCollection('automatic'), intervalMinutes * 60_000).unref();
});
