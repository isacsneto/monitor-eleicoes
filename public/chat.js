// Chat ao vivo e enquete "em quem você votou" (Server-Sent Events).
const $ = (id) => document.getElementById(id);
const NF = new Intl.NumberFormat('pt-BR');

// Um emoji por candidato (mesmas cores do painel).
const OPCOES = [
  { id: 'lula', emoji: '🔴', nome: 'Lula', cor: 'var(--left)' },
  { id: 'flavio', emoji: '🔵', nome: 'Flávio', cor: 'var(--right)' },
  { id: 'branco', emoji: '⚪', nome: 'Branco/Nulo', cor: 'var(--muted)' },
];
const EMOJI = Object.fromEntries(OPCOES.map((o) => [o.id, o.emoji]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
};
let clientId = store.get('chat-id');
if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  store.set('chat-id', clientId);
}
let meuVoto = store.get('chat-voto');
let naoLidas = 0;

$('chat-apelido').value = store.get('chat-apelido') ?? '';

function renderOpcoes() {
  $('enquete-opcoes').innerHTML = OPCOES.map((o) => `
    <button type="button" data-v="${o.id}" class="${meuVoto === o.id ? 'on' : ''}" aria-pressed="${meuVoto === o.id}">
      <span class="emo">${o.emoji}</span>${o.nome}</button>`).join('');
  $('enquete-opcoes').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => votar(b.dataset.v)));
}

function renderPlacar(p) {
  const total = OPCOES.reduce((s, o) => s + (p[o.id] ?? 0), 0);
  $('enquete-res').innerHTML = OPCOES.map((o) => {
    const v = p[o.id] ?? 0;
    const pc = total ? (100 * v) / total : 0;
    return `<div class="enq-linha"><span>${o.emoji} ${o.nome}</span>
      <span class="enq-barra"><i style="width:${pc}%;background:${o.cor}"></i></span>
      <span class="enq-num">${pc.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% <small>(${NF.format(v)})</small></span></div>`;
  }).join('') + `<div class="enq-total">${NF.format(total)} voto${total === 1 ? '' : 's'}</div>`;
}

function hora(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function addMsg(m) {
  const lista = $('chat-msgs');
  const noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 60;
  const li = document.createElement('li');
  li.dataset.id = m.id;
  const cab = document.createElement('div');
  cab.className = 'msg-cab';
  const nome = document.createElement('b');
  if (m.bot) {
    // Narrador automático: sempre identificado como robô.
    li.className = 'msg-bot';
    nome.textContent = `🤖 ${m.apelido} `;
    const selo = document.createElement('span');
    selo.className = 'selo-bot';
    selo.textContent = 'automático';
    nome.append(selo);
  } else {
    nome.textContent = `${m.voto ? EMOJI[m.voto] + ' ' : ''}${m.apelido}`;
  }
  const t = document.createElement('span');
  t.className = 'msg-hora';
  t.textContent = hora(m.t);
  cab.append(nome, t);
  const txt = document.createElement('div');
  txt.className = 'msg-txt';
  txt.textContent = m.texto; // nunca innerHTML: o texto vem de usuários
  li.append(cab, txt);
  lista.append(li);
  while (lista.children.length > 200) lista.firstChild.remove();
  if (noFim) lista.scrollTop = lista.scrollHeight;
  if (!document.body.classList.contains('chat-aberto') && getComputedStyle($('chat-toggle')).display !== 'none') {
    naoLidas++;
    $('chat-badge').textContent = naoLidas > 99 ? '99+' : String(naoLidas);
  }
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.erro ?? `erro ${r.status}`), { esperar: j.esperar });
  return j;
}

async function votar(v) {
  try {
    await post('/api/chat/voto', { clientId, voto: v });
    meuVoto = v;
    store.set('chat-voto', v);
    renderOpcoes();
    $('chat-erro').textContent = '';
  } catch (e) {
    $('chat-erro').textContent = e.message;
  }
}

$('chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const apelido = $('chat-apelido').value.trim();
  const texto = $('chat-texto').value.trim();
  if (!apelido || !texto) return;
  if (Date.now() < proximoEnvio) return;
  store.set('chat-apelido', apelido);
  const btn = $('chat-enviar');
  btn.disabled = true;
  try {
    await post('/api/chat/mensagem', { clientId, apelido, texto });
    $('chat-texto').value = '';
    $('chat-erro').textContent = '';
    esperar(INTERVALO_S);
  } catch (e) {
    $('chat-erro').textContent = e.message;
    if (e.esperar) esperar(e.esperar);
  } finally {
    if (Date.now() >= proximoEnvio) btn.disabled = false;
    $('chat-texto').focus();
  }
});

// Uma mensagem a cada 30 s (o servidor também impõe): contagem regressiva no botão.
const INTERVALO_S = 30;
let proximoEnvio = Number(store.get('chat-proximo') ?? 0);
let timerEnvio = null;
function esperar(segundos) {
  proximoEnvio = Date.now() + segundos * 1000;
  store.set('chat-proximo', String(proximoEnvio));
  tick();
}
function tick() {
  clearTimeout(timerEnvio);
  const btn = $('chat-enviar');
  const falta = Math.ceil((proximoEnvio - Date.now()) / 1000);
  if (falta > 0) {
    btn.disabled = true;
    btn.textContent = `${falta}s`;
    timerEnvio = setTimeout(tick, 1000);
  } else {
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}
tick();
$('chat-texto').addEventListener('input', () => {
  const n = $('chat-texto').value.length;
  $('chat-contador').textContent = n > 200 ? `${n}/280` : '';
});

function conectar() {
  const es = new EventSource('/api/chat/stream');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    $('chat-msgs').innerHTML = '';
    naoLidas = 0;
    d.mensagens.forEach(addMsg);
    naoLidas = 0;
    $('chat-badge').textContent = '';
    $('chat-msgs').scrollTop = $('chat-msgs').scrollHeight;
    renderPlacar(d.votos);
    $('chat-online').textContent = `· ${d.online} online`;
  });
  es.addEventListener('msg', (e) => addMsg(JSON.parse(e.data)));
  es.addEventListener('votos', (e) => renderPlacar(JSON.parse(e.data)));
  es.addEventListener('apagar', (e) => {
    for (const id of JSON.parse(e.data)) $('chat-msgs').querySelector(`li[data-id="${CSS.escape(id)}"]`)?.remove();
  });
  es.addEventListener('online', (e) => { $('chat-online').textContent = `· ${JSON.parse(e.data)} online`; });
  es.onerror = () => {
    $('chat-online').textContent = '· reconectando…';
    // Com resposta de erro (ex.: 502/503 durante um reinício) o navegador desiste: reconecta manualmente.
    if (es.readyState === EventSource.CLOSED) setTimeout(conectar, 5000 + Math.random() * 5000);
  };
  es.onopen = () => { $('chat-erro').textContent = ''; };
}

function abrir(sim) {
  document.body.classList.toggle('chat-aberto', sim);
  $('chat-toggle').setAttribute('aria-expanded', String(sim));
  if (sim) { naoLidas = 0; $('chat-badge').textContent = ''; }
}
$('chat-toggle').addEventListener('click', () => abrir(!document.body.classList.contains('chat-aberto')));
$('chat-fechar').addEventListener('click', () => abrir(false));

renderOpcoes();
renderPlacar({});
conectar();
