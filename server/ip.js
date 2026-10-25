import net from 'node:net';
import { CLIENT_IP_HEADER } from './config.js';

// IP do visitante. Só lê cabeçalho quando há um proxy configurado que o sobrescreve
// (ver CLIENT_IP_HEADER em config.js); caso contrário, usa o IP da conexão.
export function clientIp(req) {
  if (CLIENT_IP_HEADER) {
    const raw = String(req.headers[CLIENT_IP_HEADER] ?? '').split(',')[0].trim();
    if (net.isIP(raw)) return raw;
  }
  return (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
}

// Chave para limites de uso: IPv6 agrupado por /64 (um usuário costuma ter o bloco inteiro).
export function ipKey(req) {
  const ip = clientIp(req);
  if (net.isIPv6(ip)) {
    const partes = ip.split('::');
    const esq = partes[0] ? partes[0].split(':') : [];
    const dir = partes.length > 1 && partes[1] ? partes[1].split(':') : [];
    const cheio = [...esq, ...Array(Math.max(0, 8 - esq.length - dir.length)).fill('0'), ...dir];
    return cheio.slice(0, 4).join(':') + '::/64';
  }
  return ip;
}

// Limitador por janela deslizante simples, com limpeza periódica para não crescer sem fim.
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const agora = Date.now();
    for (const [k, arr] of hits) if (!arr.length || agora - arr[arr.length - 1] > windowMs) hits.delete(k);
  }, Math.max(windowMs, 60000));
  timer.unref();
  return (key) => {
    const agora = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => agora - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(agora);
    hits.set(key, arr);
    return true;
  };
}
