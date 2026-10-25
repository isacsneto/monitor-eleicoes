// Modelo de probabilidade de vitória durante a apuração.
//
// Ideia: o que falta apurar em cada UF é projetado a partir de uma mistura entre
// (a) a fatia já observada na UF e (b) o prior do 1º turno (disputa a dois)
// corrigido pelo "swing" nacional que se observa nas UFs já apuradas.
// A incerteza tem um componente nacional (correlacionado entre UFs) e um por UF;
// ambos encolhem conforme a apuração avança. Com erros gaussianos, a margem
// final também é gaussiana, então P(vitória) = Φ(margem esperada / desvio).
//
// É um modelo heurístico e transparente, não uma pesquisa: os parâmetros abaixo
// foram escolhidos para serem conservadores e podem ser recalibrados com o histórico.

export const PARAMS = {
  ufWeightHalf: 0.05,  // fração apurada em que a UF pesa 50% observado / 50% prior
  swingPrior: 1000000, // votos "fictícios" que puxam o swing nacional para zero (início da apuração é ruidoso)
  sdUfBase: 0.015,     // deriva mínima entre seções apuradas cedo e tarde na UF
  sdUfPrior: 0.03,     // incerteza extra da UF enquanto depende do prior
  sdNatBase: 0.008,
  sdNatPrior: 0.03,    // erro nacional antes de qualquer voto apurado
  natWeightHalf: 0.1,
  // Em 2018 e 2022 as seções apuradas por último em cada UF pendiam à esquerda:
  // sem este termo a projeção subestimava a esquerda em ~0,8–1 p.p. (scripts/calibrate.js).
  lateDrift: 0.015,
};

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * @param {Array<{uf:string, st:number, ts:number, left:number, right:number,
 *                t1Left:number, t1Right:number, t1vv:number}>} ufs
 * @returns {{pLeft:number, pRight:number, projLeft:number, projRight:number,
 *            projShareLeft:number, swing:number, frac:number}}
 */
export function winProbability(ufs, params = PARAMS) {
  const P = params;
  let swingNum = 0, swingDen = 0, sectionsDone = 0, sectionsAll = 0;
  for (const u of ufs) {
    const n = u.left + u.right;
    const p1 = u.t1Left / (u.t1Left + u.t1Right || 1);
    // O exterior apura primeiro e tem dinâmica própria: não serve de termômetro para o país.
    if (n > 0 && u.uf !== 'zz') {
      swingNum += n * (u.left / n - p1);
      swingDen += n;
    }
    sectionsDone += u.st;
    sectionsAll += u.ts;
  }
  const swing = swingNum / (swingDen + P.swingPrior);
  const frac = sectionsAll ? sectionsDone / sectionsAll : 0;
  const lamNat = frac / (frac + P.natWeightHalf);
  const sdNat = P.sdNatBase + P.sdNatPrior * (1 - lamNat);

  let margin = 0, varUf = 0, remTotal = 0, projLeft = 0, projRight = 0;
  const porUf = {};
  for (const u of ufs) {
    const f = u.ts ? Math.min(1, u.st / u.ts) : 1;
    const n = u.left + u.right;
    const remaining = (1 - f) * u.t1vv;
    const p1 = u.t1Left / (u.t1Left + u.t1Right || 1);
    const prior = p1 + swing;
    const lam = n > 0 ? f / (f + P.ufWeightHalf) : 0;
    const m = Math.min(0.99, Math.max(0.01, lam * (n > 0 ? u.left / n : 0) + (1 - lam) * prior + lam * P.lateDrift));
    const sd = P.sdUfBase + P.sdUfPrior * (1 - lam);
    margin += u.left - u.right + remaining * (2 * m - 1);
    varUf += (2 * remaining * sd) ** 2;
    remTotal += remaining;
    projLeft += u.left + remaining * m;
    projRight += u.right + remaining * (1 - m);
    porUf[u.uf] = { remaining, shareRemaining: m };
  }
  const sdMargin = Math.sqrt(varUf + (2 * remTotal * sdNat) ** 2);
  let pLeft;
  if (sdMargin < 1) pLeft = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
  else pLeft = normCdf(margin / sdMargin);
  return {
    pLeft,
    pRight: 1 - pLeft,
    projLeft,
    projRight,
    projShareLeft: projLeft / (projLeft + projRight || 1),
    swing,
    frac,
    porUf,
  };
}
