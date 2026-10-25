// Servidor do painel: arquivos estáticos de public/, API JSON e chat.
//   GET /api/live                          situação atual + probabilidade
//   GET /api/timeline                      evolução 2026 (ao vivo) e histórico 2022/2018
//   GET /api/regions?ano=2026|2022|2018    variação por UF/região vs 1º turno
//   GET /api/exterior                      exterior por país/cidade
//   GET /api/caminho                       o que cada candidato precisa para vencer
//   GET /api/abstencao                     apuração e abstenção por região vs 1º turno e 2022
//   GET /healthz                           verificação de saúde (deploy)
//   /api/chat/*                            ver chat.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { PORT, PRODUCTION, PUBLIC_DIR } from './config.js';
import { createLimiter, ipKey } from './ip.js';
import { ANOS_HISTORICOS, abstencao, caminho, exterior, historySeries, liveSeries, liveState, mercados, noticias, regions } from './api.js';
import { flushChat, handleChat } from './chat.js';
import { startNarrador } from './narrador.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    + "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  ...(PRODUCTION && { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png',
};
const COMPRIMIVEL = /^(text\/|application\/json|image\/svg)/;

// Corpo pronto para envio: bruto + gzip + ETag, calculados uma vez.
function preparar(body, type) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    type,
    raw,
    gz: COMPRIMIVEL.test(type) && raw.length > 1024 ? zlib.gzipSync(raw) : null,
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
  };
}

function enviar(req, res, code, p, cache = 'no-cache') {
  const headers = { ...SECURITY_HEADERS, 'Content-Type': p.type, 'Cache-Control': cache, ETag: p.etag, Vary: 'Accept-Encoding' };
  if (code === 200 && req.headers['if-none-match'] === p.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gzip = p.gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  if (gzip) headers['Content-Encoding'] = 'gzip';
  const body = gzip ? p.gz : p.raw;
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

const enviarJson = (req, res, code, obj) => enviar(req, res, code, preparar(JSON.stringify(obj), MIME['.json']));

// Respostas da API em cache por alguns segundos: com muitos visitantes, cada cálculo roda
// no máximo uma vez por janela, não uma vez por requisição.
const API_TTL_MS = 3000;
const apiCache = new Map();
function apiCached(key, compute) {
  const hit = apiCache.get(key);
  if (hit && Date.now() - hit.t < API_TTL_MS) return hit.p;
  const value = compute();
  const p = value === null || value === undefined ? null : preparar(JSON.stringify(value), MIME['.json']);
  apiCache.set(key, { t: Date.now(), p });
  return p;
}

function timeline() {
  // Cada série isolada: problema numa não derruba as outras.
  const series = [];
  for (const f of [liveSeries, ...ANOS_HISTORICOS.map((a) => () => historySeries(a))]) {
    try {
      const s = f();
      if (s) series.push(s);
    } catch (e) {
      console.error('timeline:', e.message);
    }
  }
  return { series };
}

const ROTAS_API = {
  '/api/live': () => liveState(),
  '/api/timeline': () => timeline(),
  '/api/exterior': () => exterior(),
  '/api/caminho': () => caminho(),
  '/api/abstencao': () => abstencao(),
  '/api/noticias': () => noticias(),
  '/api/mercados': () => mercados(),
};
const ANOS_REGIOES = new Set(['2026', ...ANOS_HISTORICOS.map(String)]);

// Arquivos estáticos carregados em memória na primeira leitura (são poucos e pequenos).
const estaticos = new Map();
function arquivoEstatico(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel));
  const relativo = path.relative(PUBLIC_DIR, file);
  if (!relativo || relativo.startsWith('..') || path.isAbsolute(relativo)) return null;
  const hit = estaticos.get(file);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  if (hit && hit.mtime === stat.mtimeMs) return hit.p;
  const p = preparar(fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  estaticos.set(file, { mtime: stat.mtimeMs, p });
  return p;
}

const limiteApi = createLimiter({ max: 240, windowMs: 60000 }); // ~4 req/s por IP, folgado para o painel

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    return res.end();
  }
  const { pathname } = url;
  try {
    if (pathname === '/healthz') return enviarJson(req, res, 200, { ok: true });
    if (pathname.startsWith('/api/chat/') && handleChat(req, res, pathname)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return enviarJson(req, res, 405, { erro: 'método não permitido' });

    if (pathname.startsWith('/api/')) {
      if (!limiteApi(ipKey(req))) {
        res.setHeader('Retry-After', '30');
        return enviarJson(req, res, 429, { erro: 'muitas requisições; aguarde um pouco' });
      }
      let p;
      if (ROTAS_API[pathname]) p = apiCached(pathname, ROTAS_API[pathname]);
      else if (pathname === '/api/regions') {
        const ano = url.searchParams.get('ano') ?? '2026';
        if (!ANOS_REGIOES.has(ano)) return enviarJson(req, res, 400, { erro: 'ano inválido' });
        p = apiCached(`regions:${ano}`, () => regions(Number(ano)));
      } else return enviarJson(req, res, 404, { erro: 'não encontrado' });
      return p ? enviar(req, res, 200, p) : enviarJson(req, res, 404, { erro: 'dados indisponíveis' });
    }

    const p = arquivoEstatico(pathname);
    if (!p) return enviar(req, res, 404, preparar('não encontrado', 'text/plain; charset=utf-8'));
    enviar(req, res, 200, p, 'no-cache'); // revalida sempre (ETag): atualizações chegam na hora
  } catch (e) {
    console.error(e);
    if (!res.headersSent) enviarJson(req, res, 500, { erro: 'erro interno' });
    else res.end();
  }
});

// Proteção contra conexões lentas (slowloris) sem afetar o streaming do chat,
// que é uma resposta longa e não uma requisição longa.
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxConnections = Number(process.env.MAX_CONNECTIONS ?? 5000);

if (!process.argv.includes('--no-collect')) {
  const { startCollector } = await import('./collector.js');
  startCollector();
}
server.listen(PORT, () => console.log(`Painel em http://localhost:${PORT}`));
if (process.env.NARRADOR !== 'off') startNarrador();

function desligar(sinal) {
  console.log(`${sinal}: encerrando…`);
  try { flushChat(); } catch (e) { console.error(e); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // conexões de chat abertas não seguram o desligamento
}
process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
