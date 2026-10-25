// Configuração central: caminhos e variáveis de ambiente.
//
// Dados que vêm no repositório (somente leitura): data/history, data/polls, data/ref, data/seed.
// Dados gravados em execução: DATA_DIR (padrão ./data; em produção, um volume persistente).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = path.join(ROOT, 'data');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : BUNDLED;

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const HISTORY_DIR = path.join(BUNDLED, 'history');
export const POLLS_FILE = path.join(BUNDLED, 'polls', '2026-t2.json');
export const LIVE_DIR = process.env.LIVE_DIR ? path.resolve(process.env.LIVE_DIR) : path.join(DATA_DIR, 'live');
export const REF_DIR = path.join(DATA_DIR, 'ref');
export const CHAT_DIR = path.join(DATA_DIR, 'chat');

export const PORT = Number(process.env.PORT ?? 3000);
export const PRODUCTION = process.env.NODE_ENV === 'production';
// Token para apagar mensagens do chat (POST /api/chat/apagar). Sem token, a rota fica desativada.
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

// De onde vem o IP real do visitante quando há um proxy na frente:
//   fly-client-ip     Fly.io
//   x-forwarded-for   Railway (primeiro valor; a borda do Railway sobrescreve o cabeçalho)
//   cf-connecting-ip  Cloudflare Tunnel
// Sem proxy (rodando local), use o IP da conexão. Nunca confie em cabeçalho que o proxy não sobrescreve.
export const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER
  ?? (process.env.FLY_APP_NAME ? 'fly-client-ip' : process.env.RAILWAY_ENVIRONMENT ? 'x-forwarded-for' : '')).toLowerCase();

for (const dir of [LIVE_DIR, REF_DIR, CHAT_DIR]) fs.mkdirSync(dir, { recursive: true });

// Num volume novo, copia os dados de referência e a série ao vivo já coletada (data/seed),
// para o servidor não começar do zero.
function seed(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from) || path.resolve(from) === path.resolve(to)) return;
  fs.copyFileSync(from, to);
  console.log(`[config] semeado ${path.relative(ROOT, from)} -> ${to}`);
}
for (const f of ['t1-2026.json', 'exterior-3220.json']) seed(path.join(BUNDLED, 'ref', f), path.join(REF_DIR, f));
for (const f of ['snapshots.jsonl', 'latest.json', 'exterior-3221.json']) seed(path.join(BUNDLED, 'seed', f), path.join(LIVE_DIR, f));
