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
const manualCooldownSeconds = Math.max(0, Number(process.env.MANUAL_COLLECT_COOLDOWN_SECONDS || 60));

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

let collectionRunning = false;
let lastCollection = null;
let nextCollectionAt = null;
let lastManualCollectionAt = 0;

async function runCollection(trigger = 'automatic') {
  if (collectionRunning) {
    return { ok: false, skipped: true, reason: 'Une collecte est déjà en cours', lastCollection };
  }

  if (trigger === 'manual-api') {
    const elapsed = Date.now() - lastManualCollectionAt;
    const cooldownMs = manualCooldownSeconds * 1000;
    if (elapsed < cooldownMs) {
      return {
        ok: false,
        skipped: true,
        reason: 'Cooldown de collecte manuelle actif',
        retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000),
        lastCollection
      };
    }
    lastManualCollectionAt = Date.now();
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
      method: r.method || 'unknown',
      records: r.records?.length || 0,
      discoveredUrls: r.discoveredUrls || 0,
      failed: r.failed || 0,
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
      sources: memories.metadata.sources
    };
    nextCollectionAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();

    console.log(`[COLLECT] ${trigger}: ${parks.length} aire(s) enregistrée(s).`);
    return lastCollection;
  } catch (error) {
    lastCollection = {
      ok: false,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
    nextCollectionAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
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
    automatic: true,
    intervalMinutes,
    lastCollection,
    nextCollectionAt
  }
}));

app.get('/api/v1/sources', (req, res) => res.json({ sources: sourceList() }));

app.get('/api/v1/parks', async (req, res) => {
  const d = await readMemories();
  res.json({ total: d.parks.length, parks: d.parks });
});

app.get('/api/v1/parks/:id', async (req, res) => {
  const d = await readMemories();
  const p = d.parks.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Aire introuvable' });
  res.json(p);
});

app.get('/api/v1/search', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'q est requis' });
  const d = await readMemories();
  const parks = d.parks.filter((p) => JSON.stringify(p).toLowerCase().includes(q));
  res.json({ total: parks.length, parks });
});

app.get('/api/v1/nearby', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(500, Math.max(0.1, Number(req.query.radius || 25)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat et lon sont requis' });

  const distanceKm = (a, b, c, e) => {
    if (![a, b, c, e].every(Number.isFinite)) return Infinity;
    const R = 6371;
    const x = (c - a) * Math.PI / 180;
    const y = (e - b) * Math.PI / 180;
    const h = Math.sin(x / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(y / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const d = await readMemories();
  const parks = d.parks
    .map((p) => ({ ...p, distanceKm: distanceKm(lat, lon, Number(p.location?.latitude), Number(p.location?.longitude)) }))
    .filter((p) => p.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  res.json({ total: parks.length, radiusKm: radius, parks });
});

app.get('/api/v1/statistics', async (req, res) => {
  const d = await readMemories();
  const bySource = {};
  for (const p of d.parks) {
    const s = p.source?.platform || 'unknown';
    bySource[s] = (bySource[s] || 0) + 1;
  }
  res.json({ total: d.parks.length, bySource, generatedAt: d.metadata.generatedAt, lastCollection });
});

// Routes publiques : aucune API key n'est nécessaire.
app.get('/api/v1/admin/collect/status', (req, res) => res.json({
  ok: true,
  running: collectionRunning,
  automatic: true,
  intervalMinutes,
  manualCooldownSeconds,
  nextCollectionAt,
  lastCollection
}));

app.post('/api/v1/admin/collect', async (req, res) => {
  const result = await runCollection('manual-api');
  if (result.skipped && result.retryAfterSeconds) res.set('Retry-After', String(result.retryAfterSeconds));
  res.status(result.ok || result.skipped ? 200 : 500).json(result);
});

app.use((err, req, res, next) => {
  console.error('[HTTP]', err);
  res.status(500).json({ error: 'Erreur interne' });
});

app.listen(port, host, async () => {
  console.log(`Camping-car-API listening on ${host}:${port}`);
  console.log(`[COLLECT] Scraping automatique: toutes les ${intervalMinutes} minute(s).`);
  console.log(`[COLLECT] API publique: POST /api/v1/admin/collect`);
  console.log(`[COLLECT] Statut: GET /api/v1/admin/collect/status`);

  await runCollection('startup');
  setInterval(() => runCollection('automatic'), intervalMinutes * 60_000).unref();
});
