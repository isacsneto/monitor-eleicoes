// Chat público em tempo real (Server-Sent Events) com moderação e enquete "em quem você votou".
//   GET  /api/chat/stream    eventos: init, msg, votos, online, apagar
//   POST /api/chat/mensagem  { clientId, apelido, texto }
//   POST /api/chat/voto      { clientId, voto: 'lula' | 'flavio' | 'branco' }
//   POST /api/chat/apagar    { id } ou { autor, banir: true }   (Authorization: Bearer ADMIN_TOKEN)
// Mensagens, votos e banidos ficam em CHAT_DIR. IPs só ficam em memória (limites de uso).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ADMIN_TOKEN, CHAT_DIR } from './config.js';
import { writeAtomic } from './fsutil.js';
import { createLimiter, ipKey } from './ip.js';
import { moderar, moderarApelido } from './moderacao.js';

const MSG_FILE = path.join(CHAT_DIR, 'mensagens.jsonl');
const VOTOS_FILE = path.join(CHAT_DIR, 'votos.json');
const BANIDOS_FILE = path.join(CHAT_DIR, 'banidos.json');
const MAX_HIST = 200;
const MAX_TEXTO = 280;
const INTERVALO_MS = 30000; // uma mensagem a cada 30 s por pessoa (aparelho)
const VOTOS_VALIDOS = ['lula', 'flavio', 'branco'];
const MAX_IDS_POR_IP = 5; // aparelhos distintos que podem votar a partir do mesmo IP
const MAX_SSE_TOTAL = Number(process.env.MAX_SSE ?? 3000);
const MAX_SSE_POR_IP = 6;

const lerJson = (file, padrao) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return padrao; } };

let mensagens = [];
try {
  mensagens = fs.readFileSync(MSG_FILE, 'utf8').split('\n')
    .flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) // ignora linha corrompida
    .slice(-MAX_HIST);
  // Compacta o arquivo no início: só o histórico que ainda é exibido.
  writeAtomic(MSG_FILE, mensagens.map((m) => JSON.stringify(m)).join('\n') + (mensagens.length ? '\n' : ''));
} catch { /* primeiro uso */ }
// Objeto sem protótipo: um clientId como "constructor" não pode colidir com propriedades herdadas.
const votos = Object.assign(Object.create(null), lerJson(VOTOS_FILE, {}));
const contagem = { lula: 0, flavio: 0, branco: 0 };
for (const v of Object.values(votos)) if (v in contagem) contagem[v]++;
const banidos = new Set(lerJson(BANIDOS_FILE, []));

const clientes = new Set();
const ssePorIp = new Map();
const ultimoEnvio = new Map(); // clientId -> { t, texto }
const idsPorIp = new Map(); // ip -> Set(clientId) que votaram
const limiteMsgIp = createLimiter({ max: 6, windowMs: 30000 }); // várias pessoas na mesma rede
const limiteVotoIp = createLimiter({ max: 20, windowMs: 60000 });
const limiteAdmin = createLimiter({ max: 30, windowMs: 60000 });

// Limpa estruturas em memória periodicamente (a noite é longa e os visitantes são muitos).
setInterval(() => {
  const agora = Date.now();
  for (const [id, u] of ultimoEnvio) if (agora - u.t > 180000) ultimoEnvio.delete(id);
  if (idsPorIp.size > 50000) idsPorIp.clear();
}, 300000).unref();

const autorDe = (clientId) => crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 12);
// IPs nunca são gravados em claro, só um HMAC. O sal vem de ADMIN_TOKEN (para banimentos
// sobreviverem a reinícios) ou é aleatório por processo.
const SAL = ADMIN_TOKEN || crypto.randomBytes(16).toString('hex');
const hashIp = (ip) => crypto.createHmac('sha256', SAL).update(ip).digest('hex').slice(0, 16);
const ipDaMsg = new Map(); // id da mensagem -> hash do IP (só em memória, para banir)

const placar = () => ({ ...contagem });

function enviar(res, evento, dados) {
  res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
}
function broadcast(evento, dados) {
  const linha = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientes) {
    // Cliente que não está lendo (conexão travada) acumula memória: desconecta.
    if (res.writableLength > 64 * 1024) { res.destroy(); continue; }
    res.write(linha);
  }
}

// "Online" e placar vão em lotes a cada 2 s: se todos reconectarem juntos (reinício),
// não vira uma avalanche de N² mensagens.
let onlineSujo = false, placarSujo = false;
setInterval(() => {
  if (onlineSujo) { onlineSujo = false; broadcast('online', clientes.size); }
  if (placarSujo) { placarSujo = false; broadcast('votos', placar()); }
}, 2000).unref();

let votosSujos = false;
function salvarVotos() {
  if (!votosSujos) return;
  votosSujos = false;
  writeAtomic(VOTOS_FILE, JSON.stringify(votos));
}
setInterval(salvarVotos, 2000).unref();
export function flushChat() {
  salvarVotos();
}

// Remove caracteres de controle/invisíveis e excesso de acentos empilhados ("zalgo").
function limparTexto(s) {
  return String(s ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function lerCorpo(req, limite = 4096) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      corpo += c;
      if (corpo.length > limite) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const j = JSON.parse(corpo || '{}');
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error();
        resolve(j);
      } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function json(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Só aceita POST com JSON vindo da própria página: bloqueia formulários/fetch de outros sites (CSRF).
function origemValida(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // clientes sem navegador (curl); limitados pelos limites de IP
  try {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const ID_OK = /^[a-zA-Z0-9-]{8,64}$/;

async function postMensagem(req, res) {
  const { clientId, apelido, texto } = await lerCorpo(req);
  if (typeof clientId !== 'string' || !ID_OK.test(clientId)) return json(res, 400, { erro: 'cliente inválido' });
  const nick = limparTexto(apelido);
  const txt = limparTexto(texto);
  if (nick.length < 2 || nick.length > 20) return json(res, 400, { erro: 'o apelido deve ter de 2 a 20 caracteres' });
  if (!txt) return json(res, 400, { erro: 'mensagem vazia' });
  if (txt.length > MAX_TEXTO) return json(res, 400, { erro: `máximo de ${MAX_TEXTO} caracteres` });

  const autor = autorDe(clientId);
  const ip = ipKey(req);
  if (banidos.has(autor) || banidos.has(`ip:${hashIp(ip)}`)) return json(res, 403, { erro: 'você não pode mais enviar mensagens' });

  const agora = Date.now();
  const ultimo = ultimoEnvio.get(clientId);
  if (ultimo && agora - ultimo.t < INTERVALO_MS) {
    const s = Math.ceil((INTERVALO_MS - (agora - ultimo.t)) / 1000);
    return json(res, 429, { erro: `aguarde ${s}s para enviar outra mensagem`, esperar: s });
  }
  if (ultimo && ultimo.texto === txt && agora - ultimo.t < 120000) return json(res, 429, { erro: 'mensagem repetida' });

  const a = moderarApelido(nick);
  if (!a.ok) return json(res, 422, { erro: a.motivo });
  const m = moderar(txt);
  if (!m.ok) return json(res, 422, { erro: `mensagem bloqueada: ${m.motivo}` });
  if (!limiteMsgIp(ip)) return json(res, 429, { erro: 'muitas mensagens; aguarde um pouco' });

  ultimoEnvio.set(clientId, { t: agora, texto: txt });
  // O clientId nunca é exposto: os outros veem só um identificador derivado dele.
  const msg = { id: crypto.randomUUID(), t: new Date(agora).toISOString(), apelido: nick, texto: txt, voto: votos[clientId] ?? null, autor };
  mensagens.push(msg);
  if (mensagens.length > MAX_HIST) mensagens = mensagens.slice(-MAX_HIST);
  ipDaMsg.set(msg.id, hashIp(ip));
  if (ipDaMsg.size > MAX_HIST * 2) ipDaMsg.delete(ipDaMsg.keys().next().value);
  fs.appendFile(MSG_FILE, JSON.stringify(msg) + '\n', () => {});
  broadcast('msg', msg);
  json(res, 200, { ok: true });
}

async function postVoto(req, res) {
  const { clientId, voto } = await lerCorpo(req);
  if (typeof clientId !== 'string' || !ID_OK.test(clientId)) return json(res, 400, { erro: 'cliente inválido' });
  if (!VOTOS_VALIDOS.includes(voto)) return json(res, 400, { erro: 'opção inválida' });
  const ip = ipKey(req);
  if (!limiteVotoIp(ip)) return json(res, 429, { erro: 'muitas tentativas; aguarde um pouco' });
  const ids = idsPorIp.get(ip) ?? new Set();
  if (!ids.has(clientId) && !votos[clientId] && ids.size >= MAX_IDS_POR_IP) {
    return json(res, 429, { erro: 'limite de votos a partir desta conexão' });
  }
  ids.add(clientId);
  idsPorIp.set(ip, ids);
  const anterior = votos[clientId];
  if (anterior !== voto) {
    if (anterior in contagem) contagem[anterior]--;
    contagem[voto]++;
    votos[clientId] = voto;
    votosSujos = true;
    placarSujo = true;
  }
  json(res, 200, { ok: true, voto });
}

// Moderação manual: apagar uma mensagem ou banir o autor (e o IP de onde ela veio).
async function postApagar(req, res) {
  if (!ADMIN_TOKEN) return json(res, 404, { erro: 'não encontrado' });
  if (!limiteAdmin(ipKey(req))) return json(res, 429, { erro: 'muitas tentativas' });
  const enviado = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const esperado = Buffer.from(ADMIN_TOKEN);
  if (enviado.length !== esperado.length || !crypto.timingSafeEqual(enviado, esperado)) return json(res, 401, { erro: 'não autorizado' });
  const { id, autor, banir } = await lerCorpo(req);
  const alvo = (m) => (id && m.id === id) || (autor && m.autor === autor);
  const remover = mensagens.filter(alvo);
  if (banir) {
    for (const m of remover) {
      banidos.add(m.autor);
      if (ipDaMsg.has(m.id)) banidos.add(`ip:${ipDaMsg.get(m.id)}`);
    }
    if (autor) banidos.add(String(autor));
    writeAtomic(BANIDOS_FILE, JSON.stringify([...banidos]));
  }
  if (remover.length) {
    mensagens = mensagens.filter((m) => !alvo(m));
    writeAtomic(MSG_FILE, mensagens.map((m) => JSON.stringify(m)).join('\n') + (mensagens.length ? '\n' : ''));
    broadcast('apagar', remover.map((m) => m.id));
  }
  json(res, 200, { ok: true, apagadas: remover.length, banido: !!banir });
}

function stream(req, res) {
  const ip = ipKey(req);
  const doIp = ssePorIp.get(ip) ?? 0;
  if (clientes.size >= MAX_SSE_TOTAL || doIp >= MAX_SSE_POR_IP) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' });
    return res.end('chat lotado, tente em instantes');
  }
  ssePorIp.set(ip, doIp + 1);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  clientes.add(res);
  enviar(res, 'init', { mensagens: mensagens.slice(-100), votos: placar(), online: clientes.size });
  onlineSujo = true;
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clientes.delete(res);
    const n = (ssePorIp.get(ip) ?? 1) - 1;
    if (n > 0) ssePorIp.set(ip, n); else ssePorIp.delete(ip);
    onlineSujo = true;
  });
}

// Mensagem do narrador automático: marcada como robô (bot: true) e nunca conta na enquete.
export function postarBot(texto) {
  const msg = {
    id: crypto.randomUUID(), t: new Date().toISOString(), apelido: 'Narrador', texto: limparTexto(texto).slice(0, 400),
    voto: null, autor: 'narrador', bot: true,
  };
  mensagens.push(msg);
  if (mensagens.length > MAX_HIST) mensagens = mensagens.slice(-MAX_HIST);
  fs.appendFile(MSG_FILE, JSON.stringify(msg) + '\n', () => {});
  broadcast('msg', msg);
}

// Devolve true se tratou a requisição.
export function handleChat(req, res, pathname) {
  if (pathname === '/api/chat/stream') {
    if (req.method !== 'GET') { json(res, 405, { erro: 'método não permitido' }); return true; }
    stream(req, res);
    return true;
  }
  const rota = { '/api/chat/mensagem': postMensagem, '/api/chat/voto': postVoto, '/api/chat/apagar': postApagar }[pathname];
  if (!rota) return false;
  if (req.method !== 'POST') { json(res, 405, { erro: 'use POST' }); return true; }
  if (!origemValida(req)) { json(res, 403, { erro: 'origem não permitida' }); return true; }
  rota(req, res).catch((e) => json(res, e.status ?? 400, { erro: e.status ? e.message : 'requisição inválida' }));
  return true;
}
