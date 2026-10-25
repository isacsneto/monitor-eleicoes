// Narrador automático do chat (identificado como robô 🤖, não vota na enquete).
// Observa a apuração e posta: início, marcos de % apurado (comparando com 2022), viradas no
// país e nos estados grandes, mudanças fortes na chance de vitória, o resultado oficial e
// notícias de destaque. Fala no máximo uma vez a cada INTERVALO_MS para não poluir o chat.
import fs from 'node:fs';
import path from 'node:path';
import { CHAT_DIR } from './config.js';
import { writeAtomic } from './fsutil.js';
import { historySeries, liveState, noticias, regions } from './api.js';
import { postarBot } from './chat.js';

const ESTADO_FILE = path.join(CHAT_DIR, 'narrador.json');
const TICK_MS = 20000;
const INTERVALO_MS = Number(process.env.NARRADOR_INTERVALO_MS ?? 45000);
const MARCOS = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100];
const UFS_GRANDES = ['sp', 'mg', 'rj', 'ba', 'rs', 'pr', 'pe', 'ce', 'pa', 'sc', 'go', 'ma', 'am', 'df'];
const NOME_UF = {
  sp: 'São Paulo', mg: 'Minas Gerais', rj: 'Rio de Janeiro', ba: 'Bahia', rs: 'Rio Grande do Sul', pr: 'Paraná',
  pe: 'Pernambuco', ce: 'Ceará', pa: 'Pará', sc: 'Santa Catarina', go: 'Goiás', ma: 'Maranhão', am: 'Amazonas', df: 'Distrito Federal',
};
const FAIXAS = [0.05, 0.25, 0.75, 0.95]; // limites das faixas de chance (para não narrar oscilação pequena)

const pct = (v, d = 1) => `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
const NF = new Intl.NumberFormat('pt-BR');
const curto = (nome) => ({ 'FLAVIO BOLSONARO': 'Flávio', LULA: 'Lula' }[nome] ?? nome.split(' ')[0]);

function carregar() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return null; }
}

export function startNarrador() {
  let estado = carregar();
  const fila = []; // { texto, prioridade, t }
  let ultimoPost = 0;
  const salvar = () => { try { writeAtomic(ESTADO_FILE, JSON.stringify(estado)); } catch (e) { console.error('narrador:', e.message); } };
  const dizer = (texto, prioridade = 1) => fila.push({ texto, prioridade, t: Date.now() });

  function observar() {
    const live = liveState();
    if (!live?.pronto || !(live.pctSecoes > 0)) return;
    const L = curto(live.left.nome), R = curto(live.right.nome);
    const vv = live.left.votos + live.right.votos;
    const shareL = vv ? (100 * live.left.votos) / vv : 50;
    const lider = live.left.votos >= live.right.votos ? 'left' : 'right';
    const placar = `${L} ${pct(shareL, 2)} × ${R} ${pct(100 - shareL, 2)}`;
    const pL = live.modelo.pLeft;
    const faixa = FAIXAS.filter((f) => pL >= f).length;

    // Primeira execução (ou estado apagado): não narra o passado, só faz um resumo.
    if (!estado) {
      estado = { marcos: MARCOS.filter((m) => live.pctSecoes >= m), lider, liderUf: {}, faixa, noticias: [], eleito: false, candidatoLider: null };
      dizer(`🗳️ Apuração em andamento: ${pct(live.pctSecoes, 2)} das seções. ${placar}. Vou avisando por aqui os marcos, viradas e o resultado.`, 2);
      salvar();
      return;
    }

    // Resultado oficial.
    if (!estado.eleito && (live.left.eleito || live.right.eleito)) {
      const v = live.left.eleito ? live.left : live.right;
      estado.eleito = true;
      dizer(`🏁 O TSE declarou ${curto(v.nome)} eleito presidente, com ${pct(v.pct, 2)} dos votos válidos (${NF.format(v.votos)} votos).`, 9);
    }

    // Virada no país (a partir de 1% apurado; antes disso o placar é só exterior e primeiras urnas).
    if (live.pctSecoes >= 1 && lider !== estado.lider) {
      estado.lider = lider;
      const quem = lider === 'left' ? L : R, outro = lider === 'left' ? R : L;
      dizer(`🔄 Virada! ${quem} passa ${outro} com ${pct(live.pctSecoes)} das seções apuradas: ${placar}.`, 8);
    }

    // Marcos de % apurado: anuncia só o maior cruzado desde a última vez.
    const novos = MARCOS.filter((m) => live.pctSecoes >= m && !estado.marcos.includes(m));
    if (novos.length) {
      estado.marcos.push(...novos);
      const m = novos.at(-1);
      const dif = Math.abs(live.left.votos - live.right.votos);
      let texto = `📊 ${m}% das seções apuradas: ${placar} (diferença de ${NF.format(dif)} votos).`;
      try {
        const h = historySeries(2022)?.points.find((p) => p.x >= m - 0.05);
        if (h && m < 100) texto += ` Em 2022, nesse ponto, Lula tinha ${pct(h.shareLeft)}.`;
      } catch { /* sem histórico */ }
      if (m < 100) texto += ` Chance pelo modelo do painel: ${L} ${pct(100 * pL, 0)}.`;
      dizer(texto, 5);
    }

    // Mudança de faixa na chance de vitória (com 5%+ apurado).
    if (live.pctSecoes >= 5 && faixa !== estado.faixa) {
      const subiu = faixa > estado.faixa;
      estado.faixa = faixa;
      const fav = pL >= 0.5 ? L : R;
      const p = pL >= 0.5 ? pL : 1 - pL;
      dizer(p >= 0.95
        ? `📈 Pelo modelo do painel, ${fav} agora é amplo favorito: ${pct(100 * p, 0)} de chance.`
        : p >= 0.75
          ? `📈 O modelo do painel passou a ver ${fav} como favorito: ${pct(100 * p, 0)} de chance.`
          : `⚖️ Disputa voltou a ficar aberta pelo modelo do painel: ${L} ${pct(100 * pL, 0)} × ${R} ${pct(100 - 100 * pL, 0)}.`, subiu ? 4 : 4);
    }

    // Viradas nos estados grandes (com 20%+ apurado no estado; o primeiro registro é silencioso).
    try {
      const reg = regions(2026);
      for (const u of reg?.ufs ?? []) {
        if (!UFS_GRANDES.includes(u.uf) || !(u.pctSecoes >= 20) || u.t2.left === null) continue;
        const lid = u.t2.left >= u.t2.right ? 'left' : 'right';
        const antes = estado.liderUf[u.uf];
        estado.liderUf[u.uf] = lid;
        if (antes && antes !== lid) {
          const quem = lid === 'left' ? L : R;
          dizer(`🔄 Em ${NOME_UF[u.uf]}, ${quem} passou à frente: ${L} ${pct(u.t2.left)} × ${R} ${pct(u.t2.right)} (${pct(u.pctSecoes, 0)} apurado no estado).`, 6);
        }
      }
    } catch { /* regiões indisponíveis */ }

    // Notícia de destaque: publicada por 3+ veículos, recente, no máximo uma a cada 20 min.
    try {
      const n = noticias()?.itens?.find((i) => i.outrasFontes >= 2 && Date.now() - Date.parse(i.data) < 3600000 && !estado.noticias.includes(i.link));
      if (n && Date.now() - (estado.ultimaNoticia ?? 0) > 20 * 60000) {
        estado.noticias = [...estado.noticias.slice(-100), n.link];
        estado.ultimaNoticia = Date.now();
        dizer(`📰 ${n.fonte}: ${n.titulo}`, 2);
      }
    } catch { /* sem notícias */ }

    salvar();
  }

  function falar() {
    if (!fila.length || Date.now() - ultimoPost < INTERVALO_MS) return;
    // Descarta avisos velhos de baixa prioridade (marcos já superados, notícias antigas).
    for (let i = fila.length - 1; i >= 0; i--) if (fila[i].prioridade < 6 && Date.now() - fila[i].t > 5 * 60000) fila.splice(i, 1);
    fila.sort((a, b) => b.prioridade - a.prioridade || a.t - b.t);
    const item = fila.shift();
    if (!item) return;
    postarBot(item.texto);
    ultimoPost = Date.now();
  }

  setInterval(() => {
    try { observar(); falar(); } catch (e) { console.error('narrador:', e.message); }
  }, TICK_MS).unref();
  setTimeout(() => { try { observar(); falar(); } catch (e) { console.error('narrador:', e.message); } }, 5000).unref();
}
