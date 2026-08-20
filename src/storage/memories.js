import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = path.resolve('data/memories.json');

export async function readMemories() {
  try { return JSON.parse(await fs.readFile(FILE,'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {metadata:{version:1,generatedAt:null,total:0,sources:[]},parks:[]}; throw e; }
}

export async function writeMemories(data) {
  data.metadata ??= {};
  data.metadata.version = 1;
  data.metadata.generatedAt = new Date().toISOString();
  data.metadata.total = data.parks?.length ?? 0;
  await fs.mkdir(path.dirname(FILE), {recursive:true});
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data,null,2), 'utf8');
  await fs.rename(tmp, FILE);
  return data;
}
