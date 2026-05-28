(function () {
  'use strict';

  // Repositório GitHub no formato "utilizador/repositorio"
  var GITHUB_REPO  = 'Lucstarwork/painel-cadunico';
  var LS_KEY       = 'last_update_check';
  var RELOAD_DELAY = 5000;

  function dataHoje() {
    var d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('-');
  }

  function jaVerificouHoje() {
    return localStorage.getItem(LS_KEY) === dataHoje();
  }

  // Registado antes dos awaits para impedir verificações concorrentes em abas simultâneas
  function registrarVerificacao() {
    localStorage.setItem(LS_KEY, dataHoje());
  }

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

  function normalizarTag(tag) {
    return String(tag || '').replace(/^v/i, '');
  }

  function versaoRemotaMaisRecente(tagRemota, versaoLocal) {
    var seg = function (v) {
      return normalizarTag(v).split('.').map(Number);
    };
    var r = seg(tagRemota);
    var l = seg(versaoLocal);
    var len = Math.max(r.length, l.length);
    for (var i = 0; i < len; i++) {
      var ri = r[i] || 0;
      var li = l[i] || 0;
      if (ri > li) return true;
      if (ri < li) return false;
    }
    return false;
  }

  async function obterVersaoLocal() {
    var r = await fetch('/api/version', { cache: 'no-store' });
    if (!r.ok) throw new Error('local-version-unavailable');
    var d = await r.json();
    if (!d.version) throw new Error('version-field-missing');
    return d.version;
  }

  async function obterVersaoRemota() {
    var url = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
    var r = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!r.ok) throw new Error('github-api-unavailable');
    var d = await r.json();
    if (!d.tag_name) throw new Error('tag-name-missing');
    return d.tag_name;
  }

  async function verificarAtualizacao() {
    if (jaVerificouHoje()) return;

    registrarVerificacao();

    try {
      var resultados = await Promise.all([obterVersaoLocal(), obterVersaoRemota()]);
      var versaoLocal = resultados[0];
      var tagRemota   = resultados[1];

      if (!versaoRemotaMaisRecente(tagRemota, versaoLocal)) return;

      exibirBanner();

      // bypass de cache: força o browser a recarregar os recursos do servidor
      setTimeout(function () {
        window.location.reload(true);
      }, RELOAD_DELAY);

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
