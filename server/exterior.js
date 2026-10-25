// Coleta os boletins de urna das seções do exterior (zz), que o TSE publica seção a seção
// assim que cada urna é recebida — inclusive antes da divulgação oficial das 17h.
//   2º turno (pleito 3221): acompanhado ao vivo   -> LIVE_DIR/exterior-3221.json
//   1º turno (pleito 3220): baixado uma vez       -> REF_DIR/exterior-3220.json
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_DIR, REF_DIR } from './config.js';
import { writeAtomic } from './fsutil.js';
import { BASE, CICLO } from './tse.js';
import { readBu } from './bu.js';

export const PLEITO_T1 = '3220';
export const PLEITO_T2 = '3221';
export const EXTERIOR_FILES = {
  [PLEITO_T1]: path.join(REF_DIR, `exterior-${PLEITO_T1}.json`),
  [PLEITO_T2]: path.join(LIVE_DIR, `exterior-${PLEITO_T2}.json`),
};
const CONCURRENCY = 8;
const INTERVAL_MS = Number(process.env.EXTERIOR_POLL_MS ?? 60000);
const MAX_BU_BYTES = 256 * 1024; // um boletim tem ~1 KB

const pad = (p) => p.padStart(6, '0');
const urnaBase = (pleito) => `${BASE}/${CICLO}/arquivo-urna/${pleito}`;
const etags = new Map();

async function get(url, { etag = false } = {}) {
  const headers = { 'User-Agent': 'monitor-eleicoes/1.0' };
  if (etag && etags.has(url)) headers['If-None-Match'] = etags.get(url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  if (etag && res.headers.get('etag')) etags.set(url, res.headers.get('etag'));
  return res;
}

function load(pleito) {
  try {
    return JSON.parse(fs.readFileSync(EXTERIOR_FILES[pleito], 'utf8'));
  } catch {
    return { pleito, config: null, cidades: {}, secoesCidade: {}, secoesTotal: 0, secoes: {} };
  }
}

async function fetchSection(pleito, sec) {
  const dir = `${urnaBase(pleito)}/dados/zz/${sec.mu}/${sec.z}/${sec.s}`;
  const aux = await (await get(`${dir}/p${pad(pleito)}-zz-m${sec.mu}-z${sec.z}-s${sec.s}-aux.json`)).json();
  const h = [...(aux.hashes ?? [])].reverse().find((x) => x.arq?.some((a) => a.tp === 'bu'));
  if (!h || !/^[0-9a-f]+$/i.test(h.hash)) throw new Error('sem boletim');
  const nm = h.arq.find((a) => a.tp === 'bu').nm;
  if (!/^[\w.-]+$/.test(nm)) throw new Error('nome de arquivo inesperado');
  const buf = await (await get(`${dir}/${h.hash}/${nm}`)).arrayBuffer();
  if (buf.byteLength > MAX_BU_BYTES) throw new Error('boletim grande demais');
  return { hash: h.hash, recebido: `${h.dr} ${h.hr}`, v: readBu(buf) };
}

// Sincroniza um pleito: baixa só os boletins novos ou retransmitidos.
async function syncExterior(pleito) {
  const state = load(pleito);
  const res = await get(`${urnaBase(pleito)}/config/zz/zz-p${pad(pleito)}-cs.json`, { etag: true });
  // 304: a lista não mudou; só vale a pena continuar se ficaram seções pendentes de falhas anteriores.
  if (!res && !state.pendentes) return;
  const cs = res ? await res.json() : state.csCache;
  if (!cs) return;
  state.config = { dg: cs.dg, hg: cs.hg, idg: cs.idg };
  state.secoesCidade = {};
  const pend = [];
  let total = 0;
  for (const mu of cs.abr[0].mu) {
    state.cidades[mu.cd] = mu.nm;
    state.secoesCidade[mu.cd] = 0;
    for (const z of mu.zon) {
      for (const s of z.sec) {
        if (s.nsp) continue; // seção agregada: votos vêm no boletim da principal
        total++;
        state.secoesCidade[mu.cd]++;
        if (!s.da) continue;
        const key = `${mu.cd}-${z.cd}-${s.ns}`;
        const disp = `${s.da} ${s.ha}`;
        if (state.secoes[key]?.disp !== disp) pend.push({ key, mu: mu.cd, z: z.cd, s: s.ns, disp });
      }
    }
  }
  state.secoesTotal = total;
  let ok = 0, falhas = 0;
  const queue = [...pend];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const sec = queue.shift();
      try {
        state.secoes[sec.key] = { mu: sec.mu, z: sec.z, s: sec.s, disp: sec.disp, ...(await fetchSection(pleito, sec)) };
        ok++;
      } catch {
        falhas++;
      }
    }
  }));
  state.pendentes = falhas;
  state.csCache = falhas ? cs : undefined; // guarda a lista só enquanto houver seção para tentar de novo
  state.atualizado = new Date().toISOString();
  writeAtomic(EXTERIOR_FILES[pleito], JSON.stringify(state));
  if (ok) console.log(`[exterior ${pleito}] +${ok} boletins (${falhas} falhas) · ${Object.keys(state.secoes).length}/${total} seções · TSE ${cs.hg}`);
}

export function startExterior() {
  let lastT1 = 0;
  let rodando = false;
  const loop = async () => {
    if (!rodando) {
      rodando = true;
      try {
        // O 1º turno não muda mais; revisita a cada 10 min só para completar falhas.
        // Cada pleito tem seu próprio try: falha num não pode travar o outro.
        if (Date.now() - lastT1 > 600000) {
          lastT1 = Date.now();
          await syncExterior(PLEITO_T1).catch((e) => console.error(`[exterior ${PLEITO_T1}] erro: ${e.message}`));
        }
        await syncExterior(PLEITO_T2).catch((e) => console.error(`[exterior ${PLEITO_T2}] erro: ${e.message}`));
      } finally {
        rodando = false;
      }
    }
    setTimeout(loop, INTERVAL_MS);
  };
  loop();
}
