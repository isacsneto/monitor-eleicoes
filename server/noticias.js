// Últimas notícias da eleição: lê feeds RSS de veículos e do Google Notícias, fica só com o que
// é sobre a eleição, junta a mesma notícia publicada por veículos diferentes e ordena por
// importância (assunto, recência e quantos veículos noticiaram). Grava LIVE_DIR/noticias.json.
// Só guarda manchete, veículo, horário e link — o texto das matérias fica nos sites originais.
import path from 'node:path';
import { LIVE_DIR } from './config.js';
import { writeAtomic } from './fsutil.js';

const FEEDS = [
  { fonte: 'Google Notícias', url: 'https://news.google.com/rss/search?q=elei%C3%A7%C3%A3o+2026+segundo+turno+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419', agregador: true },
  { fonte: 'Google Notícias', url: 'https://news.google.com/rss/search?q=apura%C3%A7%C3%A3o+presidente+Lula+Fl%C3%A1vio+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419', agregador: true },
  { fonte: 'g1', url: 'https://g1.globo.com/dynamo/politica/rss2.xml', peso: 1.2 },
  { fonte: 'Folha', url: 'https://feeds.folha.uol.com.br/poder/rss091.xml', peso: 1.2 },
  { fonte: 'Estadão', url: 'https://www.estadao.com.br/arc/outboundfeeds/feeds/rss/sections/politica/', peso: 1.1 },
  { fonte: 'Poder360', url: 'https://www.poder360.com.br/feed/', peso: 1.0 },
  { fonte: 'Agência Brasil', url: 'https://agenciabrasil.ebc.com.br/rss/politica/feed.xml', peso: 1.0 },
];
const ARQUIVO = path.join(LIVE_DIR, 'noticias.json');
const INTERVALO_MS = Number(process.env.NOTICIAS_POLL_MS ?? 180000);
const MAX_BYTES = 3 * 1024 * 1024;
const JANELA_H = 24; // ignora notícias com mais de 24 h
const MAX_ITENS = 30;

const REDES_SOCIAIS = /\b(instagram|facebook|youtube|tiktok|twitter|threads|kwai|linkedin|reddit|telegram)\b|^x(\.com)?$/i;

const sem = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Precisa falar da eleição; termos fortes pesam mais na ordenação.
const RELEVANTE = /\b(eleica|eleito|eleicoes|apuracao|apurad|segundo turno|2o turno|2º turno|tse|urna|lula|flavio|bolsonaro|presidente|presidencia|voto|votos|votacao|pesquisa|boca de urna|governador|abstencao)/;
const FORTES = [
  [/\b(eleito|vence|venceu|vitoria|derrota|reeleito|ganha|ganhou)\b/, 3],
  [/\b(apuracao|apurad|resultado|parcial|virada|lidera|liderando)/, 2.5],
  [/\b(tse|urna|boca de urna|abstencao|seccoes|secoes)/, 1.5],
  [/\b(lula|flavio|bolsonaro)\b/, 1],
  [/\b(segundo turno|2o turno|2º turno|eleicao|eleicoes)\b/, 1],
];

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function texto(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENTIDADES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (item, nome) => item.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, 'i'))?.[1];

function parseFeed(xml, feed) {
  const itens = [];
  for (const [item] of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    let titulo = texto(tag(item, 'title'));
    const link = texto(tag(item, 'link'));
    const data = Date.parse(texto(tag(item, 'pubDate') ?? tag(item, 'dc:date')));
    let fonte = feed.fonte;
    if (feed.agregador) {
      const src = texto(tag(item, 'source'));
      if (src) {
        fonte = src;
        if (titulo.endsWith(` - ${src}`)) titulo = titulo.slice(0, -(src.length + 3)); // "Título - Veículo"
      }
    }
    if (!titulo || !/^https?:\/\//.test(link) || !Number.isFinite(data)) continue;
    // Só imprensa: posts de redes sociais e "manchetes" que são parágrafos inteiros ficam de fora.
    if (REDES_SOCIAIS.test(fonte) || titulo.length > 180) continue;
    itens.push({ titulo, link: link.slice(0, 2000), fonte: fonte.slice(0, 60), data, peso: feed.peso ?? 1 });
  }
  return itens;
}

async function baixar(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; monitor-eleicoes/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('feed grande demais');
  // Codificação: cabeçalho HTTP ou, se ausente, a declaração do próprio XML (a Folha usa ISO-8859-1).
  const prolog = new TextDecoder('latin1').decode(buf.slice(0, 200));
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]
    ?? /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(prolog)?.[1] ?? 'utf-8';
  let xml;
  try { xml = new TextDecoder(charset).decode(buf); } catch { xml = new TextDecoder('utf-8').decode(buf); }
  return parseFeed(xml, feed);
}

const palavras = (t) => new Set(sem(t).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 3));
function parecidas(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size || 1) >= 0.6 && inter >= 3;
}

function ranquear(itens) {
  const agora = Date.now();
  const candidatos = itens
    .filter((i) => agora - i.data < JANELA_H * 3600000 && i.data - agora < 600000)
    .filter((i) => RELEVANTE.test(sem(i.titulo)));
  // Agrupa a mesma notícia de veículos diferentes.
  const grupos = [];
  for (const i of candidatos.sort((a, b) => b.data - a.data)) {
    const w = palavras(i.titulo);
    const g = grupos.find((x) => x.link === i.link || x.titulo === i.titulo || parecidas(x.w, w));
    if (g) {
      g.fontes.add(i.fonte);
      if (i.peso > g.peso) Object.assign(g, { titulo: i.titulo, link: i.link, fonte: i.fonte, peso: i.peso, w });
    } else {
      grupos.push({ ...i, w, fontes: new Set([i.fonte]) });
    }
  }
  for (const g of grupos) {
    const t = sem(g.titulo);
    const assunto = FORTES.reduce((s, [re, p]) => s + (re.test(t) ? p : 0), 0);
    const horas = (agora - g.data) / 3600000;
    g.score = (1 + assunto) * g.peso * (1 + 0.6 * (g.fontes.size - 1)) * 0.5 ** (horas / 4);
  }
  // Os mais relevantes entram na lista; a exibição é da mais recente para a mais antiga.
  return grupos
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITENS)
    .sort((a, b) => b.data - a.data)
    .map((g) => ({
      titulo: g.titulo, link: g.link, fonte: g.fonte, data: new Date(g.data).toISOString(),
      outrasFontes: g.fontes.size - 1, destaque: g.fontes.size >= 3,
    }));
}

async function atualizar() {
  const resultados = await Promise.allSettled(FEEDS.map(baixar));
  const itens = resultados.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const falhas = resultados.filter((r) => r.status === 'rejected').length;
  if (!itens.length) throw new Error(`nenhum feed respondeu (${falhas} falhas)`);
  const lista = ranquear(itens);
  writeAtomic(ARQUIVO, JSON.stringify({ atualizado: new Date().toISOString(), itens: lista }));
  return { total: itens.length, lista: lista.length, falhas };
}

export function startNoticias() {
  let rodando = false;
  const loop = async () => {
    if (!rodando) {
      rodando = true;
      try {
        const r = await atualizar();
        console.log(`[notícias] ${r.lista} destaques de ${r.total} itens (${r.falhas} feeds com falha)`);
      } catch (e) {
        console.error(`[notícias] erro: ${e.message}`);
      } finally {
        rodando = false;
      }
    }
    setTimeout(loop, INTERVALO_MS);
  };
  loop();
}
