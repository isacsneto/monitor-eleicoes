// Cálculos servidos pela API: situação ao vivo, linha do tempo, regiões, exterior e caminho para a vitória.
// Tudo é derivado de arquivos (relidos só quando mudam) e pode ser chamado a cada requisição.
import fs from 'node:fs';
import path from 'node:path';
import { winProbability } from '../shared/model.js';
import { REGIOES_PESQ, mediaPesquisas, cenarios } from '../shared/caminho.js';
import { HISTORY_DIR, LIVE_DIR, POLLS_FILE, REF_DIR } from './config.js';
import { UFS } from './tse.js';
import { EXTERIOR_FILES, PLEITO_T1, PLEITO_T2 } from './exterior.js';

const LIVE = LIVE_DIR;
const HISTORY = HISTORY_DIR;
const T1_FILE = path.join(REF_DIR, 't1-2026.json');
export const ANOS_HISTORICOS = [2022, 2018];

const LEFT_2026 = '13';
const RIGHT_2026 = '22';

export const REGIOES = {
  N: { nome: 'Norte', ufs: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'] },
  NE: { nome: 'Nordeste', ufs: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'] },
  CO: { nome: 'Centro-Oeste', ufs: ['df', 'go', 'ms', 'mt'] },
  SE: { nome: 'Sudeste', ufs: ['es', 'mg', 'rj', 'sp'] },
  S: { nome: 'Sul', ufs: ['pr', 'rs', 'sc'] },
  EX: { nome: 'Exterior', ufs: ['zz'] },
};

// Relê um arquivo apenas quando o mtime/tamanho muda. Se a leitura falhar (arquivo sendo
// trocado, JSON corrompido), mantém a última versão boa em vez de derrubar a API.
const fileCache = new Map();
function readCached(file, parse) {
  let stat;
  try { stat = fs.statSync(file); } catch { return fileCache.get(file)?.value ?? null; }
  const hit = fileCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.value;
  try {
    const value = parse(fs.readFileSync(file, 'utf8'));
    fileCache.set(file, { mtime: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch (e) {
    console.error(`leitura de ${path.basename(file)}: ${e.message}`);
    return hit?.value ?? null;
  }
}
const readJson = (file) => readCached(file, JSON.parse);
// Uma linha corrompida (processo morto no meio de uma gravação) é ignorada.
const readSnapshots = () => readCached(path.join(LIVE, 'snapshots.jsonl'), (txt) =>
  txt.split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }));

// Memoriza o último resultado enquanto os objetos de entrada (vindos do cache de arquivos) forem os mesmos.
function memo(fn) {
  let args = null, value;
  return (...a) => {
    if (args && a.length === args.length && a.every((x, i) => x === args[i])) return value;
    args = a;
    value = fn(...a);
    return value;
  };
}

function t1Prior2026() {
  const t1 = readJson(T1_FILE);
  if (!t1) return null;
  const out = {};
  for (const abr of ['br', ...UFS]) {
    const s = t1[abr];
    out[abr] = { left: s.cands[LEFT_2026].votos, right: s.cands[RIGHT_2026].votos, vv: s.votosValidos };
  }
  return out;
}

function modelInput(ufCounts, t1, secoes) {
  return UFS.filter((uf) => t1[uf]).map((uf) => {
    const c = ufCounts[uf] ?? { st: 0, left: 0, right: 0 };
    return { uf, st: c.st, ts: secoes[uf], left: c.left, right: c.right, t1Left: t1[uf].left, t1Right: t1[uf].right, t1vv: t1[uf].vv };
  });
}

function point(t, ufCounts, t1, secoes) {
  let st = 0, ts = 0, left = 0, right = 0;
  for (const uf of UFS) {
    const c = ufCounts[uf];
    ts += secoes[uf] ?? 0;
    if (!c) continue;
    st += c.st; left += c.left; right += c.right;
  }
  const m = winProbability(modelInput(ufCounts, t1, secoes));
  return {
    t,
    x: ts ? (100 * st) / ts : 0,
    shareLeft: left + right ? (100 * left) / (left + right) : null,
    pLeft: 100 * m.pLeft,
    projShareLeft: 100 * m.projShareLeft,
  };
}

export function liveSeries() {
  return liveSeriesFrom(t1Prior2026(), readSnapshots() ?? [], readJson(path.join(LIVE, 'latest.json')));
}

const liveSeriesFrom = memo((t1, snaps, latest) => {
  if (!t1 || !latest) return null;
  const points = [];
  for (const s of snaps) {
    const counts = {}, secoes = {};
    for (const uf of UFS) {
      const u = s.uf[uf];
      if (!u) continue;
      counts[uf] = { st: u.st, left: u.votos[LEFT_2026] ?? 0, right: u.votos[RIGHT_2026] ?? 0 };
      secoes[uf] = u.ts || latest[uf].secoes; // total de seções daquele momento
    }
    points.push(point(tseTime(s.br.tot) ?? s.t, counts, t1, secoes));
  }
  const cl = latest.br.cands[LEFT_2026], cr = latest.br.cands[RIGHT_2026];
  return {
    id: '2026', ano: 2026, aoVivo: true,
    left: { n: cl.n, nome: cl.nome, partido: cl.partido },
    right: { n: cr.n, nome: cr.nome, partido: cr.partido },
    // Antes da abertura das urnas o TSE publica um arquivo zerado; descarta esses pontos.
    points: dedupe(points.filter((p) => p.x > 0)),
  };
});

const historyMemo = new WeakMap();
export function historySeries(year) {
  const h = readJson(path.join(HISTORY, `${year}.json`));
  if (!h) return null;
  if (!historyMemo.has(h)) historyMemo.set(h, buildHistory(h, year));
  return historyMemo.get(h);
}

function buildHistory(h, year) {
  const points = h.timeline.map((e) => {
    const counts = {};
    for (const [uf, [st, left, right]] of Object.entries(e.uf)) counts[uf] = { st, left, right };
    return point(e.t, counts, h.t1, h.secoes);
  });
  return { id: String(year), ano: year, aoVivo: false, left: h.left, right: h.right, notas: h.notes, fonte: h.source, points: thin(points, 400) };
}

// "25/10/2026 17:42:10" (horário de Brasília) -> ISO
function tseTime(s) {
  const m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d:\d\d:\d\d)$/.exec(s ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}-03:00` : null;
}

function dedupe(points) {
  return points.filter((p, i) => i === 0 || p.t !== points[i - 1].t);
}

function thin(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points.at(-1));
  return out;
}

export function liveState() {
  const latest = readJson(path.join(LIVE, 'latest.json'));
  const st = readJson(path.join(LIVE, 'status.json'));
  // Idade calculada no servidor: não depende do relógio de quem está vendo.
  const status = st && { ...st, idadeS: Math.round((Date.now() - Date.parse(st.ultimaConsulta)) / 1000) };
  const t1 = t1Prior2026();
  if (!latest || !t1) return { pronto: false, status };
  const secoes = Object.fromEntries(UFS.map((uf) => [uf, latest[uf].secoes]));
  const counts = Object.fromEntries(UFS.map((uf) => [uf, {
    st: latest[uf].secoesTot, left: latest[uf].cands[LEFT_2026].votos, right: latest[uf].cands[RIGHT_2026].votos,
  }]));
  const br = latest.br;
  const cand = (n) => ({ ...br.cands[n], t1Pct: 100 * t1.br[n === LEFT_2026 ? 'left' : 'right'] / t1.br.vv });
  return {
    pronto: true,
    status,
    totalizacao: br.totalizacao,
    pctSecoes: br.pctSecoes,
    secoes: br.secoes,
    secoesTot: br.secoesTot,
    eleitorado: br.eleitorado,
    comparecimento: br.comparecimento,
    votosValidos: br.votosValidos,
    brancos: br.brancos,
    nulos: br.nulos,
    left: cand(LEFT_2026),
    right: cand(RIGHT_2026),
    modelo: winProbability(modelInput(counts, t1, secoes)),
  };
}

// Compara, por UF e região, a fatia de votos válidos no 1º e no 2º turno.
export function regions(ano) {
  let t1, t2, frac = {}, left, right, parcial = false;
  if (ano === 2026) {
    const latest = readJson(path.join(LIVE, 'latest.json'));
    t1 = t1Prior2026();
    if (!latest || !t1) return null;
    t2 = {};
    for (const abr of ['br', ...UFS]) {
      const s = latest[abr];
      t2[abr] = { left: s.cands[LEFT_2026].votos, right: s.cands[RIGHT_2026].votos, vv: s.votosValidos };
      frac[abr] = s.pctSecoes;
    }
    left = { n: LEFT_2026, nome: latest.br.cands[LEFT_2026].nome };
    right = { n: RIGHT_2026, nome: latest.br.cands[RIGHT_2026].nome };
    parcial = latest.br.pctSecoes < 100;
  } else {
    const h = readJson(path.join(HISTORY, `${ano}.json`));
    if (!h) return null;
    t1 = h.t1; t2 = h.final; left = h.left; right = h.right;
    for (const abr of Object.keys(t2)) frac[abr] = 100;
  }
  const row = (a, b) => {
    const pct = (v, tot) => (tot ? (100 * v) / tot : null);
    const two1 = pct(a.left, a.left + a.right);
    const two2 = pct(b.left, b.left + b.right);
    return {
      t1: { left: pct(a.left, a.vv), right: pct(a.right, a.vv), dois: two1 },
      t2: { left: pct(b.left, b.vv), right: pct(b.right, b.vv), dois: two2 },
      votos2: b.vv,
      delta: {
        left: b.vv ? pct(b.left, b.vv) - pct(a.left, a.vv) : null,
        right: b.vv ? pct(b.right, b.vv) - pct(a.right, a.vv) : null,
        dois: two2 !== null && two1 !== null ? two2 - two1 : null,
      },
    };
  };
  const sum = (ufs, src) => ufs.reduce((acc, uf) => {
    const s = src[uf] ?? { left: 0, right: 0, vv: 0 };
    return { left: acc.left + s.left, right: acc.right + s.right, vv: acc.vv + s.vv };
  }, { left: 0, right: 0, vv: 0 });
  const ufs = UFS.filter((uf) => t1[uf] && t2[uf]).map((uf) => ({
    uf, regiao: Object.keys(REGIOES).find((r) => REGIOES[r].ufs.includes(uf)), pctSecoes: frac[uf], ...row(t1[uf], t2[uf]),
  }));
  // Com apuração parcial, o agregado do 2º turno pesa mais as UFs que apuram rápido;
  // a base do 1º turno é então reponderada pela mesma composição (votos já apurados por UF).
  const base = (ufList) => {
    if (!parcial) return sum(ufList, t1);
    return sum(ufList, Object.fromEntries(ufList.filter((uf) => t1[uf]?.vv).map((uf) => {
      const k = (t2[uf]?.vv ?? 0) / t1[uf].vv;
      return [uf, { left: t1[uf].left * k, right: t1[uf].right * k, vv: t1[uf].vv * k }];
    })));
  };
  const regs = Object.entries(REGIOES).map(([id, r]) => ({ id, nome: r.nome, ...row(base(r.ufs), sum(r.ufs, t2)) }));
  return { ano, parcial, left, right, br: row(parcial ? base(UFS) : t1.br, t2.br), ufs, regioes: regs };
}

// Exterior por cidade e país: 2026 a partir dos boletins de urna (ao vivo), 2018/2022 do histórico.
export function exterior() {
  const t2 = readJson(EXTERIOR_FILES[PLEITO_T2]);
  const t1 = readJson(EXTERIOR_FILES[PLEITO_T1]);
  const hist = readJson(path.join(HISTORY, 'exterior.json'));
  if (!t2 && !t1) return null;
  const mapa = hist?.cidades ?? {};
  const vazio = () => ({ left: 0, right: 0, vv: 0 });
  const novo = () => ({
    secoes: { total: 0, comBU: 0 },
    a2026: { t1: vazio(), t1mesmas: vazio(), t2: vazio() },
    a2022: { t1: vazio(), t2: vazio() },
    a2018: { t1: vazio(), t2: vazio() },
  });
  const cidades = Object.create(null); // códigos vindos do TSE: sem protótipo
  const cidade = (cd) => (cidades[cd] ??= {
    cd, nome: mapa[cd]?.nome ?? t2?.cidades?.[cd] ?? t1?.cidades?.[cd] ?? cd, pais: mapa[cd]?.pais ?? null, iso: mapa[cd]?.iso ?? null, ...novo(),
  });
  const add = (acc, left, right, vv) => { acc.left += left; acc.right += right; acc.vv += vv; };
  const vvOf = (v) => Object.entries(v).reduce((s, [k, n]) => (/^\d+$/.test(k) ? s + n : s), 0);

  for (const sec of Object.values(t1?.secoes ?? {})) add(cidade(sec.mu).a2026.t1, sec.v[LEFT_2026] ?? 0, sec.v[RIGHT_2026] ?? 0, vvOf(sec.v));
  for (const [key, sec] of Object.entries(t2?.secoes ?? {})) {
    const c = cidade(sec.mu);
    add(c.a2026.t2, sec.v[LEFT_2026] ?? 0, sec.v[RIGHT_2026] ?? 0, vvOf(sec.v));
    c.secoes.comBU++;
    const s1 = t1?.secoes?.[key];
    if (s1) add(c.a2026.t1mesmas, s1.v[LEFT_2026] ?? 0, s1.v[RIGHT_2026] ?? 0, vvOf(s1.v));
  }
  for (const [cd, n] of Object.entries(t2?.secoesCidade ?? {})) cidade(cd).secoes.total = n;
  for (const ano of ['2022', '2018']) {
    for (const turno of ['t1', 't2']) {
      for (const [cd, r] of Object.entries(hist?.anos?.[ano]?.[turno] ?? {})) add(cidade(cd)[`a${ano}`][turno], r.left, r.right, r.vv);
    }
  }

  // Soma recursiva de linhas com a mesma forma.
  const somar = (acc, r) => {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') acc[k] = (acc[k] ?? 0) + v;
      else if (v && typeof v === 'object') somar((acc[k] ??= {}), v);
    }
    return acc;
  };
  const numeros = ({ secoes, a2026, a2022, a2018 }) => ({ secoes, a2026, a2022, a2018 });
  const paises = Object.create(null);
  for (const c of Object.values(cidades)) {
    const nome = c.pais ?? `${c.nome} (país não mapeado)`;
    const p = (paises[nome] ??= { nome, iso: c.iso, mapeado: !!c.pais, ...novo(), cidades: [] });
    somar(p, numeros(c));
    p.cidades.push(c);
  }
  const peso = (r) => r.a2026.t2.vv || r.a2026.t1.vv || r.a2022.t2.vv || r.a2018.t2.vv;
  const lista = Object.values(paises).sort((a, b) => peso(b) - peso(a));
  for (const p of lista) p.cidades.sort((a, b) => peso(b) - peso(a));
  const anos = hist?.anos ?? {};
  return {
    tse: t2?.config ?? null,
    atualizado: t2?.atualizado ?? null,
    mapeado: !!hist,
    fonte: hist?.fonte ?? null,
    notas: hist?.notas ?? null,
    candidatos: {
      2026: { left: { n: LEFT_2026, nome: 'LULA' }, right: { n: RIGHT_2026, nome: 'FLAVIO BOLSONARO' } },
      ...(anos['2022'] && { 2022: { left: anos['2022'].left, right: anos['2022'].right } }),
      ...(anos['2018'] && { 2018: { left: anos['2018'].left, right: anos['2018'].right } }),
    },
    total: lista.reduce((acc, p) => somar(acc, numeros(p)), {}),
    paises: lista,
  };
}

// O que cada candidato precisa para vencer: pelas pesquisas (antes) e pelo que falta apurar (durante).
export function caminho() {
  const t1 = t1Prior2026();
  if (!t1) return null;
  const sum = (ufs, f) => ufs.reduce((s, uf) => s + f(uf), 0);
  const regs = { ...Object.fromEntries(Object.entries(REGIOES_PESQ).map(([r, v]) => [r, v.ufs])), EX: ['zz'] };
  const totalVV = sum(UFS, (uf) => t1[uf].vv);
  const pesos = {}, t1Share = {};
  for (const [r, ufs] of Object.entries(regs)) {
    pesos[r] = sum(ufs, (uf) => t1[uf].vv) / totalVV;
    const l = sum(ufs, (uf) => t1[uf].left), rr = sum(ufs, (uf) => t1[uf].right);
    t1Share[r] = l / (l + rr);
  }

  // Exterior: as pesquisas não cobrem; usa os boletins do 2º turno se já houver, senão o 1º turno.
  let exShare = t1Share.EX;
  const ext = readJson(EXTERIOR_FILES[PLEITO_T2]);
  if (ext) {
    let l = 0, r = 0;
    for (const s of Object.values(ext.secoes)) { l += s.v[LEFT_2026] ?? 0; r += s.v[RIGHT_2026] ?? 0; }
    if (l + r > 0) exShare = l / (l + r);
  }

  const polls = readJson(POLLS_FILE);
  let pesquisas = null, cen = null;
  if (polls?.pesquisas?.length) {
    pesquisas = mediaPesquisas(polls.pesquisas, Object.fromEntries(UFS.map((uf) => [uf, t1[uf].vv])));
    if (Object.keys(REGIOES_PESQ).every((r) => pesquisas.regioes[r] !== null)) {
      // Recortes regionais têm amostras pequenas e vêm de poucas pesquisas; desloca todos por igual
      // para que o agregado bata com a média nacional (muito mais pesquisas e amostras maiores).
      const brutas = { ...pesquisas.regioes, EX: exShare };
      const agregado = Object.keys(brutas).reduce((s, r) => s + brutas[r] * pesos[r], 0);
      const ajuste = pesquisas.nacional !== null ? (pesquisas.nacional - agregado) / (1 - pesos.EX) : 0;
      pesquisas.regioesBrutas = pesquisas.regioes;
      pesquisas.ajusteRegional = ajuste;
      pesquisas.regioes = Object.fromEntries(Object.entries(pesquisas.regioes).map(([r, v]) => [r, v + ajuste]));
      cen = cenarios({ ...pesquisas.regioes, EX: exShare }, pesos);
    }
  }

  // Durante a apuração: fatia dos votos que faltam que o candidato atrás precisa, no país e por região.
  let aoVivo = null;
  const live = liveState();
  const latest = readJson(path.join(LIVE, 'latest.json'));
  // Abaixo de 1% apurado (quase só exterior e primeiras urnas) a conta ainda não diz nada.
  if (live.pronto && latest && live.modelo.frac >= 0.01) {
    const porUf = live.modelo.porUf;
    const atras = live.modelo.projShareLeft >= 0.5 ? 'right' : 'left';
    const n = atras === 'left' ? LEFT_2026 : RIGHT_2026;
    const porRegiao = {};
    let contAtras = 0, cont = 0, rem = 0, remAtras = 0;
    for (const [r, ufs] of Object.entries(regs)) {
      const ca = sum(ufs, (uf) => latest[uf].cands[n].votos);
      const c = sum(ufs, (uf) => latest[uf].cands[LEFT_2026].votos + latest[uf].cands[RIGHT_2026].votos);
      const rm = sum(ufs, (uf) => porUf[uf]?.remaining ?? 0);
      const ra = sum(ufs, (uf) => (porUf[uf]?.remaining ?? 0) * (atras === 'left' ? porUf[uf]?.shareRemaining ?? 0 : 1 - (porUf[uf]?.shareRemaining ?? 1)));
      porRegiao[r] = { contadoAtras: ca, contado: c, faltam: rm, projecaoAtras: rm ? ra / rm : null, pctApurado: 100 * sum(ufs, (uf) => latest[uf].secoesTot) / (sum(ufs, (uf) => latest[uf].secoes) || 1) };
      contAtras += ca; cont += c; rem += rm; remAtras += ra;
    }
    const metade = (cont + rem) / 2;
    for (const p of Object.values(porRegiao)) {
      // Precisa nesta região, supondo que o resto do que falta siga a projeção do modelo.
      const outros = remAtras - (p.projecaoAtras ?? 0) * p.faltam;
      p.precisa = p.faltam > 0 ? (metade - contAtras - outros) / p.faltam : null;
    }
    aoVivo = {
      atras,
      precisaNacional: rem > 0 ? (metade - contAtras) / rem : null,
      projecaoNacional: rem > 0 ? remAtras / rem : null,
      faltam: rem,
      porRegiao,
    };
  }

  return {
    candidatos: { left: live.left ?? { n: LEFT_2026, nome: 'LULA' }, right: live.right ?? { n: RIGHT_2026, nome: 'FLAVIO BOLSONARO' } },
    regioes: Object.fromEntries(Object.entries(REGIOES_PESQ).map(([r, v]) => [r, v.nome]).concat([['EX', 'Exterior']])),
    pesos,
    totalVV,
    t1: t1Share,
    exteriorShare: exShare,
    pesquisas,
    cenarios: cen,
    notasPesquisas: polls?.notas ?? null,
    aoVivo,
  };
}

// Últimas notícias (coletadas por noticias.js).
export function noticias() {
  return readJson(path.join(LIVE, 'noticias.json'));
}

// Mercados de previsão (coletados por mercados.js); histórico reduzido para o gráfico.
export function mercados() {
  const m = readJson(path.join(LIVE, 'mercados.json'));
  return m && { ...m, historico: thin(m.historico ?? [], 400) };
}
