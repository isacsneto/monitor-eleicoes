// "Caminho para a vitória": média ponderada das pesquisas por região e quanto cada
// candidato precisa mudar em cada região para vencer (ou pode perder e ainda vencer).
// Todas as fatias são da disputa a dois (Lula / (Lula + Flávio)), de 0 a 1.

// Regiões como as pesquisas costumam divulgar. Norte e Centro-Oeste vêm juntos (NCO).
export const REGIOES_PESQ = {
  SE: { nome: 'Sudeste', ufs: ['es', 'mg', 'rj', 'sp'] },
  NE: { nome: 'Nordeste', ufs: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'] },
  S: { nome: 'Sul', ufs: ['pr', 'rs', 'sc'] },
  NCO: { nome: 'Norte/Centro-Oeste', ufs: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to', 'df', 'go', 'ms', 'mt'] },
};
const N_UFS = ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'];
const CO_UFS = ['df', 'go', 'ms', 'mt'];

// Só vale se os dois candidatos tiverem número (algumas divulgações trazem apenas o líder).
const twoParty = (x) => (x && Number.isFinite(x.lula) && Number.isFinite(x.flavio) && x.lula + x.flavio > 0
  ? x.lula / (x.lula + x.flavio) : null);

/**
 * @param pesquisas lista no formato de data/polls/2026-t2.json
 * @param vvUf votos válidos por UF no 1º turno (para juntar Norte e Centro-Oeste quando vêm separados)
 * @param opts.hoje data de referência; opts.meiaVida dias para o peso de uma pesquisa cair pela metade
 */
export function mediaPesquisas(pesquisas, vvUf, { hoje = new Date(), meiaVida = 4 } = {}) {
  const soma = (ufs) => ufs.reduce((s, uf) => s + (vvUf[uf] ?? 0), 0);
  const wN = soma(N_UFS), wCO = soma(CO_UFS);
  const lista = [];
  const acc = { nacional: [0, 0] };
  for (const r of Object.keys(REGIOES_PESQ)) acc[r] = [0, 0];

  for (const p of pesquisas) {
    const fim = Date.parse(`${p.campo_fim ?? p.divulgacao}T12:00:00-03:00`);
    if (Number.isNaN(fim)) continue;
    const idade = Math.max(0, (hoje.getTime() - fim) / 86400000);
    const peso = 0.5 ** (idade / meiaVida) * Math.sqrt((p.amostra || 1000) / 2000);
    const nac = twoParty(p.nacional?.validos) ?? twoParty(p.nacional?.total);
    const regs = {};
    if (p.regioes) {
      for (const r of ['SE', 'NE', 'S', 'NCO']) {
        const v = twoParty(p.regioes[r]);
        if (v !== null) regs[r] = v;
      }
      if (regs.NCO === undefined) {
        const n = twoParty(p.regioes.N), co = twoParty(p.regioes.CO);
        if (n !== null && co !== null) regs.NCO = (n * wN + co * wCO) / (wN + wCO);
      }
    }
    if (nac !== null) { acc.nacional[0] += peso * nac; acc.nacional[1] += peso; }
    for (const [r, v] of Object.entries(regs)) { acc[r][0] += peso * v; acc[r][1] += peso; }
    lista.push({ instituto: p.instituto, contratante: p.contratante ?? null, campo_fim: p.campo_fim, amostra: p.amostra ?? null, registro: p.registro ?? null, nacional: nac, regioes: regs, peso, fonte: p.fonte ?? [] });
  }
  const pesoTotal = lista.reduce((s, x) => s + x.peso, 0) || 1;
  for (const x of lista) x.pesoPct = (100 * x.peso) / pesoTotal;
  lista.sort((a, b) => (b.campo_fim ?? '').localeCompare(a.campo_fim ?? ''));
  const media = (k) => (acc[k][1] ? acc[k][0] / acc[k][1] : null);
  return {
    nacional: media('nacional'),
    regioes: Object.fromEntries(Object.keys(REGIOES_PESQ).map((r) => [r, media(r)])),
    lista,
  };
}

/**
 * Cenários a partir das fatias por região.
 * @param share  {SE, NE, S, NCO, EX?}: fatia de Lula na disputa a dois em cada região
 * @param pesos  {SE, NE, S, NCO, EX?}: peso de cada região nos votos válidos (soma 1)
 */
export function cenarios(share, pesos) {
  const regs = Object.keys(pesos).filter((r) => share[r] !== null && share[r] !== undefined);
  const wTot = regs.reduce((s, r) => s + pesos[r], 0);
  const nacional = regs.reduce((s, r) => s + share[r] * pesos[r], 0) / wTot;
  const lider = nacional >= 0.5 ? 'left' : 'right';
  const gap = Math.abs(nacional - 0.5); // fatia nacional que precisa trocar de lado
  const porRegiao = {};
  for (const r of regs) {
    const w = pesos[r] / wTot;
    const sl = share[r];
    const sLider = lider === 'left' ? sl : 1 - sl;
    const sAtras = 1 - sLider;
    const precisa = sAtras + gap / w; // fatia que o candidato atrás precisaria só nesta região
    const piso = sLider - gap / w; // mínimo que o líder pode ter nesta região e ainda vencer
    porRegiao[r] = { peso: w, shareLeft: sl, atras: { atual: sAtras, precisa, viavel: precisa <= 1 }, lider: { atual: sLider, piso: Math.max(0, piso) } };
  }
  return { nacional, lider, gap, porRegiao };
}
