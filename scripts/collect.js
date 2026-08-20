import 'dotenv/config';
import { collectAll } from '../src/collectors/index.js';
import { normalizeResults } from '../src/normalizers/merge.js';
import { readMemories, writeMemories } from '../src/storage/memories.js';

const results = await collectAll();
const memories = await readMemories();
const parks = normalizeResults(results);
memories.parks = parks;
memories.metadata.sources = results.map(r => ({id:r.sourceId,name:r.source,records:r.records?.length ?? 0,error:r.error ?? null,collectedAt:r.collectedAt}));
await writeMemories(memories);
console.log(`Collecte terminée: ${parks.length} aire(s).`);
