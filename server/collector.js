// Consulta o TSE periodicamente e grava cada mudança da apuração em LIVE_DIR/snapshots.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_DIR, REF_DIR } from './config.js';
import { writeAtomic } from './fsutil.js';
import { ELEICAO_T1, ELEICAO_T2, UFS, fetchResult, summarize } from './tse.js';
import { startExterior } from './exterior.js';
import { startNoticias } from './noticias.js';
import { startMercados } from './mercados.js';

const SNAPSHOTS = path.join(LIVE_DIR, 'snapshots.jsonl');
const INTERVAL_MS = Number(process.env.POLL_MS ?? 30000);
const ABRS = ['br', ...UFS];

const state = { lastError: null };

function compact(sum) {
  const votos = {};
  for (const [n, c] of Object.entries(sum.cands)) votos[n] = c.votos;
  return { st: sum.secoesTot, ts: sum.secoes, vv: sum.votosValidos, te: sum.eleitorado, comp: sum.comparecimento, votos, tot: sum.totalizacao };
}

// Resultado final do 1º turno por UF: base de comparação e prior do modelo.
async function ensureFirstRound() {
  const file = path.join(REF_DIR, 't1-2026.json');
  if (fs.existsSync(file)) return;
  const out = {};
  for (const abr of ABRS) out[abr] = summarize((await fetchResult(ELEICAO_T1, abr)).json);
  writeAtomic(file, JSON.stringify(out));
}

let lastKey = null;
if (fs.existsSync(SNAPSHOTS)) {
  const lines = fs.readFileSync(SNAPSHOTS, 'utf8').trim().split('\n').filter(Boolean);
  try { if (lines.length) lastKey = JSON.parse(lines.at(-1)).key; } catch { /* última linha truncada */ }
}

const ultimoBom = {}; // abrangência -> último resumo válido
let falhasSeguidas = {};

async function poll() {
  const results = await Promise.allSettled(ABRS.map((abr) => fetchResult(ELEICAO_T2, abr)));
  // Na noite da eleição o CDN do TSE às vezes falha um arquivo: reaproveita o último válido
  // daquela UF em vez de descartar a rodada inteira.
  const sums = {};
  const falhas = [];
  results.forEach((r, i) => {
    const abr = ABRS[i];
    if (r.status === 'fulfilled') {
      sums[abr] = ultimoBom[abr] = summarize(r.value.json);
      delete falhasSeguidas[abr];
    } else {
      falhas.push(abr);
      falhasSeguidas[abr] = (falhasSeguidas[abr] ?? 0) + 1;
      if (ultimoBom[abr]) sums[abr] = ultimoBom[abr];
    }
  });
  if (!sums.br || ABRS.some((a) => !sums[a])) throw new Error(`falha ao baixar ${falhas.join(', ')}`);
  state.lastError = falhas.some((a) => falhasSeguidas[a] >= 4) ? `TSE instável (${falhas.join(', ')})` : null;
  const key = ABRS.map((a) => sums[a].idg + ':' + sums[a].secoesTot).join(',');
  if (key === lastKey) return;
  lastKey = key;
  const t = new Date().toISOString();
  const snap = { t, key, br: compact(sums.br), uf: {} };
  for (const uf of UFS) snap.uf[uf] = compact(sums[uf]);
  fs.appendFileSync(SNAPSHOTS, JSON.stringify(snap) + '\n');
  writeAtomic(path.join(LIVE_DIR, 'latest.json'), JSON.stringify(sums));
  console.log(`[${t}] snapshot: ${sums.br.pctSecoes}% seções (TSE ${sums.br.totalizacao})`);
}

export async function startCollector() {
  startExterior();
  startNoticias();
  startMercados();
  const loop = async () => {
    try {
      // Tenta de novo a cada rodada até ter o 1º turno (base do modelo e das comparações).
      await ensureFirstRound().catch((e) => console.error('1º turno:', e.message));
      await poll();
    } catch (e) {
      state.lastError = e.message;
      console.error(`[${new Date().toISOString()}] erro: ${e.message}`);
    } finally {
      try {
        const status = { ultimaConsulta: new Date().toISOString(), erro: state.lastError, intervaloMs: INTERVAL_MS };
        writeAtomic(path.join(LIVE_DIR, 'status.json'), JSON.stringify(status));
      } catch (e) {
        console.error(`status.json: ${e.message}`);
      }
      setTimeout(loop, INTERVAL_MS);
    }
  };
  loop();
}

// Um erro inesperado não pode derrubar a coleta no meio da apuração.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startCollector();
