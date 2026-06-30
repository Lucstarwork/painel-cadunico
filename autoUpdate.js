(function () {
  'use strict';

  var GITHUB_REPO = 'Lucstarwork/painel-cadunico';
  var LS_KEY      = 'last_update_check';

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

  function registrarVerificacao() {
    localStorage.setItem(LS_KEY, dataHoje());
  }

  function exibirBanner() {
    if (document.getElementById('update-banner')) return;

    var banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.setAttribute('style', [
      'position:fixed', 'inset:0 0 auto 0',
      'background:#1a3a5c', 'color:#ffffff',
      'padding:.75rem 2rem',
      'font-family:"IBM Plex Sans",system-ui,sans-serif',
      'font-size:.92rem', 'font-weight:600',
      'letter-spacing:.04em',
      'display:flex', 'align-items:center', 'justify-content:center', 'gap:1.5rem',
      'z-index:99999', 'box-shadow:0 2px 12px rgba(0,0,0,.35)'
    ].join(';'));

    var texto = document.createElement('span');
    texto.textContent = 'Uma nova versão está disponível. Aguarde o aviso de instalação.';

    var btn = document.createElement('button');
    btn.textContent = 'OK';
    btn.setAttribute('style', [
      'background:#ffffff', 'color:#1a3a5c',
      'border:none', 'border-radius:4px',
      'padding:.35rem 1.2rem',
      'font-size:.88rem', 'font-weight:700',
      'cursor:pointer', 'flex-shrink:0'
    ].join(';'));
    btn.addEventListener('click', function () {
      banner.remove();
    });

    banner.appendChild(texto);
    banner.appendChild(btn);
    document.body.prepend(banner);
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
