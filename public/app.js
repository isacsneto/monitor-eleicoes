const $ = (id) => document.getElementById(id);
const NF = new Intl.NumberFormat('pt-BR');

const ui = { metrica: 'votos', eixo: 'pct', anos: new Set(['2026', '2022', '2018']), anoReg: '2026', mapaMetrica: 'dois', ufSort: { k: 'uf', dir: 1 } };
let live = null, timeline = null, regions = null;
let mapaSel = null; // UF tocada no mapa (detalhe fixo abaixo dele)

const YEAR_STYLE = {
  '2026': { dash: '', width: 2.5, css: 'solid' },
  '2022': { dash: '7 4', width: 2, css: 'dashed' },
  '2018': { dash: '1.5 4', width: 2, css: 'dotted' },
};
const MARCOS = [10, 25, 50, 75, 90, 100];
const TILES = {
  rr: [1, 0], ap: [3, 0],
  am: [1, 1], pa: [2, 1], ma: [3, 1], ce: [4, 1], rn: [5, 1],
  ac: [0, 2], ro: [1, 2], to: [2, 2], pi: [3, 2], pe: [4, 2], pb: [5, 2],
  mt: [1, 3], go: [2, 3], ba: [3, 3], se: [4, 3], al: [5, 3],
  ms: [1, 4], df: [2, 4], mg: [3, 4], es: [4, 4],
  pr: [1, 5], sp: [2, 5], rj: [3, 5],
  sc: [1, 6],
  rs: [1, 7], zz: [4, 7],
};

// ---------- formatação ----------
const pct = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–'
  : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
const pp = (v, d = 1) => (v === null || v === undefined ? '–'
  : (Math.abs(v) < 0.5 * 10 ** -d ? '' : v > 0 ? '+' : '−') + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' p.p.');
const LOWER = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
// Nomes de urna do TSE vêm em maiúsculas e às vezes sem acento.
const NOME_LONGO = { 'FLAVIO BOLSONARO': 'Flávio Bolsonaro' };
const NOME_CURTO = { 'FLAVIO BOLSONARO': 'Flávio', 'JAIR BOLSONARO': 'Bolsonaro', 'FERNANDO HADDAD': 'Haddad' };
const nome = (s) => NOME_LONGO[s] ?? (s ?? '').toLowerCase().split(' ').map((w, i) => (i && LOWER.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
const curto = (s) => NOME_CURTO[s] ?? nome(s).split(' ')[0];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Minutos desde a meia-noite no horário de Brasília (UTC-3).
function minutosBrt(iso) {
  const m = Date.parse(iso) / 60000 - 180;
  return ((m % 1440) + 1440) % 1440;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---------- situação atual ----------
function renderLive() {
  const st = $('status');
  if (!live || !live.pronto) {
    st.className = 'status erro';
    $('status-txt').textContent = 'aguardando dados do TSE…';
    return;
  }
  const s = live.status;
  // Idade calculada pelo servidor: não depende do relógio de quem está vendo.
  const idade = s?.idadeS ?? null;
  const travado = idade === null || idade > 120;
  st.className = 'status ' + (s?.erro || travado || liveVelho ? 'erro' : 'vivo');
  const fim = live.pctSecoes >= 100;
  const eleito = live.left.eleito ? live.left : live.right.eleito ? live.right : null;
  $('status-txt').textContent = liveVelho ? 'sem conexão com o painel — tentando de novo…'
    : s?.erro ? 'TSE instável — mostrando os últimos dados recebidos'
    : travado ? (eleito ? `${curto(eleito.nome)} eleito · TSE atualizou ${live.totalizacao ?? '–'}` : 'dados atrasados — aguardando nova atualização do TSE')
    : `${eleito ? `${curto(eleito.nome)} eleito · ` : ''}${fim ? 'Apuração encerrada' : 'Ao vivo'} · TSE atualizou ${live.totalizacao ?? '–'} · consultado há ${Math.max(0, idade)}s`;

  $('pct-secoes').textContent = pct(live.pctSecoes);
  $('secoes-det').textContent = `(${NF.format(live.secoesTot)} de ${NF.format(live.secoes)} seções · ${NF.format(live.votosValidos)} votos válidos)`;
  $('barra-secoes').style.width = `${live.pctSecoes}%`;

  // Quem está à frente e por quanto: a informação mais importante, em evidência.
  const dif = live.left.votos - live.right.votos;
  const lider = dif === 0 ? null : dif > 0 ? live.left : live.right;
  const card = (c) => `
    <div class="nome">${esc(nome(c.nome))}${c.eleito ? '<span class="eleito">Eleito</span>' : lider === c && live.votosValidos ? '<span class="frente">à frente</span>' : ''}</div>
    <div class="partido">${esc(c.partido)} · ${esc(c.n)}</div>
    <div class="pct">${pct(c.pct)}</div>
    <div class="votos">${NF.format(c.votos)} votos</div>
    <div class="t1">1º turno: ${pct(c.t1Pct)} dos votos válidos</div>`;
  $('card-left').innerHTML = card(live.left);
  $('card-right').innerHTML = card(live.right);
  $('card-left').classList.toggle('lider', lider === live.left);
  $('card-right').classList.toggle('lider', lider === live.right);
  renderDestaques();
  renderPlacarFixo();

  const m = live.modelo;
  const pl = 100 * m.pLeft, pr = 100 - pl;
  const fmtP = (v) => (v > 99.9 ? '>99,9%' : v < 0.1 ? '<0,1%' : pct(v, 1));
  $('card-prob').innerHTML = `
    <h3>Chance de vitória ${m.frac === 0 ? '(antes da apuração, pelo 1º turno)' : '(modelo do painel)'}</h3>
    <div class="nums"><b>${fmtP(pl)}</b><b>${fmtP(pr)}</b></div>
    <div class="split" role="img" aria-label="Chance: ${esc(curto(live.left.nome))} ${fmtP(pl)}, ${esc(curto(live.right.nome))} ${fmtP(pr)}">
      <div class="l" style="width:${pl}%"></div><div class="r" style="width:${pr}%"></div>
    </div>
    <div class="names"><span>${esc(curto(live.left.nome))}</span><span>${esc(curto(live.right.nome))}</span></div>
    <div class="proj">
      Projeção de votos válidos ao final: <b>${esc(curto(live.left.nome))} ${pct(100 * m.projShareLeft, 1)}</b> ×
      <b>${esc(curto(live.right.nome))} ${pct(100 - 100 * m.projShareLeft, 1)}</b><br>
      Desvio vs 1º turno nas UFs já apuradas: ${pp(100 * m.swing)} ${m.swing >= 0 ? 'para a esquerda' : 'para a direita'}
    </div>`;
}

// ---------- linha do tempo ----------
function seriesValue(p, metrica) {
  if (metrica === 'votos') return p.shareLeft;
  if (metrica === 'prob') return p.pLeft;
  return p.projShareLeft;
}

function visibleSeries() {
  if (!timeline) return [];
  return timeline.series.filter((s) => ui.anos.has(s.id) && s.points.length).map((s) => ({
    ...s,
    pts: s.points.map((p) => ({ x: ui.eixo === 'pct' ? p.x : minutosBrt(p.t), y: seriesValue(p, ui.metrica), p }))
      .filter((d) => d.y !== null && d.y !== undefined),
  })).filter((s) => s.pts.length);
}

function renderAnos() {
  if (!timeline) return;
  $('f-anos').innerHTML = timeline.series.map((s) => `
    <label><input type="checkbox" value="${s.id}" ${ui.anos.has(s.id) ? 'checked' : ''}>${s.id}${s.aoVivo ? ' (ao vivo)' : ''}</label>`).join('');
  $('f-anos').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => {
    el.checked ? ui.anos.add(el.value) : ui.anos.delete(el.value);
    renderChart();
  }));
}

function legendSwatch(color, dash, width) {
  return `<svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" stroke-linecap="round"/></svg>`;
}

function renderChart() {
  const svg = $('chart');
  const series = visibleSeries();
  const W = svg.clientWidth, H = svg.clientHeight;
  const M = { l: 40, r: W < 520 ? 12 : 120, t: 12, b: 28 };
  const cl = css('--left'), cr = css('--right');

  $('legenda').innerHTML = series.map((s) => {
    const st = YEAR_STYLE[s.id] ?? YEAR_STYLE['2022'];
    return `<span>${legendSwatch(cl, st.dash, st.width)}${s.id} · ${esc(curto(s.left.nome))}</span>
            <span>${legendSwatch(cr, st.dash, st.width)}${s.id} · ${esc(curto(s.right.nome))}</span>`;
  }).join('');

  if (!series.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Sem dados para exibir ainda — a apuração de 2026 começa após as 17h.</text>`;
    return;
  }

  let x0, x1;
  if (ui.eixo === 'pct') { x0 = 0; x1 = 100; } else {
    const xs = series.flatMap((s) => s.pts.map((d) => d.x));
    x0 = Math.min(17 * 60, ...xs); x1 = Math.max(...xs) + 5;
  }
  let y0 = 0, y1 = 100;
  if (ui.metrica !== 'prob') {
    // O começo da apuração (<2% das seções) é muito ruidoso; não deixa ele ditar a escala.
    const dev = Math.max(3, ...series.flatMap((s) => s.pts.filter((d) => d.p.x >= 2).map((d) => Math.abs(d.y - 50)))) + 1;
    const d = Math.ceil(dev);
    y0 = 50 - d; y1 = 50 + d;
  }
  const sx = (v) => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r);
  const sy = (v) => M.t + ((y1 - v) / (y1 - y0)) * (H - M.t - M.b);

  const parts = [`<defs><clipPath id="plot"><rect x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}"/></clipPath></defs>`];
  // grade e eixos
  const yStep = (y1 - y0) > 40 ? 25 : (y1 - y0) > 16 ? 5 : 2;
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) {
    parts.push(`<line class="${v === 50 ? 'ref' : 'grid'}" x1="${M.l}" x2="${W - M.r}" y1="${sy(v)}" y2="${sy(v)}"/>`);
    parts.push(`<text x="${M.l - 6}" y="${sy(v) + 4}" text-anchor="end">${v}%</text>`);
  }
  const xTicks = ui.eixo === 'pct' ? [0, 25, 50, 75, 100] : (() => {
    const out = [];
    const step = x1 - x0 > 300 ? 60 : 30;
    for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) out.push(v);
    return out;
  })();
  for (const v of xTicks) parts.push(`<text x="${sx(v)}" y="${H - 8}" text-anchor="middle">${ui.eixo === 'pct' ? v + '%' : hhmm(v)}</text>`);

  // linhas: o histórico primeiro, 2026 por cima
  const ordered = [...series].sort((a, b) => (a.aoVivo ? 1 : 0) - (b.aoVivo ? 1 : 0) || a.ano - b.ano);
  for (const s of ordered) {
    const st = YEAR_STYLE[s.id] ?? YEAR_STYLE['2022'];
    for (const [side, color] of [['L', cl], ['R', cr]]) {
      const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(side === 'L' ? p.y : 100 - p.y).toFixed(1)}`).join('');
      parts.push(`<path clip-path="url(#plot)" d="${d}" fill="none" stroke="${color}" stroke-width="${st.width}" stroke-dasharray="${st.dash}" stroke-linecap="round" stroke-linejoin="round" opacity="${s.aoVivo ? 1 : 0.8}"/>`);
    }
  }
  // rótulos diretos no fim da série mais recente
  const head = series.find((s) => s.aoVivo) ?? series[0];
  const last = head.pts.at(-1);
  if (M.r > 60) {
    let yl = sy(last.y), yr = sy(100 - last.y);
    if (Math.abs(yl - yr) < 16) { const mid = (yl + yr) / 2; const up = yl < yr ? -8 : 8; yl = mid + up; yr = mid - up; }
    parts.push(`<text class="lbl" x="${sx(last.x) + 8}" y="${yl + 4}">${esc(curto(head.left.nome))} ${pct(last.y, 1)}</text>`);
    parts.push(`<text class="lbl" x="${sx(last.x) + 8}" y="${yr + 4}">${esc(curto(head.right.nome))} ${pct(100 - last.y, 1)}</text>`);
    parts.push(`<circle cx="${sx(last.x)}" cy="${sy(last.y)}" r="4" fill="${cl}" stroke="${css('--surface')}" stroke-width="2"/>`);
    parts.push(`<circle cx="${sx(last.x)}" cy="${sy(100 - last.y)}" r="4" fill="${cr}" stroke="${css('--surface')}" stroke-width="2"/>`);
  }
  parts.push(`<line class="cross" id="cross" y1="${M.t}" y2="${H - M.b}" visibility="hidden"/>`);
  parts.push(`<rect id="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent"/>`);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');

  const tip = $('tooltip'), cross = $('cross');
  const metricaNome = { votos: 'votos válidos', prob: 'chance de vitória', proj: 'projeção final' }[ui.metrica];
  const mostrar = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = Math.max(M.l, Math.min(W - M.r, clientX - box.left));
    const xv = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    const rows = ordered.slice().reverse().map((s) => {
      const p = nearest(s.pts, xv);
      if (!p || Math.abs(p.x - xv) > (x1 - x0) * 0.04) return '';
      const st = YEAR_STYLE[s.id] ?? YEAR_STYLE['2022'];
      const extra = ui.eixo === 'pct' ? hhmm(minutosBrt(p.p.t)) : `${pct(p.p.x, 0)} apur.`;
      return `<div class="tt-r"><span><i style="border-color:${cl};border-top-style:${st.css}"></i>${s.id} ${esc(curto(s.left.nome))}</span><b>${pct(p.y, 1)}</b></div>
              <div class="tt-r"><span><i style="border-color:${cr};border-top-style:${st.css}"></i>${s.id} ${esc(curto(s.right.nome))}</span><b>${pct(100 - p.y, 1)}</b></div>
              <div class="tt-r muted"><span></span><span>${extra}</span></div>`;
    }).join('');
    if (!rows) { tip.hidden = true; return; }
    tip.innerHTML = `<div class="tt-h">${ui.eixo === 'pct' ? `${pct(xv, 0)} das seções` : hhmm(xv)} · ${metricaNome}</div>${rows}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = px + 14 + tw > W ? px - tw - 14 : px + 14;
    tip.style.left = `${Math.max(0, Math.min(W - tw, left))}px`; // nunca sai da tela no celular
    tip.style.top = `${M.t + 8}px`;
  };
  const esconder = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  const hit = $('hit');
  hit.addEventListener('mousemove', (ev) => mostrar(ev.clientX));
  hit.addEventListener('mouseleave', esconder);
  // Toque: arrastar o dedo sobre o gráfico mostra os valores; soltar esconde depois de um tempo.
  let timerToque = null;
  const toque = (ev) => { clearTimeout(timerToque); mostrar(ev.touches[0].clientX); };
  hit.addEventListener('touchstart', toque, { passive: true });
  hit.addEventListener('touchmove', toque, { passive: true });
  hit.addEventListener('touchend', () => { timerToque = setTimeout(esconder, 2500); });

  renderMarcos();
}

function nearest(pts, x) {
  let lo = 0, hi = pts.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].x < x) lo = mid + 1; else hi = mid;
  }
  const a = pts[Math.max(0, lo - 1)], b = pts[lo];
  return Math.abs(a.x - x) <= Math.abs(b.x - x) ? a : b;
}

function renderMarcos() {
  if (!timeline) return;
  const ss = timeline.series.filter((s) => s.points.length);
  const head = `<tr><th>Seções apuradas</th>${ss.map((s) => `<th>${s.id}: ${esc(curto(s.left.nome))} (votos)</th><th>${s.id}: chance esq.</th>`).join('')}</tr>`;
  const rows = MARCOS.map((m) => `<tr><td>${m}%</td>${ss.map((s) => {
    const p = s.points.find((q) => q.x >= m - 0.05);
    return p ? `<td>${pct(p.shareLeft, 1)}</td><td>${pct(p.pLeft, 0)}</td>` : '<td>–</td><td>–</td>';
  }).join('')}</tr>`).join('');
  $('tabela-marcos').innerHTML = `<div class="wrap-x"><table class="tabela">${head}${rows}</table></div>`;
  const notas = timeline.series.filter((s) => s.notas).map((s) => `<p><b>${s.id}:</b> ${esc(s.notas)}</p>`).join('');
  $('nota-modelo').innerHTML = `Chance de vitória: modelo do painel que projeta o que falta apurar em cada UF misturando o resultado parcial da UF
    com o 1º turno ajustado pelo desvio observado no país, mais um ajuste de +1,5 p.p. à esquerda no que falta apurar (padrão observado em 2018 e 2022);
    a incerteza encolhe conforme a apuração avança. O mesmo modelo é aplicado ao histórico, então as curvas são comparáveis.
    ${notas ? `<details><summary>Como o histórico foi reconstruído</summary>${notas}</details>` : ''}`;
}

// ---------- regiões ----------
function deltaColor(v, max, pos, neg) {
  const t = Math.max(-1, Math.min(1, v / max));
  const c = t >= 0 ? pos : neg;
  return { bg: `color-mix(in oklab, ${c} ${Math.round(Math.abs(t) * 100)}%, var(--neutral))`, dark: Math.abs(t) > 0.6 };
}

function renderRegions() {
  const r = regions;
  if (!r) {
    $('regioes-sub').textContent = 'Dados indisponíveis para este ano.';
    $('mapa').innerHTML = ''; $('tabela-regioes').innerHTML = ''; $('tabela-ufs').innerHTML = ''; $('escala').innerHTML = '';
    return;
  }
  const L = curto(r.left.nome), R = curto(r.right.nome);
  $('regioes-sub').textContent = `Fatia dos votos válidos no 2º turno comparada com o 1º turno${r.parcial ? ' — 2026 com apuração parcial: compara o que já foi apurado em cada UF' : ''}. No 2º turno os dois tendem a subir porque herdam votos dos demais candidatos; o mapa mostra para que lado a disputa a dois se moveu.`;

  const metricas = { dois: `Disputa a dois`, left: `Δ ${L}`, right: `Δ ${R}` };
  const val = (u) => u.delta[ui.mapaMetrica];
  const max = Math.max(1, ...r.ufs.map((u) => Math.abs(val(u) ?? 0)));
  const pos = ui.mapaMetrica === 'right' ? 'var(--right)' : 'var(--left)';
  const neg = ui.mapaMetrica === 'dois' ? 'var(--right)' : 'var(--ink-2)';

  const tiles = r.ufs.map((u) => {
    const [c, row] = TILES[u.uf] ?? [0, 0];
    const v = val(u);
    const semDados = !u.votos2;
    const col = semDados ? { bg: 'transparent', dark: false } : deltaColor(v, max, pos, neg);
    const tip = semDados ? `${u.uf.toUpperCase()}: sem votos apurados`
      : `${u.uf === 'zz' ? 'Exterior' : u.uf.toUpperCase()} (${pct(u.pctSecoes, 0)} apurado)\n${L}: ${pct(u.t1.left, 1)} → ${pct(u.t2.left, 1)} (${pp(u.delta.left)})\n${R}: ${pct(u.t1.right, 1)} → ${pct(u.t2.right, 1)} (${pp(u.delta.right)})\nDisputa a dois (${L}): ${pct(u.t1.dois, 1)} → ${pct(u.t2.dois, 1)}`;
    return `<div class="tile ${col.dark ? 'dark' : ''} ${u.uf === mapaSel ? 'sel' : ''}" role="button" tabindex="0" data-uf="${u.uf}"
      style="grid-column:${c + 1};grid-row:${row + 1};background:${col.bg}" title="${esc(tip)}" data-tip="${esc(tip)}">
      ${u.uf === 'zz' ? 'EXT' : u.uf.toUpperCase()}<small>${semDados ? '–' : pp(v, 1).replace(' p.p.', '')}</small></div>`;
  }).join('');
  $('mapa').innerHTML = tiles;
  // No celular não existe "passar o mouse": tocar (ou Enter) num estado mostra o detalhe abaixo do mapa.
  const sel = $('mapa').querySelector(`.tile[data-uf="${mapaSel}"]`);
  $('mapa-info').textContent = sel ? sel.dataset.tip : 'Toque num estado para ver os detalhes.';
  $('mapa').querySelectorAll('.tile').forEach((t) => {
    const escolher = () => { mapaSel = t.dataset.uf; $('mapa-info').textContent = t.dataset.tip; $('mapa').querySelectorAll('.tile').forEach((x) => x.classList.toggle('sel', x === t)); };
    t.addEventListener('click', escolher);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); escolher(); } });
  });

  const metricaBtns = Object.entries(metricas).map(([k, n]) => `<button data-v="${k}" class="${ui.mapaMetrica === k ? 'on' : ''}">${esc(n)}</button>`).join('');
  const ends = ui.mapaMetrica === 'dois'
    ? [`← ${R} ganhou terreno`, `${L} ganhou terreno →`]
    : [`← caiu`, `cresceu →`];
  $('escala').innerHTML = `
    <div class="seg" id="f-mapa">${metricaBtns}</div>
    <div class="grad" style="background:linear-gradient(90deg, color-mix(in oklab, ${neg} 100%, var(--neutral)), var(--neutral), ${pos})"></div>
    <div class="ends"><span>${esc(ends[0])}</span><span>${esc(ends[1])}</span></div>
    <div class="muted">Cor mais forte = ${NF.format(Math.round(max * 10) / 10)} p.p. ou mais</div>`;
  $('f-mapa').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { ui.mapaMetrica = b.dataset.v; renderRegions(); }));

  const cells = (x) => `
    <td>${pct(x.t1.left, 1)}</td><td>${pct(x.t2.left, 1)}</td><td class="delta-l">${pp(x.delta.left)}</td>
    <td>${pct(x.t1.right, 1)}</td><td>${pct(x.t2.right, 1)}</td><td class="delta-r">${pp(x.delta.right)}</td>
    <td>${pp(x.delta.dois)}</td>`;
  const headCols = (first) => `<tr><th>${first}</th>
    <th><span class="sw" style="background:var(--left)"></span>${esc(L)} 1º</th><th>2º</th><th>Δ</th>
    <th><span class="sw" style="background:var(--right)"></span>${esc(R)} 1º</th><th>2º</th><th>Δ</th>
    <th title="Variação da fatia de ${esc(L)} na disputa a dois">Desvio esq.</th></tr>`;
  $('tabela-regioes').innerHTML = `<thead>${headCols('Região')}</thead><tbody>
    ${r.regioes.map((g) => `<tr><td>${esc(g.nome)}</td>${cells(g)}</tr>`).join('')}
    <tr><td><b>Brasil</b></td>${cells(r.br)}</tr></tbody>`;
  $('tabela-regioes').parentElement.classList.add('wrap-x');

  const keyOf = { uf: (u) => u.uf, apur: (u) => u.pctSecoes, dl: (u) => u.delta.left ?? -999, dr: (u) => u.delta.right ?? -999, dd: (u) => u.delta.dois ?? -999 };
  const sorted = [...r.ufs].sort((a, b) => {
    const ka = keyOf[ui.ufSort.k](a), kb = keyOf[ui.ufSort.k](b);
    return (ka > kb ? 1 : ka < kb ? -1 : 0) * ui.ufSort.dir;
  });
  $('tabela-ufs').innerHTML = `<thead><tr><th data-sort="uf">UF</th><th data-sort="apur">Apurado</th>
    <th>${esc(L)} 1º</th><th>2º</th><th data-sort="dl">Δ ▾</th><th>${esc(R)} 1º</th><th>2º</th><th data-sort="dr">Δ ▾</th><th data-sort="dd">Desvio esq. ▾</th></tr></thead>
    <tbody>${sorted.map((u) => `<tr><td>${u.uf === 'zz' ? 'Exterior' : u.uf.toUpperCase()}</td><td>${pct(u.pctSecoes, 0)}</td>${cells(u)}</tr>`).join('')}</tbody>`;
  $('tabela-ufs').querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    ui.ufSort = { k, dir: ui.ufSort.k === k ? -ui.ufSort.dir : (k === 'uf' ? 1 : -1) };
    renderRegions();
  }));
}

// ---------- controles e atualização ----------
function bindSeg(id, onChange) {
  $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  }));
}
bindSeg('f-metrica', (v) => { ui.metrica = v; renderChart(); });
bindSeg('f-eixo', (v) => { ui.eixo = v; renderChart(); });
bindSeg('f-ano-reg', (v) => { ui.anoReg = v; refreshRegions(); });

// Em caso de erro de rede, mantém os últimos dados bons na tela (só marca como desatualizado).
let liveVelho = false;
async function refreshLive() {
  try { live = await getJson('/api/live'); liveVelho = false; } catch { liveVelho = !!live; }
  renderLive();
}
async function refreshTimeline() {
  try {
    const antes = timeline?.series.map((s) => s.id).join();
    timeline = await getJson('/api/timeline');
    if (timeline.series.map((s) => s.id).join() !== antes) renderAnos();
    renderChart();
  } catch (e) { console.error(e); }
}
async function refreshRegions() {
  const ano = ui.anoReg;
  try {
    const r = await getJson(`/api/regions?ano=${ano}`);
    if (ano !== ui.anoReg) return; // resposta atrasada de um ano que não está mais selecionado
    regions = r;
  } catch (e) {
    if (ano !== ui.anoReg) return;
    if (String(e.message).startsWith('404')) regions = null; // dados inexistentes para o ano
  }
  renderRegions();
}

refreshLive(); refreshTimeline(); refreshRegions();
setInterval(refreshLive, 10000);
setInterval(refreshTimeline, 30000);
setInterval(() => { if (ui.anoReg === '2026') refreshRegions(); }, 30000);
window.addEventListener('resize', () => renderChart());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderChart(); });

// ---------- exterior por país ----------
const extUi = { modo: 'turnos', ano: '2026', busca: '', abertos: new Set() };
let ext = null;

const sinal = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + NF.format(Math.abs(v));
const deltaVotos = (a, b) => {
  if (!a && !b) return '<span class="vazio">–</span>';
  const d = b - a;
  const rel = a ? `<span class="sub">${d >= 0 ? '+' : '−'}${Math.abs((100 * d) / a).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%</span>` : '';
  return `<span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${sinal(d)}</span>${rel}`;
};
const share = (r) => (r.left + r.right ? (100 * r.left) / (r.left + r.right) : null);
const minibar = (r) => {
  const s = share(r);
  if (s === null) return '<span class="vazio">–</span>';
  return `<span class="minibar" role="img" aria-label="${pct(s, 1)} esquerda"><i class="l" style="width:${s}%"></i><i class="r" style="width:${100 - s}%"></i></span>${pct(s, 0)}`;
};
const votosCel = (r, side) => (r.vv ? `${NF.format(r[side])}<span class="sub">${pct((100 * r[side]) / r.vv, 1)}</span>` : '<span class="vazio">–</span>');

// Só entram na tabela países/cidades que já têm dado na visão atual.
function temDado(r) {
  if (extUi.modo === 'anos') return ['2018', '2022', '2026'].some((a) => r[`a${a}`]?.t2.vv > 0);
  if (extUi.ano === '2026') return r.a2026.t2.vv > 0;
  const a = r[`a${extUi.ano}`];
  return a.t1.vv + a.t2.vv > 0;
}

function extRows() {
  const q = extUi.busca.trim().toLowerCase();
  const comDado = ext.paises.filter(temDado);
  if (!q) return comDado;
  return comDado.filter((p) => p.nome.toLowerCase().includes(q) || p.cidades.some((c) => temDado(c) && c.nome.toLowerCase().includes(q)));
}

// Linha final discreta: quantos países ainda não têm nenhum boletim nesta visão.
function linhaAguardando(colunas) {
  const n = ext.paises.filter((p) => !temDado(p)).length;
  if (!n) return '';
  const quando = extUi.modo === 'turnos' && extUi.ano === '2026' ? 'aguardando os primeiros boletins do 2º turno' : 'sem dados nesta visão';
  return `<tr class="aguardando"><td colspan="${colunas}">+ ${NF.format(n)} ${n === 1 ? 'país' : 'países'} ${quando} — aparecem aqui assim que chegar o primeiro boletim</td></tr>`;
}

function renderExterior() {
  if (!ext) {
    $('ext-sub').textContent = 'Boletins de urna do exterior ainda não coletados — o coletor está baixando.';
    return;
  }
  const c26 = ext.candidatos['2026'];
  const L26 = curto(c26.left.nome), R26 = curto(c26.right.nome);
  const t = ext.total;
  const parcial = t.secoes.comBU < t.secoes.total;
  $('ext-sub').textContent = `Boletins de urna publicados pelo TSE seção a seção (2026) — ${NF.format(t.secoes.comBU)} de ${NF.format(t.secoes.total)} seções`
    + (ext.tse ? ` · lista do TSE de ${ext.tse.dg} ${ext.tse.hg}` : '') + (ext.atualizado ? ` · coletado ${new Date(ext.atualizado).toLocaleTimeString('pt-BR')}` : '');

  const m = t.a2026;
  const c22 = ext.candidatos['2022'];
  $('ext-resumo').innerHTML = `
    <div class="tile-stat"><div class="k">Seções com boletim</div><div class="v">${pct((100 * t.secoes.comBU) / (t.secoes.total || 1), 0)}</div>
      <div class="d">${NF.format(t.secoes.comBU)} de ${NF.format(t.secoes.total)}${parcial ? ' · parcial' : ''}</div></div>
    <div class="tile-stat left"><div class="k">${esc(L26)} · 2º turno</div><div class="v">${pct(share(m.t2), 1)}</div>
      <div class="d">${NF.format(m.t2.left)} votos · ${sinal(m.t2.left - m.t1mesmas.left)} vs 1º turno*</div></div>
    <div class="tile-stat right"><div class="k">${esc(R26)} · 2º turno</div><div class="v">${share(m.t2) === null ? '–' : pct(100 - share(m.t2), 1)}</div>
      <div class="d">${NF.format(m.t2.right)} votos · ${sinal(m.t2.right - m.t1mesmas.right)} vs 1º turno*</div></div>
    <div class="tile-stat"><div class="k">Exterior 2022 · 2º turno (esquerda)</div><div class="v">${t.a2022.t2.vv ? pct(share(t.a2022.t2), 1) : '–'}</div>
      <div class="d">${c22 ? `${esc(curto(c22.left.nome))} ${NF.format(t.a2022.t2.left)} × ${esc(curto(c22.right.nome))} ${NF.format(t.a2022.t2.right)}` : 'histórico indisponível'}</div></div>`;

  $('f-ext-ano').style.display = extUi.modo === 'turnos' ? '' : 'none';
  const rows = extRows();
  const tabela = $('tabela-ext');
  const totalRow = { nome: 'Total exterior', ...t, cidades: [] };
  if (extUi.modo === 'turnos') {
    const ano = extUi.ano;
    const cand = ext.candidatos[ano];
    if (!cand) {
      tabela.innerHTML = '<tr><td>Histórico deste ano ainda não disponível.</td></tr>';
      $('ext-nota').textContent = '';
      return;
    }
    const L = curto(cand.left.nome), R = curto(cand.right.nome);
    const dados = (r) => {
      const a = r[`a${ano}`];
      return ano === '2026' ? { t1: a.t1mesmas, t2: a.t2, t1full: a.t1 } : { t1: a.t1, t2: a.t2 };
    };
    const linha = (r, cls, label) => {
      const d = dados(r);
      const sec = ano === '2026' ? `<td>${NF.format(r.secoes.comBU)}/${NF.format(r.secoes.total)}</td>` : '';
      if (ano === '2026' && !d.t2.vv) {
        return `<tr class="${cls}" data-pais="${esc(r.nome)}"><td>${label}</td>${sec}<td colspan="7" class="vazio">aguardando boletins · 1º turno: ${esc(L)} ${NF.format(d.t1full.left)} × ${esc(R)} ${NF.format(d.t1full.right)}</td></tr>`;
      }
      return `<tr class="${cls}" data-pais="${esc(r.nome)}"><td>${label}</td>${sec}
        <td>${votosCel(d.t1, 'left')}</td><td>${votosCel(d.t2, 'left')}</td><td>${deltaVotos(d.t1.left, d.t2.left)}</td>
        <td>${votosCel(d.t1, 'right')}</td><td>${votosCel(d.t2, 'right')}</td><td>${deltaVotos(d.t1.right, d.t2.right)}</td>
        <td>${minibar(d.t2)}</td></tr>`;
    };
    tabela.innerHTML = `<thead><tr><th>País</th>${ano === '2026' ? '<th>Seções</th>' : ''}
      <th><span class="sw" style="background:var(--left)"></span>${esc(L)} 1º</th><th>2º</th><th>Δ votos</th>
      <th><span class="sw" style="background:var(--right)"></span>${esc(R)} 1º</th><th>2º</th><th>Δ votos</th>
      <th>2º turno (${esc(L)} × ${esc(R)})</th></tr></thead><tbody>
      ${linha(totalRow, '', '<b>Total exterior</b>')}
      ${rows.map((p) => paisLinhas(p, linha)).join('')}
      ${linhaAguardando(ano === '2026' ? 9 : 8)}</tbody>`;
    $('ext-nota').textContent = ano === '2026'
      ? `* 2026: o 1º turno é somado só nas seções que já têm boletim do 2º turno, para comparar as mesmas urnas. "Δ votos" = votos no 2º turno − votos no 1º turno. Clique num país para ver as cidades.`
      : `"Δ votos" = votos no 2º turno − votos no 1º turno. Clique num país para ver as cidades.`;
  } else {
    const anos = ['2018', '2022', '2026'].filter((a) => ext.candidatos[a]);
    const linha = (r, cls, label) => {
      const s22 = share(r.a2022.t2), s26 = share(r.a2026.t2);
      // Diferença de votos só faz sentido com todas as seções do país apuradas.
      const completo = r.secoes.total > 0 && r.secoes.comBU >= r.secoes.total;
      const aguarde = `<span class="vazio">${r.secoes.comBU ? `parcial (${NF.format(r.secoes.comBU)}/${NF.format(r.secoes.total)})` : '–'}</span>`;
      return `<tr class="${cls}" data-pais="${esc(r.nome)}"><td>${label}</td>
        ${anos.map((a) => `<td>${minibar(r[`a${a}`].t2)}</td>`).join('')}
        <td>${s22 !== null && s26 !== null ? pp(s26 - s22) : '<span class="vazio">–</span>'}</td>
        <td>${completo ? deltaVotos(r.a2022.t2.left, r.a2026.t2.left) : aguarde}</td>
        <td>${completo ? deltaVotos(r.a2022.t2.right, r.a2026.t2.right) : aguarde}</td></tr>`;
    };
    tabela.innerHTML = `<thead><tr><th>País</th>${anos.map((a) => `<th>${a} · 2º turno<span class="sub">${esc(curto(ext.candidatos[a].left.nome))} × ${esc(curto(ext.candidatos[a].right.nome))}</span></th>`).join('')}
      <th>Δ esquerda<span class="sub">2022→2026</span></th><th>Δ votos esq.<span class="sub">2022→2026</span></th><th>Δ votos dir.<span class="sub">2022→2026</span></th></tr></thead><tbody>
      ${linha(totalRow, '', '<b>Total exterior</b>')}
      ${rows.map((p) => paisLinhas(p, linha)).join('')}
      ${linhaAguardando(anos.length + 4)}</tbody>`;
    $('ext-nota').textContent = `Barras: fatia da esquerda na disputa a dois do 2º turno. Esquerda: Haddad (2018) e Lula (2022, 2026); direita: Jair Bolsonaro (2018, 2022) e Flávio Bolsonaro (2026). Com a apuração de 2026 parcial, as diferenças de votos ainda vão mudar.`;
  }
  if (ext.notas) {
    $('ext-nota').insertAdjacentHTML('beforeend', `<details><summary>Como os dados do exterior foram montados</summary><p>${esc(ext.notas)}</p></details>`);
  }
  tabela.querySelectorAll('tr.pais').forEach((tr) => tr.addEventListener('click', () => {
    const n = tr.dataset.pais;
    extUi.abertos.has(n) ? extUi.abertos.delete(n) : extUi.abertos.add(n);
    renderExterior();
  }));
}

function paisLinhas(p, linha) {
  const q = extUi.busca.trim().toLowerCase();
  const cidades = p.cidades.filter(temDado); // cidades sem boletim também ficam ocultas
  const aberto = extUi.abertos.has(p.nome) || (q && cidades.some((c) => c.nome.toLowerCase().includes(q)));
  const multi = cidades.length > 1 || (cidades[0] && cidades[0].nome !== p.nome);
  const label = `<span class="seta">${multi ? (aberto ? '▾' : '▸') : ''}</span>${esc(p.nome)}${p.mapeado ? '' : '<span class="sub">país não mapeado</span>'}`;
  let html = linha(p, multi ? 'pais' : '', label);
  if (aberto && multi) html += cidades.map((c) => linha(c, 'cidade', esc(nome(c.nome)))).join('');
  return html;
}

bindSeg('f-ext-modo', (v) => { extUi.modo = v; renderExterior(); });
bindSeg('f-ext-ano', (v) => { extUi.ano = v; renderExterior(); });
$('ext-busca').addEventListener('input', (e) => { extUi.busca = e.target.value; renderExterior(); });

async function refreshExterior() {
  try { ext = await getJson('/api/exterior'); } catch (e) { if (String(e.message).startsWith('404')) ext = null; }
  renderExterior();
}
refreshExterior();
setInterval(refreshExterior, 30000);

// ---------- apuração e abstenção por região ----------
let abst = null;
const variacao = (v) => (v === null || v === undefined || Number.isNaN(v) ? '<span class="vazio">–</span>'
  : `<span class="${v > 0.05 ? 'up' : v < -0.05 ? 'down' : ''}">${pp(v)}</span>`);
const milhoes = (v) => `${(v / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mi`;
const subiu = (v) => (v === null || v === undefined ? '' : v > 0.05 ? 'aumentou' : v < -0.05 ? 'diminuiu' : 'estável');

function linhaAbst(r, cls = '') {
  return `<tr class="${cls}"><td>${esc(r.nome)}</td>
    <td><span class="mbar" aria-hidden="true"><i style="width:${Math.min(100, r.apurado)}%"></i></span>${pct(r.apurado, 1)}</td>
    <td>${r.apurado2022 === null ? '–' : pct(r.apurado2022, 1)}</td>
    <td>${r.taxa === null ? '<span class="vazio">–</span>' : pct(r.taxa, 1)}${r.aptos ? `<span class="sub">${NF.format(r.abst)}</span>` : ''}</td>
    <td>${variacao(r.taxa !== null && r.t1 !== null ? r.taxa - r.t1 : null)}<span class="sub">1º turno: ${pct(r.t1 ?? r.t1Final, 1)}</span></td>
    <td>${variacao(r.taxa !== null && r.a2022t2 !== null ? r.taxa - r.a2022t2 : null)}<span class="sub">2022: ${pct(r.a2022t2 ?? r.a2022t2Final, 1)}</span></td></tr>`;
}

function renderAbstencao() {
  if (!abst) { $('abst-sub').textContent = 'Dados indisponíveis.'; return; }
  const b = abst.br, a = abst;
  const d1 = b.taxa !== null && b.t1 !== null ? b.taxa - b.t1 : null;
  const d22 = b.taxa !== null && b.a2022t2 !== null ? b.taxa - b.a2022t2 : null;
  const hora = (a.totalizacao ?? '').slice(11, 16);
  $('abst-sub').textContent = a.parcial
    ? `Quanto de cada região já foi apurado e quantos eleitores deixaram de votar nas seções apuradas, comparado com o 1º turno e com 2022.${hora ? ` Dados do TSE das ${hora}.` : ''}`
    : 'Apuração concluída: abstenção final do 2º turno, comparada com o 1º turno e com 2022.';
  $('abst-resumo').innerHTML = `
    <div class="tile-stat"><div class="k">Seções apuradas</div><div class="v">${pct(b.apurado, 1)}</div>
      <div class="d">${b.apurado2022 === null ? '' : `2022 no mesmo horário: ${pct(b.apurado2022, 1)}`}</div></div>
    <div class="tile-stat"><div class="k">Abstenção${a.parcial ? ' até agora' : ''}</div><div class="v">${b.taxa === null ? '–' : pct(b.taxa, 1)}</div>
      <div class="d">${b.aptos ? `${NF.format(b.abst)} eleitores${a.parcial ? ` · total estimado ~${milhoes(a.estimativaAbst)}` : ''}` : 'aguardando seções apuradas'}</div></div>
    <div class="tile-stat"><div class="k">vs 1º turno 2026</div><div class="v">${d1 === null ? '–' : pp(d1)}</div>
      <div class="d">${d1 === null ? `1º turno: ${pct(b.t1Final, 1)} (${milhoes(b.t1Abst)})` : `${subiu(d1)} · 1º turno: ${pct(b.t1, 1)}${a.parcial ? ' nas mesmas UFs' : ''}`}</div></div>
    <div class="tile-stat"><div class="k">vs 2022 · 2º turno</div><div class="v">${d22 === null ? '–' : pp(d22)}</div>
      <div class="d">${d22 === null ? `2022: ${pct(b.a2022t2Final, 1)}` : `${subiu(d22)} · 2022: ${pct(b.a2022t2, 1)}${a.parcial ? ' nas mesmas UFs' : ''}`}</div></div>`;

  const head = `<thead><tr><th>Região</th><th>Apurado</th><th>2022<span class="sub">mesmo horário</span></th><th>Abstenção<span class="sub">seções apuradas</span></th>
    <th>vs 1º turno</th><th>vs 2022<span class="sub">2º turno</span></th></tr></thead>`;
  $('tabela-abst').innerHTML = `${head}<tbody>${a.regioes.map((r) => linhaAbst(r)).join('')}${linhaAbst(b, 'total')}</tbody>`;
  $('tabela-abst-ufs').innerHTML = `${head.replace('Região', 'UF')}<tbody>${a.ufs.map((r) => linhaAbst({ ...r, nome: r.id === 'zz' ? 'Exterior' : r.nome })).join('')}</tbody>`;

  // Esquerda × direita por região: 2º turno até agora contra o 1º turno e contra 2022.
  const cn = a.candidatos;
  const L = curto(cn.left), R = curto(cn.right), L22 = curto(cn.left2022), R22 = curto(cn.right2022);
  const par = (v, l, r) => (v ? `<span class="par"><span class="sw" style="background:var(--left)"></span>${esc(l)} ${pct(v.left, 1)}</span>
    <span class="par"><span class="sw" style="background:var(--right)"></span>${esc(r)} ${pct(v.right, 1)}</span>` : '<span class="vazio">–</span>');
  // No 2º turno os dois sobem em relação ao 1º (herdam votos): o que importa é quem subiu mais.
  const vsT1 = (v) => {
    if (!v.t2 || !v.t1) return '<span class="vazio">–</span>';
    const dl = v.t2.left - v.t1.left, dr = v.t2.right - v.t1.right;
    const quem = Math.abs(dl - dr) < 0.05 ? 'empate' : dl > dr ? `${esc(L)} cresceu mais` : `${esc(R)} cresceu mais`;
    return `<span class="par"><span class="sw" style="background:var(--left)"></span>${variacao(dl)}</span>
      <span class="par"><span class="sw" style="background:var(--right)"></span>${variacao(dr)}</span><span class="sub">${quem}</span>`;
  };
  // Contra o 2º turno de 2022 a disputa é a dois: o que um ganha, o outro perde.
  const vs22 = (v) => {
    if (!v.t2 || !v.a2022t2) return '<span class="vazio">–</span>';
    const d = v.t2.left - v.a2022t2.left;
    if (Math.abs(d) < 0.05) return 'estável';
    const lado = d > 0 ? 'left' : 'right';
    return `<span class="par"><span class="sw" style="background:var(--${lado})"></span><b>${d > 0 ? 'esquerda' : 'direita'}</b> <span class="up">${pp(Math.abs(d))}</span></span>
      <span class="sub">${d > 0 ? esc(R) : esc(L)} cai ${pp(Math.abs(d)).slice(1)}</span>`;
  };
  const headVotos = (first) => `<thead><tr><th>${first}</th><th>2º turno 2026<span class="sub">${a.parcial ? 'até agora' : 'resultado'}</span></th>
    <th>1º turno 2026<span class="sub">votos válidos</span></th><th>vs 1º turno<span class="sub">quem subiu mais</span></th>
    <th>2º turno 2022</th><th>vs 2022<span class="sub">quem cresce</span></th><th>1º turno 2022</th></tr></thead>`;
  const linhaVotos = (r, cls = '') => `<tr class="${cls}"><td>${esc(r.nome)}</td>
    <td>${r.votos.t2 ? `<span class="minibar" aria-hidden="true"><i class="l" style="width:${r.votos.t2.left}%"></i><i class="r" style="width:${r.votos.t2.right}%"></i></span>` : ''}${par(r.votos.t2, L, R)}</td>
    <td>${par(r.votos.t1, L, R)}</td><td>${vsT1(r.votos)}</td>
    <td>${par(r.votos.a2022t2, L22, R22)}</td><td>${vs22(r.votos)}</td><td>${par(r.votos.a2022t1, L22, R22)}</td></tr>`;
  $('votos-sub').textContent = `Fatia dos votos válidos de ${L} (esquerda) e ${R} (direita), comparada com o 1º turno e com 2022 (${L22} × ${R22}).`
    + (a.parcial ? ' Com a apuração parcial, o 1º turno e 2022 entram com o mesmo peso de cada UF no que já foi apurado.' : '');
  $('tabela-votos').innerHTML = `${headVotos('Região')}<tbody>${a.regioes.map((r) => linhaVotos(r)).join('')}${linhaVotos(b, 'total')}</tbody>`;
  $('tabela-votos-ufs').innerHTML = `${headVotos('UF')}<tbody>${a.ufs.map((r) => linhaVotos({ ...r, nome: r.id === 'zz' ? 'Exterior' : r.nome })).join('')}</tbody>`;

  // Totais de cada turno; o 2º turno de 2026 usa a estimativa enquanto a apuração não termina.
  const hist = [];
  for (const ano of [2018, 2022]) {
    const h = a.historico[ano];
    if (h) hist.push({ nome: `${ano} · 1º turno`, ...h.t1 }, { nome: `${ano} · 2º turno`, ...h.t2 });
  }
  hist.push({ nome: '2026 · 1º turno', ...a.t1_2026 });
  hist.push(a.parcial
    ? { nome: '2026 · 2º turno', abst: a.estimativaAbst, aptos: a.eleitorado, estimado: true }
    : { nome: '2026 · 2º turno', abst: b.abst, aptos: b.aptos });
  $('tabela-abst-hist').innerHTML = `<thead><tr><th>Turno</th><th>Abstenções</th><th>Eleitorado</th><th>Taxa</th><th>vs turno anterior</th></tr></thead><tbody>
    ${hist.map((h, i) => {
      const taxa = h.aptos ? (100 * h.abst) / h.aptos : null;
      const ant = hist[i - 1];
      const dif = ant && ant.aptos && taxa !== null ? taxa - (100 * ant.abst) / ant.aptos : null;
      return `<tr><td>${esc(h.nome)}${h.estimado ? '<span class="sub">estimativa, apuração parcial</span>' : ''}</td>
        <td>${h.estimado ? '~' : ''}${NF.format(h.abst)}</td><td>${NF.format(h.aptos)}</td><td>${pct(taxa, 2)}</td>
        <td>${variacao(dif)}${ant ? `<span class="sub">${h.abst >= ant.abst ? '+' : '−'}${NF.format(Math.abs(h.abst - ant.abst))}</span>` : ''}</td></tr>`;
    }).join('')}</tbody>`;

  $('abst-nota').innerHTML = 'Abstenção = eleitores aptos que não compareceram. Durante a apuração, ela só é conhecida nas seções já totalizadas, e as regiões apuram em ritmos diferentes. '
    + 'Por isso, as comparações usam o 1º turno e 2022 <b>com o mesmo peso de cada UF</b> no que já foi apurado; no fim da apuração, viram as taxas finais. '
    + 'O total estimado aplica, nas UFs ainda sem seções apuradas, a taxa do 1º turno corrigida pela variação observada. '
    + '“2022 no mesmo horário” é o % de seções apuradas no 2º turno de 2022 no mesmo horário de Brasília. O TSE não publica a evolução da apuração do 1º turno de 2026, por isso essa comparação é só com 2022. '
    + 'Fonte: TSE (resultados ao vivo e dados abertos: detalhe_votacao_munzona 2018 e 2022).';
}

async function refreshAbstencao() {
  try { abst = await getJson('/api/abstencao'); } catch (e) { if (String(e.message).startsWith('404')) abst = null; }
  renderAbstencao();
}
refreshAbstencao();
setInterval(refreshAbstencao, 30000);

// ---------- o que cada um precisa para vencer ----------
let cam = null;
const ORDEM_REG = ['SE', 'NE', 'S', 'NCO', 'EX'];
const p100 = (v, d = 1) => (v === null || v === undefined ? '–' : pct(100 * v, d));

function renderCaminho() {
  if (!cam) { $('cam-sub').textContent = 'Dados indisponíveis.'; return; }
  const nomes = { left: curto(cam.candidatos.left.nome), right: curto(cam.candidatos.right.nome) };
  const c = cam.cenarios, av = cam.aoVivo;
  const partes = [];

  if (av && av.precisaNacional === null) {
    partes.push('<p><b>Apuração concluída</b> (ou praticamente): não há mais votos relevantes a apurar.</p>');
  } else if (av) {
    const atras = nomes[av.atras], lider = nomes[av.atras === 'left' ? 'right' : 'left'];
    const precisa = av.precisaNacional;
    // "Faltam" é uma estimativa do modelo, não um limite: por isso nunca dizemos "matematicamente".
    partes.push(`<p><b>Durante a apuração:</b> pela projeção atual, <b>${esc(atras)}</b> está atrás. Para virar, precisaria de
      <b>${precisa > 1 ? 'mais de 100%' : p100(precisa)}</b> dos votos válidos que ainda faltam apurar
      (estimados em ~${NF.format(Math.round(av.faltam / 1e5) / 10)} milhões); o modelo projeta ${p100(av.projecaoNacional)} para ele nesses votos.
      ${precisa > 1 ? `Pela projeção, ${esc(lider)} já não deve ser alcançado.` : ''}</p>`);
  }

  if (c) {
    const atrasK = c.lider === 'left' ? 'right' : 'left';
    const lider = nomes[c.lider], atras = nomes[atrasK];
    const votos = Math.round((c.gap * cam.totalVV) / 1e5) / 10;
    const regs = ORDEM_REG.filter((r) => c.porRegiao[r] && r !== 'EX');
    const porNecessidade = [...regs].sort((a, b) => (c.porRegiao[a].atras.precisa - c.porRegiao[a].atras.atual) - (c.porRegiao[b].atras.precisa - c.porRegiao[b].atras.atual));
    partes.push(`<p><b>Pelas pesquisas</b> (média de ${cam.pesquisas.lista.length} pesquisas desde o 1º turno, com mais peso para as mais recentes),
      <b>${esc(lider)}</b> teria <b>${p100(c.lider === 'left' ? c.nacional : 1 - c.nacional)}</b> dos votos válidos.</p>
      <div class="cam-cols">
        <div><h3><span class="sw" style="background:var(--${atrasK})"></span>${esc(atras)} precisa</h3>
          <ul>
            <li>tirar <b>${pp(100 * c.gap)}</b> de ${esc(lider)} em <b>todas</b> as regiões (cerca de ${NF.format(votos)} milhão${votos >= 2 ? 'ões' : ''} de votos mudando de lado), <i>ou</i>, se a virada viesse de uma região só:</li>
            ${porNecessidade.map((r) => {
              const x = c.porRegiao[r];
              return `<li><b>${esc(cam.regioes[r])}</b>: ${x.atras.viavel ? `subir de ${p100(x.atras.atual)} para <b>${p100(x.atras.precisa)}</b> (${pp(100 * (x.atras.precisa - x.atras.atual))})` : '<i>não basta sozinha</i> (precisaria de mais de 100%)'}</li>`;
            }).join('')}
          </ul></div>
        <div><h3><span class="sw" style="background:var(--${c.lider})"></span>${esc(lider)} vence se mantiver</h3>
          <ul>
            ${regs.map((r) => {
              const x = c.porRegiao[r];
              return `<li><b>${esc(cam.regioes[r])}</b>: pelo menos <b>${p100(x.lider.piso)}</b> (pesquisas: ${p100(x.lider.atual)}; 1º turno: ${p100(c.lider === 'left' ? cam.t1[r] : 1 - cam.t1[r])})</li>`;
            }).join('')}
            <li class="muted">Cada piso supõe as demais regiões iguais à média das pesquisas.</li>
          </ul></div>
      </div>`);
  } else if (!cam.pesquisas) {
    partes.push('<p class="muted">Pesquisas do 2º turno ainda não carregadas.</p>');
  }
  $('cam-texto').innerHTML = partes.join('');
  $('cam-sub').textContent = av
    ? 'Atualizado em tempo real com a apuração. Antes da apuração, a estimativa vem das pesquisas.'
    : 'Estimativa pelas pesquisas eleitorais do 2º turno, com mais peso para as mais recentes. Durante a apuração, passa a usar os votos apurados.';

  // Tabela por região
  const L = nomes.left;
  const head = `<tr><th>Região</th><th>Peso nos votos</th><th>${esc(L)} no 1º turno<span class="sub">disputa a dois</span></th>
    <th>${esc(L)} nas pesquisas</th><th>Δ vs 1º turno</th>
    ${c ? `<th>${esc(nomes[c.lider === 'left' ? 'right' : 'left'])} precisaria<span class="sub">só nesta região</span></th><th>Piso de ${esc(nomes[c.lider])}</th>` : ''}
    ${av ? `<th>Apurado</th><th>${esc(L)} até agora</th><th>${esc(nomes[av.atras])} precisa<span class="sub">do que falta</span></th>` : ''}</tr>`;
  const rows = ORDEM_REG.map((r) => {
    const pq = r === 'EX' ? cam.exteriorShare : cam.pesquisas?.regioes?.[r];
    const x = c?.porRegiao?.[r];
    const v = av?.porRegiao?.[r];
    const leftAgora = v && v.contado ? (av.atras === 'left' ? v.contadoAtras / v.contado : 1 - v.contadoAtras / v.contado) : null;
    return `<tr><td>${esc(cam.regioes[r])}${r === 'EX' ? '<span class="sub">boletins de urna</span>' : ''}</td>
      <td>${pct(100 * cam.pesos[r], 1)}</td><td>${p100(cam.t1[r])}</td>
      <td>${p100(pq)}</td><td>${pq !== null && pq !== undefined ? pp(100 * (pq - cam.t1[r])) : '–'}</td>
      ${c ? `<td>${x && r !== 'EX' ? (x.atras.viavel ? p100(x.atras.precisa) : '>100%') : '–'}</td><td>${x && r !== 'EX' ? p100(x.lider.piso) : '–'}</td>` : ''}
      ${av ? `<td>${v ? pct(v.pctApurado, 0) : '–'}</td><td>${p100(leftAgora)}</td><td>${v && v.precisa !== null ? (v.precisa > 1 ? '>100%' : v.precisa < 0 ? 'já garantido' : p100(v.precisa)) : '–'}</td>` : ''}
    </tr>`;
  }).join('');
  $('tabela-cam').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;

  if (cam.pesquisas) {
    $('cam-pesquisas').innerHTML = `<table class="tabela"><thead><tr><th>Instituto</th><th>Campo até</th><th>Amostra</th><th>${esc(L)} (válidos)</th>
      ${ORDEM_REG.filter((r) => r !== 'EX').map((r) => `<th>${esc(L)} ${r}</th>`).join('')}<th>Peso</th></tr></thead><tbody>
      ${cam.pesquisas.lista.map((p) => `<tr><td>${esc(p.instituto)}${p.contratante ? `<span class="sub">${esc(p.contratante)}</span>` : ''}${p.registro ? `<span class="sub">${esc(p.registro)}</span>` : ''}</td>
        <td>${esc(p.campo_fim ?? '–')}</td><td>${p.amostra ? NF.format(p.amostra) : '–'}</td><td>${p100(p.nacional)}</td>
        ${ORDEM_REG.filter((r) => r !== 'EX').map((r) => `<td>${p100(p.regioes[r])}</td>`).join('')}
        <td>${pct(p.pesoPct, 0)}</td></tr>`).join('')}</tbody></table>`;
  }
  $('cam-nota').innerHTML = 'Fatias na disputa a dois (sem brancos, nulos e indecisos). Peso de cada pesquisa: cai pela metade a cada 4 dias desde o fim do campo e cresce com a raiz da amostra. '
    + 'Pesquisas não cobrem o exterior; para ele usamos os boletins de urna já publicados.'
    + (cam.notasPesquisas ? `<details><summary>Notas sobre as pesquisas</summary><p>${esc(cam.notasPesquisas)}</p></details>` : '');
}

async function refreshCaminho() {
  try { cam = await getJson('/api/caminho'); } catch (e) { if (String(e.message).startsWith('404')) cam = null; }
  renderCaminho();
}
refreshCaminho();
setInterval(refreshCaminho, 30000);

// ---------- mercados de previsão ----------
let mercados = null;
const MERC_SERIES = [
  { k: 'kalshi', nome: 'Kalshi', cor: 'var(--serie-kalshi)', dash: '' },
  { k: 'polymarket', nome: 'Polymarket', cor: 'var(--serie-poly)', dash: '' },
  { k: 'modelo', nome: 'Modelo do painel', cor: 'var(--ink-2)', dash: '5 4' },
];

// Normaliza para a disputa a dois (os dois "Sim" nem sempre somam 100%).
const doisLados = (l, f) => (Number.isFinite(l) && Number.isFinite(f) && l + f > 0 ? l / (l + f) : Number.isFinite(l) ? l : null);

function renderMercados() {
  const L = curto(live?.left?.nome ?? 'LULA'), R = curto(live?.right?.nome ?? 'FLAVIO BOLSONARO');
  const cartao = (titulo, pL, sub, erro) => {
    if (erro || pL === null || pL === undefined) {
      return `<div class="merc-card"><div class="merc-nome">${esc(titulo)}</div><div class="merc-indisp">indisponível</div><div class="merc-sub">${esc(erro ?? 'sem dados')}</div></div>`;
    }
    return `<div class="merc-card"><div class="merc-nome">${esc(titulo)}</div>
      <div class="merc-nums"><span><b>${pct(100 * pL, 0)}</b> ${esc(L)}</span><span>${esc(R)} <b>${pct(100 - 100 * pL, 0)}</b></span></div>
      <div class="split merc-split" role="img" aria-label="${esc(titulo)}: ${esc(L)} ${pct(100 * pL, 0)}, ${esc(R)} ${pct(100 - 100 * pL, 0)}">
        <div class="l" style="width:${100 * pL}%"></div><div class="r" style="width:${100 - 100 * pL}%"></div></div>
      <div class="merc-sub">${esc(sub)}</div></div>`;
  };
  const card = (k) => {
    const m = mercados?.[k];
    if (!m) return cartao(MERC_SERIES.find((s) => s.k === k).nome, null, '', mercados ? 'sem dados ainda' : 'carregando…');
    const pL = doisLados(m.lula?.p, m.flavio?.p);
    const bruto = [m.lula?.p, m.flavio?.p].every(Number.isFinite) ? `cotação: ${L} ${pct(100 * m.lula.p, 0)} · ${R} ${pct(100 * m.flavio.p, 0)}` : '';
    const hora = m.atualizado ? ` · ${new Date(m.atualizado).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
    return cartao(m.nome ?? k, pL, bruto + hora, m.erro && !Number.isFinite(pL) ? m.erro : null);
  };
  const pModelo = live?.pronto ? live.modelo.pLeft : null;
  $('mercados-cards').innerHTML = card('kalshi') + card('polymarket')
    + cartao('Modelo do painel', pModelo, live?.modelo?.frac > 0 ? `com ${pct(live.pctSecoes, 1)} apurado` : 'antes da apuração');
  renderMercadosChart();
}

function renderMercadosChart() {
  const svg = $('mercados-chart');
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W) return;
  // Séries: mercados (histórico coletado) e modelo (pontos da linha do tempo de 2026).
  const pts = { kalshi: [], polymarket: [], modelo: [] };
  for (const h of mercados?.historico ?? []) {
    for (const k of ['kalshi', 'polymarket']) {
      const p = doisLados(h[k]?.lula, h[k]?.flavio);
      if (p !== null) pts[k].push({ t: Date.parse(h.t), y: 100 * p });
    }
  }
  const s26 = timeline?.series.find((s) => s.aoVivo);
  for (const p of s26?.points ?? []) pts.modelo.push({ t: Date.parse(p.t), y: p.pLeft });
  const todas = Object.values(pts).flat();
  const legenda = MERC_SERIES.filter((s) => pts[s.k].length)
    .map((s) => `<span><svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="${s.cor}" stroke-width="2.5" stroke-dasharray="${s.dash}" stroke-linecap="round"/></svg>${esc(s.nome)}</span>`).join('');
  $('mercados-legenda').innerHTML = legenda ? `${legenda}<span class="muted">· chance de ${esc(curto(live?.left?.nome ?? 'LULA'))}</span>` : '';
  if (todas.length < 2) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">O gráfico aparece conforme as cotações forem chegando.</text>`;
    return;
  }
  const M = { l: 36, r: W < 520 ? 12 : 118, t: 10, b: 24 };
  let t0 = Math.min(...todas.map((p) => p.t)), t1 = Math.max(...todas.map((p) => p.t));
  if (t1 - t0 < 600000) t0 = t1 - 600000; // pelo menos 10 min de janela
  const sx = (t) => M.l + ((t - t0) / (t1 - t0)) * (W - M.l - M.r);
  const sy = (v) => M.t + ((100 - v) / 100) * (H - M.t - M.b);
  const parts = [];
  for (const v of [0, 25, 50, 75, 100]) {
    parts.push(`<line class="${v === 50 ? 'ref' : 'grid'}" x1="${M.l}" x2="${W - M.r}" y1="${sy(v)}" y2="${sy(v)}"/>`);
    parts.push(`<text x="${M.l - 6}" y="${sy(v) + 4}" text-anchor="end">${v}%</text>`);
  }
  const passo = (t1 - t0) > 4 * 3600000 ? 3600000 : (t1 - t0) > 3600000 ? 1800000 : 600000;
  for (let t = Math.ceil(t0 / passo) * passo; t <= t1; t += passo) {
    parts.push(`<text x="${sx(t)}" y="${H - 6}" text-anchor="middle">${hhmm(minutosBrt(new Date(t).toISOString()))}</text>`);
  }
  const rotulos = [];
  for (const s of MERC_SERIES) {
    const p = pts[s.k];
    if (!p.length) continue;
    const d = p.map((q, i) => `${i ? 'L' : 'M'}${sx(q.t).toFixed(1)},${sy(q.y).toFixed(1)}`).join('');
    parts.push(`<path d="${d}" fill="none" stroke="${s.cor}" stroke-width="2.5" stroke-dasharray="${s.dash}" stroke-linecap="round" stroke-linejoin="round"/>`);
    const u = p.at(-1);
    parts.push(`<circle cx="${sx(u.t)}" cy="${sy(u.y)}" r="4" fill="${s.cor}" stroke="var(--surface)" stroke-width="2"/>`);
    rotulos.push({ y: sy(u.y), x: sx(u.t), texto: `${s.nome.split(' ')[0]} ${pct(u.y, 0)}` });
  }
  // Rótulos diretos no fim das linhas, afastados para não se sobreporem.
  if (M.r > 60) {
    rotulos.sort((a, b) => a.y - b.y);
    for (let i = 1; i < rotulos.length; i++) if (rotulos[i].y - rotulos[i - 1].y < 14) rotulos[i].y = rotulos[i - 1].y + 14;
    for (const r of rotulos) parts.push(`<text class="lbl" x="${W - M.r + 8}" y="${r.y + 4}">${esc(r.texto)}</text>`);
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
}

async function refreshMercados() {
  try { mercados = await getJson('/api/mercados'); } catch (e) { if (String(e.message).startsWith('404')) mercados = null; }
  renderMercados();
}
refreshMercados();
setInterval(refreshMercados, 30000);
setInterval(renderMercados, 10000); // acompanha o modelo do painel, que muda a cada atualização
window.addEventListener('resize', renderMercadosChart);

// ---------- destaques e placar fixo (o essencial sempre em evidência) ----------
function mediaMercados() {
  if (typeof mercados === 'undefined' || !mercados) return null;
  const vals = ['kalshi', 'polymarket'].map((k) => {
    const m = mercados[k];
    const l = m?.lula?.p, f = m?.flavio?.p;
    return Number.isFinite(l) && Number.isFinite(f) && l + f > 0 ? { k, p: l / (l + f) } : null;
  }).filter(Boolean);
  return vals.length ? { media: vals.reduce((s, v) => s + v.p, 0) / vals.length, vals } : null;
}

function renderDestaques() {
  const el = $('destaques');
  if (!el || !live?.pronto) return;
  const L = curto(live.left.nome), R = curto(live.right.nome);
  const tile = (rotulo, valor, sub, cls = '') => `<div class="destaque ${cls}"><div class="d-rot">${rotulo}</div><div class="d-val">${valor}</div><div class="d-sub">${sub}</div></div>`;
  const tiles = [];

  // 1. Vantagem
  const dif = live.left.votos - live.right.votos;
  if (!live.votosValidos) tiles.push(tile('Vantagem', '–', 'aguardando os primeiros votos'));
  else {
    const quem = dif >= 0 ? L : R;
    tiles.push(tile(`Vantagem de ${esc(quem)}`, `${NF.format(Math.abs(dif))} votos`,
      `${pp(Math.abs(live.left.pct - live.right.pct), 2)} nos votos válidos`, dif >= 0 ? 'acento-left' : 'acento-right'));
  }

  // 2. Quanto falta
  const m = live.modelo;
  const faltam = Math.max(0, m.projLeft + m.projRight - live.left.votos - live.right.votos);
  tiles.push(tile('Falta apurar', pct(Math.max(0, 100 - live.pctSecoes), 1),
    live.pctSecoes >= 100 ? 'apuração concluída' : `das seções · ~${NF.format(Math.round(faltam / 1e5) / 10)} milhões de votos`));

  // 3. Comparação com 2022 no mesmo ponto
  const s22 = timeline?.series.find((s) => s.id === '2022');
  const p22 = live.pctSecoes > 0 ? s22?.points.find((p) => p.x >= live.pctSecoes - 0.05) : null;
  tiles.push(p22 && live.votosValidos
    ? tile('Lula em 2022, neste ponto', pct(p22.shareLeft, 1), `hoje: ${pct(live.left.pct, 1)} (${pp(live.left.pct - p22.shareLeft)})`)
    : tile('Comparação com 2022', '–', 'aparece quando a apuração avançar'));

  // 4. Mercados de previsão
  const mm = mediaMercados();
  tiles.push(mm
    ? tile('Mercados de previsão', `${esc(L)} ${pct(100 * mm.media, 0)}`, mm.vals.map((v) => `${v.k === 'kalshi' ? 'Kalshi' : 'Polymarket'} ${pct(100 * v.p, 0)}`).join(' · '))
    : tile('Mercados de previsão', '–', 'indisponíveis no momento'));

  el.innerHTML = tiles.join('');
}

function renderPlacarFixo() {
  const el = $('placar-fixo');
  if (!el || !live?.pronto) return;
  const L = esc(curto(live.left.nome)), R = esc(curto(live.right.nome));
  const pl = 100 * live.modelo.pLeft;
  const eleito = live.left.eleito ? L : live.right.eleito ? R : null;
  el.innerHTML = `<span class="pf-apur"><i></i>${pct(live.pctSecoes, 1)} apurado</span>
    <span class="pf-cand l">${L} <b>${pct(live.left.pct, 1)}</b></span>
    <span class="pf-cand r">${R} <b>${pct(live.right.pct, 1)}</b></span>
    <span class="pf-prob">${eleito ? `🏁 <b>${eleito} eleito</b>` : `chance: ${L} ${pct(pl, 0)} · ${R} ${pct(100 - pl, 0)}`}</span>`;
}

// O placar fixo aparece quando os cartões dos candidatos saem da tela.
const heroEl = document.querySelector('.hero');
if (heroEl && 'IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => {
    document.body.classList.toggle('placar-on', !e.isIntersecting && e.boundingClientRect.top < 0);
  }).observe(heroEl);
}

setInterval(renderDestaques, 5000); // pega mudanças da linha do tempo e dos mercados

// Troca de tema: redesenha o que usa cores calculadas em JavaScript.
window.addEventListener('temachange', () => {
  renderChart();
  if (typeof renderMercadosChart === 'function') renderMercadosChart();
});
