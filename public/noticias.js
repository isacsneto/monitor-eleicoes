// Últimas notícias da eleição (coluna à esquerda no desktop; seção compacta no celular).
const $ = (id) => document.getElementById(id);
const LARGA = matchMedia('(min-width: 1500px)');
const NO_CELULAR = 4; // itens visíveis antes do "ver mais" quando não é a coluna lateral

let dados = null;
let expandido = false;

function haQuanto(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `há ${h} h` : new Date(iso).toLocaleDateString('pt-BR');
}

function render() {
  const lista = $('noticias-lista');
  if (!dados?.itens?.length) {
    lista.innerHTML = '<li class="muted">Nenhuma notícia disponível no momento.</li>';
    $('noticias-mais').hidden = true;
    return;
  }
  const limite = LARGA.matches || expandido ? dados.itens.length : NO_CELULAR;
  lista.replaceChildren(...dados.itens.slice(0, limite).map((n) => {
    // Montado com textContent: manchetes vêm de feeds externos.
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = /^https?:\/\//.test(n.link) ? n.link : '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.textContent = n.titulo;
    const meta = document.createElement('div');
    meta.className = 'noticia-meta';
    meta.textContent = `${n.fonte} · ${haQuanto(n.data)}${n.outrasFontes ? ` · +${n.outrasFontes} veículo${n.outrasFontes > 1 ? 's' : ''}` : ''}`;
    li.append(a, meta);
    return li;
  }));
  const sobra = dados.itens.length - NO_CELULAR;
  $('noticias-mais').hidden = LARGA.matches || sobra <= 0;
  $('noticias-mais').textContent = expandido ? 'Mostrar menos' : `Ver mais ${sobra} notícias`;
  $('noticias-atualizado').textContent = dados.atualizado
    ? `atualizado ${new Date(dados.atualizado).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
}

async function atualizar() {
  try {
    const r = await fetch('/api/noticias', { cache: 'no-store' });
    if (r.ok) dados = await r.json();
  } catch { /* mantém as últimas */ }
  render();
}

$('noticias-mais').addEventListener('click', () => {
  expandido = !expandido;
  render();
  if (!expandido) $('noticias').scrollIntoView({ block: 'nearest' });
});
LARGA.addEventListener('change', render);
atualizar();
setInterval(atualizar, 120000);
setInterval(render, 60000); // atualiza os "há X min"
