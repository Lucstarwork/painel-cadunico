(function () {
  'use strict';

  var LS_KEY      = 'app_known_version';
  var RELOAD_DELAY = 5000;

  function exibirBanner() {
    if (document.getElementById('update-banner')) return;
    var el = document.createElement('div');
    el.id = 'update-banner';
    el.setAttribute('style', [
      'position:fixed', 'inset:0 0 auto 0',
      'background:#1a3a5c', 'color:#ffffff',
      'padding:.85rem 2rem',
      'font-family:"IBM Plex Sans",system-ui,sans-serif',
      'font-size:.92rem', 'font-weight:600',
      'letter-spacing:.04em', 'text-align:center',
      'z-index:99999', 'box-shadow:0 2px 12px rgba(0,0,0,.35)'
    ].join(';'));
    el.textContent = 'É necessário realizar a instalação de uma atualização.';
    document.body.prepend(el);
  }

  function normalizarVersao(v) {
    return String(v || '').replace(/^v/i, '');
  }

  function versaoMaisRecente(a, b) {
    var seg = function (v) { return normalizarVersao(v).split('.').map(Number); };
    var ra = seg(a), rb = seg(b);
    var len = Math.max(ra.length, rb.length);
    for (var i = 0; i < len; i++) {
      var ai = ra[i] || 0, bi = rb[i] || 0;
      if (ai > bi) return true;
      if (ai < bi) return false;
    }
    return false;
  }

  async function verificarAtualizacao() {
    try {
      var r = await fetch('/api/version', { cache: 'no-store' });
      if (!r.ok) return;
      var d = await r.json();
      var versaoServidor = d.version;
      if (!versaoServidor) return;

      var versaoConhecida = localStorage.getItem(LS_KEY);

      if (!versaoConhecida) {
        localStorage.setItem(LS_KEY, versaoServidor);
        return;
      }

      if (versaoMaisRecente(versaoServidor, versaoConhecida)) {
        localStorage.setItem(LS_KEY, versaoServidor);
        exibirBanner();
        setTimeout(function () {
          window.location.reload(true);
        }, RELOAD_DELAY);
      }
    } catch (_) {
      // Falha silenciosa — a aplicação continua normalmente
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', verificarAtualizacao);
  } else {
    verificarAtualizacao();
  }
}());
