// Probabilidades dos mercados de previsão (Kalshi e Polymarket) para o vencedor da eleição.
// Só leitura de APIs públicas; grava LIVE_DIR/mercados.json com o valor atual e o histórico da noite.
// Observação: alguns provedores no Brasil bloqueiam esses domínios. Não contornamos o bloqueio:
// se não houver acesso, o painel mostra "indisponível".
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_DIR } from './config.js';
import { writeAtomic } from './fsutil.js';

const ARQUIVO = path.join(LIVE_DIR, 'mercados.json');
const INTERVALO_MS = Number(process.env.MERCADOS_POLL_MS ?? 60000);
const MAX_HIST = 1500;

export const FONTES = {
  kalshi: {
    nome: 'Kalshi',
    evento: process.env.KALSHI_EVENTO ?? 'KXBRPRES-26',
    url: (ev) => `https://api.elections.kalshi.com/trade-api/v2/events/${encodeURIComponent(ev)}?with_nested_markets=true`,
  },
  polymarket: {
    nome: 'Polymarket',
    evento: process.env.POLYMARKET_EVENTO ?? 'brazil-presidential-election',
    url: (ev) => `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(ev)}`,
  },
};

const sem = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ehLula = (s) => /\blula\b|luiz inacio/.test(sem(s));
const ehFlavio = (s) => /\bflavio\b/.test(sem(s));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const valido = (p) => Number.isFinite(p) && p >= 0 && p <= 1;

// Preço do "Sim" (0–1): meio do spread quando houver compra e venda; senão o último negócio.
function meio(bid, ask, ultimo) {
  if (valido(bid) && valido(ask) && ask > 0 && ask >= bid && ask - bid <= 0.2) return (bid + ask) / 2;
  if (valido(ultimo) && ultimo > 0) return ultimo;
  return valido(bid) ? bid : valido(ask) ? ask : null;
}

// Kalshi: preços em centavos (yes_bid, yes_ask, last_price) ou em dólares (*_dollars).
export function lerKalshi(json) {
  // A API devolve "markets" vazio no topo e os mercados dentro de "event.markets" (with_nested_markets).
  const mercados = [json?.markets, json?.event?.markets].find((a) => Array.isArray(a) && a.length) ?? [];
  const out = {};
  for (const m of mercados) {
    const nome = [m.yes_sub_title, m.subtitle, m.title, m.ticker, m.custom_strike?.Person].filter(Boolean).join(' ');
    const lado = ehLula(nome) || /-LULA$/i.test(m.ticker ?? '') ? 'lula' : ehFlavio(nome) || /-(FBOL|FLAV|FLA)\w*$/i.test(m.ticker ?? '') ? 'flavio' : null;
    if (!lado) continue;
    const c = (v) => (num(v) === null ? null : num(v) / 100);
    const bid = num(m.yes_bid_dollars) ?? c(m.yes_bid);
    const ask = num(m.yes_ask_dollars) ?? c(m.yes_ask);
    const ultimo = num(m.last_price_dollars) ?? c(m.last_price);
    out[lado] = { p: meio(bid, ask, ultimo), volume: num(m.volume_fp ?? m.volume) ?? null, status: m.status ?? null };
  }
  return out;
}

// Polymarket (Gamma): evento com um mercado Sim/Não por candidato; outcomePrices vem como string JSON.
export function lerPolymarket(json) {
  const evento = Array.isArray(json) ? json[0] : json;
  const out = {};
  for (const m of evento?.markets ?? []) {
    const nome = `${m.groupItemTitle ?? ''} ${m.question ?? ''}`;
    const lado = ehLula(nome) ? 'lula' : ehFlavio(nome) ? 'flavio' : null;
    if (!lado) continue;
    let precos = m.outcomePrices;
    try { if (typeof precos === 'string') precos = JSON.parse(precos); } catch { precos = null; }
    let outcomes = m.outcomes;
    try { if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes); } catch { outcomes = null; }
    const iSim = Array.isArray(outcomes) ? Math.max(0, outcomes.findIndex((o) => /^(yes|sim)$/i.test(o))) : 0;
    const p = meio(num(m.bestBid), num(m.bestAsk), num(m.lastTradePrice)) ?? num(precos?.[iSim]);
    out[lado] = { p: valido(p) ? p : null, volume: num(m.volumeNum ?? m.volume), status: m.closed ? 'closed' : m.active === false ? 'inactive' : 'active' };
  }
  return out;
}

async function buscar(chave) {
  const f = FONTES[chave];
  const res = await fetch(f.url(f.evento), {
    headers: { Accept: 'application/json', 'User-Agent': 'monitor-eleicoes/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const texto = await res.text();
  if (texto.length > 5 * 1024 * 1024) throw new Error('resposta grande demais');
  const r = (chave === 'kalshi' ? lerKalshi : lerPolymarket)(JSON.parse(texto));
  if (!valido(r.lula?.p) && !valido(r.flavio?.p)) throw new Error('candidatos não encontrados no mercado');
  return r;
}

function carregar() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch { return { historico: [] }; }
}

async function atualizar() {
  const estado = carregar();
  const agora = new Date().toISOString();
  const ponto = { t: agora };
  for (const chave of Object.keys(FONTES)) {
    try {
      const r = await buscar(chave);
      estado[chave] = { nome: FONTES[chave].nome, ...r, atualizado: agora, erro: null };
      ponto[chave] = { lula: r.lula?.p ?? null, flavio: r.flavio?.p ?? null };
    } catch (e) {
      // "fetch failed" = falha de rede/DNS (ex.: domínio bloqueado pelo provedor).
      const rede = e.message === 'fetch failed' || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/i.test(String(e.cause?.code ?? e.cause?.message ?? ''));
      const motivo = rede ? 'sem acesso a partir deste servidor (domínio bloqueado ou fora do ar)'
        : e.name === 'TimeoutError' ? 'a plataforma não respondeu a tempo' : e.message;
      estado[chave] = { ...(estado[chave] ?? { nome: FONTES[chave].nome }), erro: motivo };
    }
  }
  // Guarda no histórico só quando algum valor mudou (a noite inteira cabe com folga).
  const ultimo = estado.historico.at(-1);
  const mudou = !ultimo || Object.keys(FONTES).some((k) => JSON.stringify(ultimo[k] ?? null) !== JSON.stringify(ponto[k] ?? null));
  if (mudou && Object.keys(FONTES).some((k) => ponto[k])) estado.historico = [...estado.historico, ponto].slice(-MAX_HIST);
  estado.atualizado = agora;
  writeAtomic(ARQUIVO, JSON.stringify(estado));
  return estado;
}

export function startMercados() {
  let rodando = false;
  let ultimoErro = '';
  const loop = async () => {
    if (!rodando) {
      rodando = true;
      try {
        const e = await atualizar();
        const resumo = Object.keys(FONTES).map((k) => `${FONTES[k].nome}: ${e[k]?.erro ? 'erro' : `Lula ${(100 * (e[k].lula?.p ?? NaN)).toFixed(0)}%`}`).join(' · ');
        if (resumo !== ultimoErro) console.log(`[mercados] ${resumo}`);
        ultimoErro = resumo;
      } catch (err) {
        console.error(`[mercados] erro: ${err.message}`);
      } finally {
        rodando = false;
      }
    }
    setTimeout(loop, INTERVALO_MS);
  };
  loop();
}
