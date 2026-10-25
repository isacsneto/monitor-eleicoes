// Tema claro (padrão) ou escuro, escolhido pelo visitante e lembrado neste aparelho.
// Carregado no <head> sem defer para aplicar o tema antes da primeira pintura (sem "piscar").
(function () {
  var salvo = null;
  try { salvo = localStorage.getItem('tema'); } catch (e) { /* sem armazenamento */ }
  var tema = salvo === 'escuro' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', tema);

  function rotulo(btn) {
    var escuro = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = escuro ? '☀️ Claro' : '🌙 Escuro';
    btn.setAttribute('aria-label', escuro ? 'Mudar para o tema claro' : 'Mudar para o tema escuro');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('tema-toggle');
    if (!btn) return;
    rotulo(btn);
    btn.addEventListener('click', function () {
      var escuro = document.documentElement.getAttribute('data-theme') !== 'dark';
      document.documentElement.setAttribute('data-theme', escuro ? 'dark' : 'light');
      try { localStorage.setItem('tema', escuro ? 'escuro' : 'claro'); } catch (e) { /* ok */ }
      rotulo(btn);
      window.dispatchEvent(new Event('temachange'));
    });
  });
})();
