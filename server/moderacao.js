// Filtro de moderação do chat. Bloqueia (não mascara) mensagens com palavrões,
// discurso de ódio (racismo, xenofobia, homofobia, intolerância religiosa), ameaças e links.
//
// O texto é normalizado antes da checagem: minúsculas, sem acentos, homóglifos de outros
// alfabetos, leetspeak (p0rr4), letras repetidas colapsadas (poooorra) e pedaços curtos
// reunidos (p o r r a, po.r.ra). Nenhum filtro de lista é perfeito: para o que escapar,
// existe a rota de moderação manual (POST /api/chat/apagar). Teste: node scripts/test_moderacao.js

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

// Letras de outros alfabetos que imitam as latinas (homóglifos mais comuns).
const HOMOGLIFOS = {
  // cirílico e grego
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', к: 'k',
  м: 'm', н: 'h', т: 't', в: 'b', ь: 'b', α: 'a', ο: 'o', ρ: 'p', ε: 'e', ι: 'i', κ: 'k', ν: 'v', τ: 't', υ: 'u', χ: 'x',
  // armênio, cherokee, IPA e versaletes
  օ: 'o', ս: 'u', ո: 'n', հ: 'h', ꮲ: 'p', ꭺ: 'a', ꮯ: 'c', ꭼ: 'e', ꮻ: 'o', ɑ: 'a', ɡ: 'g', ɩ: 'i', ʋ: 'u',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o',
  ᴘ: 'p', ǫ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
};

// Base comum: forma de compatibilidade, sem acentos/invisíveis, minúsculas, homóglifos trocados.
function base(texto) {
  return texto
    .normalize('NFKD') // largura total e ligaduras viram letras comuns; acentos ficam separados
    .replace(/[\p{M}\p{Cf}]/gu, '') // acentos, "zalgo" e caracteres invisíveis (zero-width, RTL)
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (c) => HOMOGLIFOS[c] ?? c);
}

export function normalizar(texto) {
  return base(texto)
    .replace(/(?<=[a-z])[0134578@$!]|[0134578@$!](?=[a-z])/g, (c) => LEET[c])
    .replace(/[^a-z\s]/g, ' ')
    .replace(/(.)\1+/g, '$1') // colapsa letras repetidas (os termos das listas passam pelo mesmo processo)
    .replace(/\s+/g, ' ')
    .trim();
}
const sq = (s) => normalizar(s);

// Palavrões e ofensas: palavra inteira (já normalizada).
const PALAVRAS = new Set([
  'porra', 'caralho', 'caralha', 'puta', 'putas', 'puto', 'putos', 'putaria', 'merda', 'merdas', 'foda', 'fodase', 'foder', 'fodido',
  'fodida', 'fuder', 'fudido', 'fudida', 'buceta', 'boceta', 'cacete', 'cu', 'cus', 'cuzao', 'cuzinho', 'arrombado', 'arrombada',
  'desgracado', 'desgracada', 'escroto', 'escrota', 'viado', 'viadinho', 'veado', 'bicha', 'sapatao', 'traveco', 'xoxota', 'xota',
  'punheta', 'punheteiro', 'siririca', 'piroca', 'bosta', 'bostas', 'vagabundo', 'vagabunda', 'vadia',
  'corno', 'corna', 'otario', 'otaria', 'imbecil', 'retardado', 'retardada', 'mongoloide', 'fdp', 'vsf', 'vtnc', 'tnc', 'pqp', 'kct', 'krl',
  'macaco', 'macaca', 'macacos', 'crioulo', 'crioula', 'nigger', 'nigga', 'macumbeiro', 'macumbeira', 'chifrudo',
].map(sq));

// Variações e grafias alternativas (sobre o texto normalizado, palavra inteira).
const RADICAIS = new RegExp('^(' + [
  'por(as|inha|inhas|ada|adas|ao)', 'c?k?aralh\\w*', 'karal\\w*', 'kralh\\w*', 'put(inh[ao]s?|aria\\w*|ona)', 'merd\\w*',
  'fod[aeiu]\\w*', 'phod\\w*', 'fud[eiu]\\w*', 'bucet\\w*', 'bocet\\w*', 'arombad\\w*', 'desgrac\\w*', 'escrot\\w*',
  'xoxot\\w*', 'punhet\\w*', 'piroc\\w*', 'vagabund\\w*', 'cuzon\\w*', 'viadinh\\w*',
].join('|') + ')$');
const ehPalavrao = (t) => PALAVRAS.has(t) || RADICAIS.test(t);

// Expressões checadas no texto sem espaços.
const EXPRESSOES = [
  'filho da puta', 'filha da puta', 'pau no cu', 'vai tomar no cu', 'vai se foder', 'vai se fuder', 'picole de asfalto',
  'cabelo ruim', 'cabelo de bombril', 'volta pra africa', 'volta pra senzala', 'lugar de preto', 'coisa de preto',
  'tinha que ser preto', 'paraiba burro', 'baiano preguicoso', 'nordestino burro', 'cura gay',
].map((e) => sq(e).replace(/ /g, ''));

// Discurso de ódio: um grupo + um termo degradante a até 6 palavras de distância.
const GRUPOS = /^(nordestin|baian|paraib|cearens|maranhens|piauiens|pernambucan|alagoan|sergipan|potiguar|nortist|sulist|gauch|paulist|carioc|mineir|goian|venezuelan|haitian|bolivian|paraguai|african|angolan|judeu|judia|judeus|arab|muculman|islam|indi[oa]|indigen|negr|pret[oa]s?$|gay|gays|lesbic|lgbt|trans$|travest|evangelic|crente|macumb|umband|candomb|catolic|mulher|pobre|favelad)/;
const DEGRADANTES = /^(bur|vagabund|preguic|lix|imund|suj[oa]|praga|verm|parasit|ignorant|analfabet|macac|animal|bicho|fedid|nojent|inferior|escori|raca$|subumano|extermin|doen[tc]|aberac|demonio|safad|ladr|bandid|morer|matar|queimar)/;
const JANELA_ODIO = 6;

// Ameaças e incitação à violência (sobre o texto normalizado: letras repetidas já colapsadas).
const VIOLENTAS = /^(matar|matarei|matamos|matalo|matala|fuzilar|fuzila|enforcar|asasinar|metralhar|decapitar|linchar|esfaquear|degolar)$/;
const MORTE = /\b(tem que|tinha que|merece|deveria|devia|vai|vao|precisa) morer\b|\bmorte (ao|a|aos|as)\b|\bbala (nele|nela|neles|nelas)\b|\bparedao\b|\btiro (nele|nela|neles|nelas|na cara)\b|\b(vou|vamos|vai|bora|quero|tem que) (mata|matar|dar um tiro|meter bala|esfaquear)\b|\beu mato\b|\bte mato\b|\bmata (lo|la|los|las)\b/;

// Links, inclusive disfarçados: "exemplo．com", "exemplo . com", "exemplo[.]com", "exemplo ponto com".
const TLDS = 'com|net|org|br|io|gg|me|tv|xyz|info|link|app|co|site|shop|online|store|club|top|ly|to|live|vip|bet|pro|biz|ru|cn|us|uk|de|pt|ai|dev|click|fun|icu|cc|ws|tk';
const LINK = new RegExp(`(https?:|www\\.|\\b[a-z0-9-]{2,}\\.(${TLDS})\\b)`);
function temLink(texto) {
  const t = base(texto)
    .replace(/[。｡．]/g, '.')
    .replace(/[[(]\s*(\.|ponto|dot)\s*[\])]/g, '.')
    .replace(/\s+(ponto|dot)\s+/g, '.')
    .replace(/\s*\.\s*/g, '.');
  return LINK.test(t) || /\bt\.me\b|\bbit\.ly\b|wa\.me/.test(t);
}

// Pedaços que surgem de frases comuns ("a cor no mapa", "via do centro") e não devem ser reunidos.
const PARES_COMUNS = new Set(['corno', 'corna', 'viado', 'veado', 'cus'].map(sq));

// Candidatos a palavra: os tokens, os pares vizinhos e sequências de pedaços curtos reunidos
// ("po r ra", "pu t a", "ma tar").
function candidatos(tokens) {
  const out = new Set(tokens);
  for (let i = 0; i < tokens.length; i++) {
    let junto = tokens[i];
    for (let j = i + 1; j < Math.min(tokens.length, i + 5); j++) {
      if (j > i + 1 && tokens[j].length > 3) break;
      if (j === i + 1 || tokens[j - 1].length <= 3) {
        junto += tokens[j];
        const c = normalizar(junto);
        if (!PARES_COMUNS.has(c)) out.add(c);
      } else break;
    }
  }
  return out;
}

/** @returns {{ok: true} | {ok: false, motivo: string}} */
export function moderar(texto) {
  if (temLink(texto)) return { ok: false, motivo: 'links não são permitidos' };
  const n = normalizar(texto);
  if (!n) return { ok: false, motivo: 'mensagem vazia' };
  const tokens = n.split(' ');
  const compacto = n.replace(/ /g, '');
  const cands = candidatos(tokens);
  for (const c of cands) if (ehPalavrao(c)) return { ok: false, motivo: 'linguagem ofensiva ou palavrão' };
  if (EXPRESSOES.some((e) => compacto.includes(e))) return { ok: false, motivo: 'linguagem ofensiva ou discurso de ódio' };
  for (const c of cands) if (VIOLENTAS.test(c)) return { ok: false, motivo: 'ameaças ou incitação à violência não são permitidas' };
  if (MORTE.test(n)) return { ok: false, motivo: 'ameaças ou incitação à violência não são permitidas' };
  for (let i = 0; i < tokens.length; i++) {
    if (!GRUPOS.test(tokens[i])) continue;
    for (let j = Math.max(0, i - JANELA_ODIO); j <= Math.min(tokens.length - 1, i + JANELA_ODIO); j++) {
      if (j !== i && DEGRADANTES.test(tokens[j])) return { ok: false, motivo: 'discurso de ódio (racismo, xenofobia, homofobia ou intolerância) não é permitido' };
    }
  }
  return { ok: true };
}

const RESERVADOS_PALAVRA = new Set(['tse', 'tre', 'stf', 'oficial', 'sistema', 'equipe', 'staff', 'mod', 'adm', 'bot', 'robo']);
const RESERVADOS_TRECHO = ['admin', 'moderad', 'moderac', 'oficial', 'tribunal', 'narador']; // "narrador" já normalizado

export function moderarApelido(apelido) {
  const r = moderar(apelido);
  if (!r.ok) return { ok: false, motivo: 'apelido não permitido' };
  const n = normalizar(apelido);
  if (n.split(' ').some((t) => RESERVADOS_PALAVRA.has(t)) || RESERVADOS_TRECHO.some((t) => n.replace(/ /g, '').includes(t))) {
    return { ok: false, motivo: 'apelido reservado' };
  }
  return { ok: true };
}
