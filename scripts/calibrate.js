// Mede o erro da projeção e a probabilidade do modelo ao longo das apurações históricas.
//   node scripts/calibrate.js [lateDrift ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARAMS, winProbability } from '../shared/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARCOS = [5, 10, 25, 50, 60, 75, 90];
const drifts = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [PARAMS.lateDrift];

for (const year of [2022, 2018]) {
  const file = path.join(ROOT, 'data', 'history', `${year}.json`);
  if (!fs.existsSync(file)) continue;
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  const truth = (100 * h.final.br.left) / (h.final.br.left + h.final.br.right);
  const ufs = Object.keys(h.t1).filter((u) => u !== 'br');
  for (const lateDrift of drifts) {
    const cols = MARCOS.map((m) => {
      const e = h.timeline.find((q) => {
        let st = 0, ts = 0;
        for (const u of ufs) { st += q.uf[u]?.[0] ?? 0; ts += h.secoes[u]; }
        return (100 * st) / ts >= m;
      });
      const input = ufs.map((u) => {
        const [st, left, right] = e.uf[u] ?? [0, 0, 0];
        return { uf: u, st, ts: h.secoes[u], left, right, t1Left: h.t1[u].left, t1Right: h.t1[u].right, t1vv: h.t1[u].vv };
      });
      const r = winProbability(input, { ...PARAMS, lateDrift });
      return `${m}%: erro ${(100 * r.projShareLeft - truth).toFixed(2).padStart(5)} P(esq) ${(100 * r.pLeft).toFixed(0).padStart(3)}`;
    });
    console.log(`${year} drift=${lateDrift} final=${truth.toFixed(2)} | ${cols.join(' | ')}`);
  }
}
