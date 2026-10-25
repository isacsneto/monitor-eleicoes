// Copia a série ao vivo coletada localmente para data/seed/, que vai junto no deploy:
// num volume novo, o servidor começa com esses dados em vez de do zero.
//   node scripts/seed.js   (depois: commit + deploy)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'data', 'seed');
fs.mkdirSync(SEED, { recursive: true });
for (const f of ['snapshots.jsonl', 'latest.json', 'exterior-3221.json']) {
  const from = path.join(ROOT, 'data', 'live', f);
  if (!fs.existsSync(from)) { console.log(`(sem ${f})`); continue; }
  fs.copyFileSync(from, path.join(SEED, f));
  console.log(`data/live/${f} -> data/seed/${f} (${(fs.statSync(from).size / 1024).toFixed(0)} KB)`);
}
