// Acesso aos JSON públicos de divulgação do TSE (resultados.tse.jus.br).
export const BASE = 'https://resultados.tse.jus.br/oficial';
export const CICLO = 'ele2026';
export const ELEICAO_T1 = '6257';
export const ELEICAO_T2 = '6258';
export const CARGO_PRESIDENTE = '0001';

export const UFS = [
  'ac', 'al', 'am', 'ap', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mg', 'ms', 'mt', 'pa',
  'pb', 'pe', 'pi', 'pr', 'rj', 'rn', 'ro', 'rr', 'rs', 'sc', 'se', 'sp', 'to', 'zz',
];

export function resultUrl(eleicao, abr) {
  return `${BASE}/${CICLO}/${eleicao}/dados/${abr}/${abr}-c${CARGO_PRESIDENTE}-e${eleicao.padStart(6, '0')}-u.json`;
}

// O TSE envia números como string, com vírgula decimal ("47,03").
export function num(s) {
  if (s === undefined || s === null || s === '') return 0;
  return Number(String(s).replace(',', '.'));
}

const etags = new Map();
const cache = new Map();

// GET com If-None-Match; devolve { json, changed }.
export async function fetchResult(eleicao, abr) {
  const url = resultUrl(eleicao, abr);
  const headers = { 'User-Agent': 'monitor-eleicoes/1.0' };
  if (etags.has(url)) headers['If-None-Match'] = etags.get(url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (res.status === 304) return { json: cache.get(url), changed: false };
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const json = await res.json();
  const etag = res.headers.get('etag');
  if (etag) etags.set(url, etag);
  cache.set(url, json);
  return { json, changed: true };
}

// Converte o arquivo -u.json num resumo compacto.
export function summarize(json) {
  const cands = {};
  for (const agr of json.carg[0].agr) {
    for (const par of agr.par) {
      for (const c of par.cand) {
        cands[c.n] = { n: c.n, nome: c.nmu, partido: par.sg, votos: num(c.vap), pct: num(c.pvap), eleito: c.e === 's', st: c.st };
      }
    }
  }
  return {
    abr: json.cdabr,
    totalizacao: json.dg && json.hg ? `${json.dg} ${json.hg}` : null,
    idg: json.idg,
    // "e" = resultado matematicamente definido (eleito), antes mesmo de o TSE marcar o candidato.
    md: json.md ?? null,
    secoes: num(json.s.ts),
    secoesTot: num(json.s.st),
    pctSecoes: num(json.s.pstn ?? json.s.pst),
    eleitorado: num(json.e.te),
    comparecimento: num(json.e.c),
    eleitoradoApurado: num(json.e.est), // eleitorado das seções já totalizadas
    abstencao: num(json.e.a),
    votosValidos: num(json.v.vv),
    brancos: num(json.v.vb),
    nulos: num(json.v.tvn),
    cands,
  };
}
