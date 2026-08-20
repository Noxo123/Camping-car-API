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
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

let collectionRunning = false;
let lastCollection = null;
let nextCollectionAt = null;
let lastManualCollectionAt = 0;
const startedAt = new Date().toISOString();
const requestStats = { total: 0, errors: 0, totalLatencyMs: 0, byRoute: new Map() };

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    requestStats.total++;
    requestStats.totalLatencyMs += latencyMs;
    if (res.statusCode >= 400) requestStats.errors++;
    const current = requestStats.byRoute.get(req.path) || { requests: 0, errors: 0, totalLatencyMs: 0, lastStatus: null, lastAt: null };
    current.requests++;
    current.totalLatencyMs += latencyMs;
    current.lastStatus = res.statusCode;
    current.lastAt = new Date().toISOString();
    if (res.statusCode >= 400) current.errors++;
    requestStats.byRoute.set(req.path, current);
  });
  next();
});

async function runCollection(trigger = 'automatic') {
  if (collectionRunning) return { ok: false, skipped: true, reason: 'Une collecte est déjà en cours', lastCollection };
  if (trigger === 'manual-api') {
    const elapsed = Date.now() - lastManualCollectionAt;
    const cooldownMs = manualCooldownSeconds * 1000;
    if (elapsed < cooldownMs) return { ok: false, skipped: true, reason: 'Cooldown de collecte manuelle actif', retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000), lastCollection };
    lastManualCollectionAt = Date.now();
  }
  collectionRunning = true;
  const started = Date.now();
  const collectionStartedAt = new Date().toISOString();
  try {
    const results = await collectAll();
    const memories = await readMemories();
    const parks = normalizeResults(results);
    memories.parks = parks;
    memories.metadata.sources = results.map((r) => ({ id: r.sourceId, name: r.source, method: r.method || 'unknown', records: r.records?.length || 0, discoveredUrls: r.discoveredUrls || 0, failed: r.failed || 0, error: r.error || null, collectedAt: r.collectedAt || new Date().toISOString() }));
    await writeMemories(memories);
    lastCollection = { ok: true, trigger, startedAt: collectionStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, total: parks.length, sources: memories.metadata.sources };
    nextCollectionAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
    console.log(`[COLLECT] ${trigger}: ${parks.length} aire(s) enregistrée(s).`);
    return lastCollection;
  } catch (error) {
    lastCollection = { ok: false, trigger, startedAt: collectionStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    nextCollectionAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
    console.error('[COLLECT] Échec:', error);
    return lastCollection;
  } finally { collectionRunning = false; }
}

function routeSnapshot() {
  return [...requestStats.byRoute.entries()].map(([route, s]) => ({ route, requests: s.requests, errors: s.errors, errorRate: s.requests ? Number((s.errors / s.requests * 100).toFixed(2)) : 0, avgLatencyMs: s.requests ? Number((s.totalLatencyMs / s.requests).toFixed(2)) : 0, lastStatus: s.lastStatus, lastAt: s.lastAt })).sort((a, b) => b.requests - a.requests);
}

async function dashboardData() {
  const memories = await readMemories();
  const sources = sourceList();
  const routeStats = routeSnapshot();
  const averageLatencyMs = requestStats.total ? Number((requestStats.totalLatencyMs / requestStats.total).toFixed(2)) : 0;
  const problems = [];
  if (lastCollection?.ok === false) problems.push({ level: 'error', title: 'Dernière collecte en échec', detail: lastCollection.error || 'Erreur inconnue' });
  if (lastCollection?.sources) for (const source of lastCollection.sources) {
    if (source.failed > 0) problems.push({ level: 'warning', title: `${source.name}: pages en échec`, detail: `${source.failed} page(s) n'ont pas pu être récupérées.` });
    if (source.records === 0 && !source.error) problems.push({ level: 'warning', title: `${source.name}: aucune donnée`, detail: 'Le collecteur n'a trouvé aucune aire exploitable.' });
    if (source.error) problems.push({ level: 'error', title: `${source.name}: erreur`, detail: source.error });
  }
  if (requestStats.errors > 0) problems.push({ level: 'warning', title: 'Erreurs HTTP', detail: `${requestStats.errors} réponse(s) HTTP en erreur sur ${requestStats.total} requête(s).` });
  return { service: 'Camping-car-API', version: memories.metadata?.version || 1, startedAt, uptimeSeconds: Math.floor(process.uptime()), time: new Date().toISOString(), memory: { rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)), heapUsedMb: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)) }, database: { file: 'data/memories.json', totalParks: memories.parks?.length || 0, generatedAt: memories.metadata?.generatedAt || null }, collector: { running: collectionRunning, automatic: true, intervalMinutes, manualCooldownSeconds, nextCollectionAt, lastCollection }, http: { requests: requestStats.total, errors: requestStats.errors, errorRate: requestStats.total ? Number((requestStats.errors / requestStats.total * 100).toFixed(2)) : 0, averageLatencyMs, routes: routeStats }, sources, problems };
}

app.get('/', async (req, res) => {
  res.type('html').send(renderDashboard(await dashboardData()));
});

app.get('/api/v1/dashboard', async (req, res) => res.json(await dashboardData()));
app.get('/api/v1/health', (req, res) => res.json({ ok: true, service: 'Camping-car-API', time: new Date().toISOString(), collector: { running: collectionRunning, automatic: true, intervalMinutes, lastCollection, nextCollectionAt } }));
app.get('/api/v1/sources', (req, res) => res.json({ sources: sourceList() }));
app.get('/api/v1/parks', async (req, res) => { const d = await readMemories(); res.json({ total: d.parks.length, parks: d.parks }); });
app.get('/api/v1/parks/:id', async (req, res) => { const d = await readMemories(); const p = d.parks.find((x) => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Aire introuvable' }); res.json(p); });
app.get('/api/v1/search', async (req, res) => { const q = String(req.query.q || '').toLowerCase().trim(); if (!q) return res.status(400).json({ error: 'q est requis' }); const d = await readMemories(); const parks = d.parks.filter((p) => JSON.stringify(p).toLowerCase().includes(q)); res.json({ total: parks.length, parks }); });
app.get('/api/v1/nearby', async (req, res) => { const lat = Number(req.query.lat), lon = Number(req.query.lon), radius = Math.min(500, Math.max(0.1, Number(req.query.radius || 25))); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat et lon sont requis' }); const distanceKm = (a,b,c,e) => { if (![a,b,c,e].every(Number.isFinite)) return Infinity; const R=6371,x=(c-a)*Math.PI/180,y=(e-b)*Math.PI/180,h=Math.sin(x/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(y/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }; const d=await readMemories(); const parks=d.parks.map(p=>({...p,distanceKm:distanceKm(lat,lon,Number(p.location?.latitude),Number(p.location?.longitude))})).filter(p=>p.distanceKm<=radius).sort((a,b)=>a.distanceKm-b.distanceKm); res.json({total:parks.length,radiusKm:radius,parks}); });
app.get('/api/v1/statistics', async (req, res) => { const d=await readMemories(); const bySource={}; for(const p of d.parks){const s=p.source?.platform||'unknown';bySource[s]=(bySource[s]||0)+1;} res.json({total:d.parks.length,bySource,generatedAt:d.metadata.generatedAt,lastCollection}); });
app.get('/api/v1/admin/collect/status', (req,res)=>res.json({ok:true,running:collectionRunning,automatic:true,intervalMinutes,manualCooldownSeconds,nextCollectionAt,lastCollection}));
app.post('/api/v1/admin/collect', async (req,res)=>{const result=await runCollection('manual-api');if(result.skipped&&result.retryAfterSeconds)res.set('Retry-After',String(result.retryAfterSeconds));res.status(result.ok||result.skipped?200:500).json(result);});
app.use((err, req, res, next) => { console.error('[HTTP]', err); res.status(500).json({ error: 'Erreur interne' }); });

function renderDashboard(d) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = d.problems.some(p=>p.level==='error') ? ['ERREURS','bad'] : d.problems.length ? ['AVERTISSEMENTS','warn'] : ['OPÉRATIONNEL','ok'];
  const sourceRows = d.sources.map(s => `<tr><td>${esc(s.name || s.id)}</td><td><span class="pill ok">ACTIF</span></td><td>${esc(s.method || '—')}</td><td>${esc(s.description || 'Source publique')}</td></tr>`).join('');
  const routeRows = d.http.routes.length ? d.http.routes.map(r => `<tr><td><code>${esc(r.route)}</code></td><td>${r.requests}</td><td>${r.avgLatencyMs} ms</td><td>${r.errors}</td><td>${r.errorRate}%</td><td>${r.lastStatus ?? '—'}</td></tr>`).join('') : `<tr><td colspan="6" class="muted">Aucune requête mesurée depuis le démarrage.</td></tr>`;
  const problems = d.problems.length ? d.problems.map(p => `<div class="problem ${esc(p.level)}"><b>${esc(p.title)}</b><span>${esc(p.detail)}</span></div>`).join('') : '<div class="problem ok"><b>Aucun problème détecté</b><span>API, collecteur et stockage ne signalent aucune anomalie.</span></div>';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camping-car-API · Dashboard</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf5;background:#070b12;--panel:#0d131d;--line:#1d2735;--muted:#8995a7;--accent:#62d8a4;--warn:#f3c969;--bad:#ff6b7a}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#10201c 0,transparent 32%),#070b12}.wrap{max-width:1400px;margin:auto;padding:32px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:26px}.brand{display:flex;gap:14px;align-items:center}.logo{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#62d8a4,#3d8cff);display:grid;place-items:center;color:#06100c;font-weight:900}.title{font-size:28px;font-weight:800}.sub{color:var(--muted);margin-top:4px}.badge{padding:9px 13px;border-radius:999px;font-weight:800;font-size:12px}.ok{color:#07130e;background:var(--accent)}.warn{color:#1c1606;background:var(--warn)}.bad{color:#1b070a;background:var(--bad)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}.card,.section{background:rgba(13,19,29,.92);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 40px #0004}.card{padding:20px}.label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.value{font-size:27px;font-weight:800;margin-top:8px}.small{font-size:12px;color:var(--muted);margin-top:5px}.section{padding:20px;margin-top:14px}.section h2{font-size:16px;margin:0 0 16px}.table{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:11px;text-transform:uppercase}code{color:#a9e8d0}.pill{padding:4px 8px;border-radius:999px;font-size:10px;font-weight:800}.problem{display:flex;gap:12px;padding:13px 15px;border-radius:11px;background:#111923;margin-bottom:8px;border-left:3px solid var(--warn)}.problem.error{border-color:var(--bad)}.problem.ok{border-color:var(--accent)}.problem span{color:var(--muted)}.links{display:flex;flex-wrap:wrap;gap:8px}.links a{color:#a9e8d0;text-decoration:none;border:1px solid var(--line);padding:9px 11px;border-radius:9px;background:#0a1018}.footer{color:var(--muted);font-size:12px;text-align:center;padding:25px} @media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.wrap{padding:16px}.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.title{font-size:23px}}</style></head><body><main class="wrap"><header class="top"><div class="brand"><div class="logo">CC</div><div><div class="title">Camping-car-API</div><div class="sub">Supervision · scraping · données · API REST</div></div></div><div class="badge ${status[1]}">${status[0]}</div></header>
  <section class="grid"><div class="card"><div class="label">Aires en mémoire</div><div class="value">${d.database.totalParks}</div><div class="small">memories.json</div></div><div class="card"><div class="label">Latence moyenne</div><div class="value">${d.http.averageLatencyMs} ms</div><div class="small">${d.http.requests} requête(s)</div></div><div class="card"><div class="label">Erreurs HTTP</div><div class="value">${d.http.errors}</div><div class="small">${d.http.errorRate}% du trafic</div></div><div class="card"><div class="label">Collecteur</div><div class="value">${d.collector.running?'EN COURS':'EN VEILLE'}</div><div class="small">Toutes les ${d.collector.intervalMinutes} min</div></div></section>
  <section class="section"><h2>Collecte & état du système</h2><div class="grid"><div><div class="label">Dernière collecte</div><div class="small">${esc(d.collector.lastCollection?.finishedAt || 'Aucune')}</div></div><div><div class="label">Prochaine collecte</div><div class="small">${esc(d.collector.nextCollectionAt || 'Calcul en cours')}</div></div><div><div class="label">Mémoire RSS</div><div class="small">${d.memory.rssMb} MB</div></div><div><div class="label">Uptime</div><div class="small">${d.uptimeSeconds}s</div></div></div></section>
  <section class="section"><h2>Sources de données</h2><div class="table"><table><thead><tr><th>Source</th><th>Statut</th><th>Méthode</th><th>Description</th></tr></thead><tbody>${sourceRows || '<tr><td colspan="4">Aucune source configurée.</td></tr>'}</tbody></table></div></section>
  <section class="section"><h2>APIs & latences</h2><div class="table"><table><thead><tr><th>Endpoint</th><th>Requêtes</th><th>Latence moy.</th><th>Erreurs</th><th>Taux erreur</th><th>HTTP</th></tr></thead><tbody>${routeRows}</tbody></table></div></section>
  <section class="section"><h2>Problèmes détectés</h2>${problems}</section>
  <section class="section"><h2>Endpoints</h2><div class="links"><a href="/api/v1/health">Health</a><a href="/api/v1/dashboard">Dashboard JSON</a><a href="/api/v1/sources">Sources</a><a href="/api/v1/parks">Aires</a><a href="/api/v1/statistics">Statistiques</a><a href="/api/v1/admin/collect/status">Collecteur</a></div></section>
  <div class="footer">Camping-car-API · données publiques · actualisé à chaque ouverture de la page</div></main><script>setTimeout(()=>location.reload(),30000)</script></body></html>`;
}

app.listen(port, host, async () => {
  console.log(`Camping-car-API listening on ${host}:${port}`);
  console.log(`[DASHBOARD] http://${host}:${port}/`);
  console.log(`[COLLECT] Scraping automatique: toutes les ${intervalMinutes} minute(s).`);
  await runCollection('startup');
  setInterval(() => runCollection('automatic'), intervalMinutes * 60_000).unref();
});
