// Gera uma apuração fictícia em data/sim/ para testar o painel sem esperar o TSE:
//   node scripts/simulate.js && LIVE_DIR=data/sim PORT=3001 node server/index.js --no-collect
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UFS } from '../server/tse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'sim');
const t1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ref', 't1-2026.json'), 'utf8'));
const STEPS = Number(process.argv[2] ?? 80);
const STOP_AT = Number(process.argv[3] ?? 1); // fração do caminho em que a simulação para (ex.: 0.6)
fs.mkdirSync(OUT, { recursive: true });

// Nordeste e Norte apuram mais devagar; seções apuradas cedo pendem para a direita.
const speed = (uf) => (['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'].includes(uf) ? 0.75 : ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to', 'zz'].includes(uf) ? 0.85 : 1.15);
const share = (uf, f) => {
  const c = t1[uf].cands;
  return c['13'].votos / (c['13'].votos + c['22'].votos) + 0.012 - 0.03 * (1 - f);
};
const tot = (abr, f) => {
  const s = t1[abr];
  const vv = Math.round(s.votosValidos * f);
  const left = Math.round(vv * share(abr, f));
  return { s, st: Math.round(s.secoes * f), vv, left, right: vv - left };
};
const summary = (abr, st, ts, vv, left, right, hora, te) => ({
  abr, totalizacao: `25/10/2026 ${hora}`, idg: hora, secoes: ts, secoesTot: st, pctSecoes: ts ? Math.round((10000 * st) / ts) / 100 : 0,
  eleitorado: te, comparecimento: Math.round(vv * 1.05), votosValidos: vv, brancos: 0, nulos: 0,
  cands: {
    13: { n: '13', nome: 'LULA', partido: 'PT', votos: left, pct: vv ? Math.round((10000 * left) / vv) / 100 : 0, eleito: false, st: '' },
    22: { n: '22', nome: 'FLAVIO BOLSONARO', partido: 'PL', votos: right, pct: vv ? Math.round((10000 * right) / vv) / 100 : 0, eleito: false, st: '' },
  },
});

const lines = [];
let latest;
for (let k = 1; k <= Math.round(STEPS * STOP_AT); k++) {
  const g = k / STEPS;
  const min = 17 * 60 + Math.round(240 * g ** 1.6);
  const hora = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
  latest = {};
  const snap = { t: `2026-10-25T${hora}-03:00`, br: null, uf: {} };
  const br = { st: 0, ts: 0, vv: 0, left: 0, right: 0, te: 0 };
  for (const uf of UFS) {
    const f = Math.min(1, (g * speed(uf)) ** 0.8);
    const r = tot(uf, f);
    latest[uf] = summary(uf, r.st, r.s.secoes, r.vv, r.left, r.right, hora, r.s.eleitorado);
    snap.uf[uf] = { st: r.st, ts: r.s.secoes, vv: r.vv, te: r.s.eleitorado, votos: { 13: r.left, 22: r.right }, tot: latest[uf].totalizacao };
    br.st += r.st; br.ts += r.s.secoes; br.vv += r.vv; br.left += r.left; br.right += r.right; br.te += r.s.eleitorado;
  }
  latest.br = summary('br', br.st, br.ts, br.vv, br.left, br.right, hora, br.te);
  snap.br = { st: br.st, ts: br.ts, vv: br.vv, te: br.te, votos: { 13: br.left, 22: br.right }, tot: latest.br.totalizacao };
  lines.push(JSON.stringify(snap));
}
fs.writeFileSync(path.join(OUT, 'snapshots.jsonl'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(latest));
fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify({ ultimaConsulta: new Date().toISOString(), erro: null, intervaloMs: 30000, simulado: true }));
console.log(`simulação: ${lines.length} snapshots, ${latest.br.pctSecoes}% apurado`);
