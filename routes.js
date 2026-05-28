const express = require('express');
const { fetchAgendamentos, updateAgendamentoStatus } = require('./googleSheets');

function createRoutes(db, io) {
  const router = express.Router();

  // Utilitário para formatar datas iguais ao padrão anterior
  function getTs() {
    const now = new Date();
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return {
      hoje: `${d}/${m}/${y}`,
      ts: `${d}/${m}/${y} ${hh}:${mm}:${ss}`,
      nowMs: now.getTime()
    };
  }

  // Acesso rápido à tabela config
  function getCfg(chave) {
    const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
    return row ? row.valor : null;
  }

  function setCfg(chave, valor) {
    db.prepare('UPDATE config SET valor = ? WHERE chave = ?').run(String(valor), chave);
  }

  function setBatchCfg(updates) {
    const stmtUpdate = db.prepare('UPDATE config SET valor = ? WHERE chave = ?');
    const stmtInsert = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
    const runTransaction = db.transaction((ups) => {
      for (const [k, v] of Object.entries(ups)) {
        const res = stmtUpdate.run(String(v), k);
        if (res.changes === 0) {
          stmtInsert.run(k, String(v));
        }
      }
    });
    runTransaction(updates);
  }

  // Gerenciamento de histórico recente
  function addHistorico(item) {
    const h = getCfg('historico_recente');
    let hist = [];
    try { hist = JSON.parse(h || '[]'); } catch (e) { }
    hist.push(item);
    if (hist.length > 50) hist = hist.slice(-50);
    setCfg('historico_recente', JSON.stringify(hist));
  }

  const _TMA_DEFAULT_MS  = 15 * 60 * 1000;
  const _TMA_ROUND_MS    =  5 * 60 * 1000;
  const _TMA_MAX_MS      = 90 * 60 * 1000;

  function _parseTsToMs(ts) {
    if (!ts) return null;
    try {
      const ms = new Date(ts.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$2/$1/$3')).getTime();
      return isNaN(ms) ? null : ms;
    } catch (e) { return null; }
  }

  function _computeTmaMs(db, hoje) {
    const rows = db.prepare(
      `SELECT inicio_at, fim_at FROM arquivo_morto
       WHERE data = ? AND status = 'CONCLUIDO'
         AND inicio_at != '' AND fim_at != ''
       ORDER BY rowid DESC LIMIT 40`
    ).all(hoje);

    const durations = rows
      .map(r => {
        const s = _parseTsToMs(r.inicio_at);
        const f = _parseTsToMs(r.fim_at);
        return (s && f && f > s) ? f - s : null;
      })
      .filter(d => d !== null && d > 0 && d < _TMA_MAX_MS);

    if (durations.length === 0) return _TMA_DEFAULT_MS;
    return durations.reduce((a, b) => a + b, 0) / durations.length;
  }

  function _fmtHHMM(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function _calcPrevisao(nomeadosLen, atendimentoRows, tmaMs, nowMs) {
    if (nomeadosLen === 0) return '--:--';

    let estimatedMs;

    if (atendimentoRows.length > 0) {
      const remainings = atendimentoRows.map(r => {
        const chamadoMs = _parseTsToMs(r.inicio_at) || 0;
        const elapsed = chamadoMs > 0 ? nowMs - chamadoMs : tmaMs;
        return Math.max(0, tmaMs - elapsed);
      });
      estimatedMs = nowMs + Math.min(...remainings);
    } else {
      estimatedMs = nowMs + tmaMs;
    }

    const rounded = Math.round(estimatedMs / _TMA_ROUND_MS) * _TMA_ROUND_MS;
    return _fmtHHMM(rounded);
  }

  // 1. Recepção: Habilitar Senha
  router.post('/recepcao/habilitar', (req, res) => {
    const { senhaHint, agendaJSON } = req.body;
    try {
      let pendente = getCfg('recepcao_pendente') || '';
      if ((!pendente || pendente === '0') && senhaHint) pendente = String(senhaHint);
      if (!pendente || pendente === '0') return res.json({ ok: false, erro: 'Nenhuma senha pendente.' });

      const existente = db.prepare(`SELECT id FROM fila WHERE senha = ? AND status IN ('AGUARDANDO', 'ATENDIMENTO')`).get(pendente);

      if (!existente) {
        const { hoje, ts } = getTs();
        const agendaStr = agendaJSON ? (typeof agendaJSON === 'string' ? agendaJSON : JSON.stringify(agendaJSON)) : '';

        db.prepare(`
          INSERT INTO fila (senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, agenda_json)
          VALUES (?, '', ?, 0, '', 'AGUARDANDO', '', ?)
        `).run(pendente, ts, agendaStr);

        db.prepare(`
          INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json)
          VALUES (?, ?, 'Recepção', ?, 0, 'Recepção', 'TRIAGEM', ?, ?, ?)
        `).run(hoje, pendente, ts, ts, ts, agendaStr);
      }

      setBatchCfg({ recepcao_pendente: '', ultima_at: Date.now() });

      // Emite evento via WebSocket para atualizar todos os clientes (painel/tv)
      io.emit('update_status', { message: 'Fila atualizada (recepção)' });

      res.json({ ok: true, senha: pendente });
    } catch (error) {
      res.json({ ok: false, erro: error.message });
    }
  });

  // 2. ATENDIMENTO: Chamar Próxima
  router.post('/atendimento/chamar', (req, res) => {
    const { balcao, nomeProfissional, forcar } = req.body;
    try {
      const numMesas = Number(getCfg('num_mesas')) || 6;
      const bn = Number(balcao);
      if (balcao !== 'Recepção' && (isNaN(bn) || bn < 1 || bn > numMesas))
        return res.json({ ok: false, erro: 'Mesa inválida.' });

      const nomeStr = String(nomeProfissional || '').trim().substring(0, 80);
      if (balcao !== 'Recepção' && nomeStr.length < 2)
        return res.json({ ok: false, erro: 'Nome do atendente é obrigatório.' });

      const emAtendimento = db.prepare(`SELECT id FROM fila WHERE balcao = ? AND status = 'ATENDIMENTO'`).get(String(balcao));
      if (emAtendimento) return res.json({ ok: false, erro: 'Finalize o atendimento atual antes de chamar o próximo.' });

      const aguardando = db.prepare(`SELECT * FROM fila WHERE status = 'AGUARDANDO' ORDER BY id ASC`).all();
      if (aguardando.length === 0) return res.json({ ok: false, erro: 'Não há ninguém aguardando na fila.' });

      const now = new Date();
      const agoraMin = now.getHours() * 60 + now.getMinutes();

      let aguardandoRows = aguardando.map(row => {
        let ag = {};
        try { if (row.agenda_json) ag = JSON.parse(row.agenda_json); } catch (e) { }
        let agMin = null;
        if (ag.hora && ag.tipo !== 'ENCAIXE') {
          const m = ag.hora.match(/^(\d{1,2}):(\d{2})/);
          if (m) agMin = Number(m[1]) * 60 + Number(m[2]);
        }
        return { ...row, ag, agMin };
      });

      const sortFn = (a, b) => {
        if (a.agMin !== null && b.agMin !== null) return a.agMin - b.agMin;
        if (a.agMin !== null) return -1;
        if (b.agMin !== null) return 1;
        return a.id - b.id;
      };

      let toCall = null;
      if (!forcar) {
        const elegiveis = aguardandoRows.filter(x => x.agMin === null || x.agMin <= agoraMin + 15);
        if (elegiveis.length > 0) {
          toCall = elegiveis.sort(sortFn)[0];
        } else {
          const prox = aguardandoRows.sort(sortFn)[0];
          const habMin = Math.max(0, (prox.agMin || 0) - 15);
          return res.json({
            ok: false,
            muitoCedo: true,
            horaHabilitacao: String(Math.floor(habMin / 60)).padStart(2, '0') + ':' + String(habMin % 60).padStart(2, '0'),
            senha: String(Number(prox.senha)),
            nome: prox.ag.nome || ''
          });
        }
      } else {
        toCall = aguardandoRows.sort(sortFn)[0];
      }

      const { ts, nowMs } = getTs();
      const senha = String(Number(toCall.senha));
      const agDados = toCall.ag;

      db.prepare(`
        UPDATE fila 
        SET balcao = ?, atendente = ?, status = 'ATENDIMENTO', inicio_at = ? 
        WHERE id = ?
      `).run(String(balcao), nomeStr, ts, toCall.id);

      setBatchCfg({
        ultima_senha: senha,
        ultimo_balcao: balcao,
        ultimo_atendente: nomeStr,
        ultima_at: nowMs,
        ultima_rechamada: 'false',
        ultimo_nome: agDados.nome || '',
        ultimo_tipo_agenda: agDados.tipo || ''
      });

      addHistorico({
        id: nowMs + '_' + balcao,
        senha: senha,
        balcao: String(balcao),
        at: nowMs,
        rechamada: false,
        nome: agDados.nome || '',
        tipo: agDados.tipo || '',
        atendente: nomeStr
      });

      // Emite eventos de atualização global e de nova chamada na TV
      io.emit('update_status', { message: 'Fila atualizada' });
      io.emit('nova_chamada', { senha, balcao, nome: agDados.nome || '', tipo: agDados.tipo || '' });

      res.json({
        ok: true, senha, balcao, ts,
        nome: agDados.nome || '', hora_ag: agDados.hora || '', beneficio: agDados.beneficio || '',
        qtd_pessoas: agDados.qtdPessoas || '', obs_interna: agDados.obsInterna || '',
        obs_justificativa: agDados.obsJustificativa || '', unidade: agDados.unidade || '',
        tipo_atendimento: agDados.tipoAtendimento || '', tipo_agenda: agDados.tipo || ''
      });
    } catch (error) {
      res.json({ ok: false, erro: error.message });
    }
  });

  // 3. ATENDIMENTO: Finalizar
  router.post('/atendimento/finalizar', (req, res) => {
    const { balcao, statusFinal } = req.body;
    if (!['CONCLUIDO', 'AUSENTE'].includes(statusFinal))
      return res.json({ ok: false, erro: 'Status inválido.' });

    try {
      const emAtendimento = db.prepare(`SELECT * FROM fila WHERE balcao = ? AND status = 'ATENDIMENTO'`).get(String(balcao));
      if (!emAtendimento) return res.json({ ok: false, erro: 'Nenhum atendimento ativo na mesa ' + balcao });

      const { hoje, ts, nowMs } = getTs();

      db.prepare(`
        INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hoje, emAtendimento.senha, emAtendimento.balcao, emAtendimento.chamado_em,
        emAtendimento.rechamadas, emAtendimento.atendente, statusFinal,
        emAtendimento.inicio_at, ts, emAtendimento.agenda_json
      );

      db.prepare(`DELETE FROM fila WHERE id = ?`).run(emAtendimento.id);

      setCfg('ultima_at', nowMs);

      // Emite evento para os clientes recarregarem dados da fila
      io.emit('update_status', { message: 'Atendimento finalizado' });

      res.json({ ok: true });

      // Atualiza a planilha no Google Sheets assincronamente se vier de agendamento
      let agDados = {};
      try { if (emAtendimento.agenda_json) agDados = JSON.parse(emAtendimento.agenda_json); } catch(e) {}
      if (agDados && agDados.tipo !== 'ENCAIXE') {
        const linhas = Array.isArray(agDados.linhas) ? agDados.linhas : (agDados.linha ? [agDados.linha] : []);
        if (linhas.length > 0) {
          const ssId = process.env.CADASTRO_UNICO_SS_ID;
          if (ssId) {
            console.log('🚀 Disparando baixa no GSheets para as linhas:', linhas, 'com status:', statusFinal);
            updateAgendamentoStatus(ssId, linhas, statusFinal).catch(err => {
              console.error('❌ Erro na promessa de update do GSheets (atendimento/finalizar):', err);
            });
          } else {
            console.warn('⚠️ CADASTRO_UNICO_SS_ID não configurado no .env, ignorando atualização da planilha.');
          }
        }
      }
    } catch (error) {
      res.json({ ok: false, erro: error.message });
    }
  });

  // 4. ATENDIMENTO: Rechamar
  router.post('/atendimento/rechamar', (req, res) => {
    const { balcao } = req.body;
    try {
      const emAtendimento = db.prepare(`SELECT * FROM fila WHERE balcao = ? AND status = 'ATENDIMENTO'`).get(String(balcao));
      if (!emAtendimento) return res.json({ ok: false, erro: 'Nenhuma senha em atendimento nesta mesa.' });

      const { ts, nowMs } = getTs();
      const rechamadas = emAtendimento.rechamadas + 1;
      const senha = emAtendimento.senha;

      let agDadosRec = {};
      try { if (emAtendimento.agenda_json) agDadosRec = JSON.parse(emAtendimento.agenda_json); } catch (e) { }

      db.prepare(`UPDATE fila SET chamado_em = ?, rechamadas = ? WHERE id = ?`).run(ts, rechamadas, emAtendimento.id);

      setBatchCfg({
        ultima_senha: senha,
        ultimo_balcao: balcao,
        ultima_at: nowMs,
        ultima_rechamada: 'true',
        ultimo_nome: agDadosRec.nome || '',
        ultimo_tipo_agenda: agDadosRec.tipo || ''
      });

      addHistorico({
        id: nowMs + '_' + balcao + '_r',
        senha: senha,
        balcao: String(balcao),
        at: nowMs,
        rechamada: true,
        nome: agDadosRec.nome || '',
        tipo: agDadosRec.tipo || '',
        atendente: emAtendimento.atendente
      });

      // Emite os eventos de status e de nova chamada para a TV piscar a rechamada
      io.emit('update_status', { message: 'Fila atualizada (rechamada)' });
      io.emit('nova_chamada', { senha, balcao, nome: agDadosRec.nome || '', tipo: agDadosRec.tipo || '' });

      res.json({ ok: true, senha, balcao, ts, rechamada: true, rechamadas });
    } catch (error) {
      res.json({ ok: false, erro: error.message });
    }
  });
  // 5. GET /config
  router.get('/config', (req, res) => {
    try {
      const rows = db.prepare('SELECT chave, valor FROM config').all();
      const cfg = {};
      for (const r of rows) cfg[r.chave] = r.valor;
      res.json(cfg);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 6. GET /status
  router.get('/status', (req, res) => {
    try {
      const cfgRows = db.prepare('SELECT chave, valor FROM config').all();
      const cfg = {};
      for (const r of cfgRows) cfg[r.chave] = r.valor;

      const aguardandoRows = db.prepare("SELECT * FROM fila WHERE status = 'AGUARDANDO' ORDER BY id ASC").all();
      const atendimentoRows = db.prepare("SELECT * FROM fila WHERE status = 'ATENDIMENTO' ORDER BY inicio_at DESC LIMIT 5").all();

      const ultimas = atendimentoRows.map(r => {
        let ag = {};
        try { if (r.agenda_json) ag = JSON.parse(r.agenda_json); } catch (e) { }
        return {
          senha: r.senha,
          balcao: r.balcao,
          atendente: r.atendente || '',
          ts: r.inicio_at ? r.inicio_at.split(' ')[1] : '--:--',
          rechamadas: r.rechamadas,
          chamado_ms: r.inicio_at ? new Date(r.inicio_at.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$2/$1/$3')).getTime() : 0,
          nome: ag.nome || '',
          tipo_agenda: ag.tipo || ''
        };
      });

      const proximasRaw = aguardandoRows.map(r => {
        let ag = {};
        try { if (r.agenda_json) ag = JSON.parse(r.agenda_json); } catch (e) { }
        let agMin = null;
        if (ag.hora && ag.tipo !== 'ENCAIXE') {
          const m = ag.hora.match(/^(\d{1,2}):(\d{2})/);
          if (m) agMin = Number(m[1]) * 60 + Number(m[2]);
        }
        return { id: r.id, senha: r.senha, nome: ag.nome || '', agMin };
      });

      proximasRaw.sort((a, b) => {
        if (a.agMin !== null && b.agMin !== null) return a.agMin - b.agMin;
        if (a.agMin !== null) return -1;
        if (b.agMin !== null) return 1;
        return a.id - b.id;
      });
      const proximas = proximasRaw.slice(0, 3).map(x => ({ senha: x.senha, nome: x.nome }));

      const nomeados = proximasRaw.filter(x => x.nome && x.nome.trim());
      const { hoje: hoje2, nowMs: nowMs2 } = getTs();
      const tmaMs = _computeTmaMs(db, hoje2);
      const previsao = _calcPrevisao(nomeados.length, atendimentoRows, tmaMs, nowMs2);

      let hist = [];
      try { hist = JSON.parse(cfg['historico_recente'] || '[]'); } catch (e) { }

      res.json({
        ultima_senha: cfg['ultima_senha'] || '',
        ultimo_balcao: cfg['ultimo_balcao'] || '',
        ultimo_atendente: cfg['ultimo_atendente'] || '',
        ultima_rechamada: cfg['ultima_rechamada'] === 'true',
        ultimo_nome: cfg['ultimo_nome'] || '',
        ultimo_tipo_agenda: cfg['ultimo_tipo_agenda'] || '',
        ultima_at: Number(cfg['ultima_at']) || 0,
        na_fila: aguardandoRows.length,
        previsao,
        ultimas,
        proximas,
        hist
      });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 7. POST /tts/sintetizar
  router.post('/tts/sintetizar', async (req, res) => {
    try {
      const raw = req.body.text || req.body.texto || (req.body.args && req.body.args[0]) || req.body[0] || '';
      const text = String(raw).trim();

      if (!text) return res.json({ ok: false, erro: 'Texto vazio.' });
      const apiKey = process.env.GOOGLE_TTS_API_KEY;
      if (!apiKey) return res.json({ ok: false, erro: 'Chave da API Google nao configurada.' });

      const isSsml = text.startsWith('<speak');
      const input = isSsml
        ? { ssml: text.substring(0, 5000) }
        : { text: text.substring(0, 500) };

      const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          voice: { languageCode: 'pt-BR', name: 'pt-BR-Neural2-C' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 0.92, pitch: 0.0 }
        })
      });

      if (!response.ok) {
        const err = await response.json();
        console.error('[TTS] Erro da API Google:', err);
        return res.json({ ok: false });
      }

      const data = await response.json();
      if (data.audioContent) {
        res.json({ ok: true, audio: data.audioContent });
      } else {
        res.json({ ok: false, erro: data.error ? data.error.message : 'Falha na sintese.' });
      }
    } catch (error) {
      console.error('[TTS] Erro interno:', error);
      res.status(500).json({ ok: false, erro: error.message });
    }
  });

  // 8. GET /agendamentos/hoje
  router.get('/agendamentos/hoje', async (req, res) => {
    try {
      const ssId = process.env.CADASTRO_UNICO_SS_ID;
      if (!ssId) {
        return res.json({ ok: false, erro: 'CADASTRO_UNICO_SS_ID não configurado no .env' });
      }
      const result = await fetchAgendamentos(ssId);

      if (!result || result.ok === false) {
        return res.json({ ok: false, erro: (result && result.erro) || 'Falha ao acessar Google Sheets' });
      }

      // Filter out agendamentos already in the active queue (AGUARDANDO or ATENDIMENTO)
      if (result.resultados && result.resultados.length > 0) {
        const filaRows = db.prepare("SELECT agenda_json FROM fila WHERE status IN ('AGUARDANDO', 'ATENDIMENTO')").all();
        const linhasNaFila = new Set();
        for (const row of filaRows) {
          if (row.agenda_json) {
            try {
              const ag = JSON.parse(row.agenda_json);
              if (ag.tipo !== 'ENCAIXE') {
                if (ag.linha) linhasNaFila.add(Number(ag.linha));
                if (Array.isArray(ag.linhas)) ag.linhas.forEach(l => linhasNaFila.add(Number(l)));
              }
            } catch (e) {}
          }
        }
        if (linhasNaFila.size > 0) {
          result.resultados = result.resultados.filter(ag => !linhasNaFila.has(Number(ag.linha)));
          result.total = result.resultados.length;
        }
      }

      console.log('🚀 Enviando para o frontend:', result.resultados ? result.resultados.length : 0, 'agendamentos pendentes.');
      res.json(result);
    } catch (e) {
      console.error('❌ Erro na rota /agendamentos/hoje:', e);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 9. POST /recepcao/pular
  router.post('/recepcao/pular', (req, res) => {
    const { senhaHint } = req.body;
    try {
      let pendente = getCfg('recepcao_pendente') || '';
      if ((!pendente || pendente === '0') && senhaHint) pendente = String(senhaHint);
      if (!pendente || pendente === '0') return res.json({ ok: false, erro: 'Nenhuma ficha pendente.' });

      const { hoje, ts } = getTs();
      
      // Tenta recuperar a fila correspondente para pegar o agenda_json, se existir
      const existente = db.prepare("SELECT agenda_json FROM fila WHERE senha = ?").get(pendente);
      const agendaStr = existente && existente.agenda_json ? existente.agenda_json : '';

      db.prepare("INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json) VALUES (?, ?, 'Recepção', ?, 0, 'Recepção', 'AUSENTE', ?, ?, ?)").run(hoje, pendente, ts, ts, ts, agendaStr);
      setCfg('recepcao_pendente', '');
      io.emit('update_status', { message: 'Fila atualizada' });
      res.json({ ok: true });

      // Atualiza GSheets se tiver agenda
      if (agendaStr) {
        let agDados = {};
        try { agDados = JSON.parse(agendaStr); } catch(e) {}
        if (agDados && agDados.tipo !== 'ENCAIXE') {
          const linhas = Array.isArray(agDados.linhas) ? agDados.linhas : (agDados.linha ? [agDados.linha] : []);
          if (linhas.length > 0) {
            const ssId = process.env.CADASTRO_UNICO_SS_ID;
            if (ssId) {
              console.log('🚀 [Recepção Pular] Disparando baixa de AUSENTE no GSheets para as linhas:', linhas);
              updateAgendamentoStatus(ssId, linhas, 'AUSENTE').catch(err => {
                console.error('❌ Erro na promessa de update do GSheets (recepcao/pular):', err);
              });
            }
          }
        }
      }
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 10. POST /recepcao/ausente
  router.post('/recepcao/ausente', (req, res) => {
    const { senha } = req.body;
    try {
      const existente = db.prepare("SELECT * FROM fila WHERE senha = ? AND status = 'AGUARDANDO'").get(String(senha));
      if (!existente) return res.json({ ok: false, erro: 'Senha não encontrada na fila.' });

      const { hoje, ts } = getTs();
      const agendaStr = existente.agenda_json || '';
      
      db.prepare("INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json) VALUES (?, ?, 'Recepção', ?, 0, 'Recepção', 'AUSENTE', ?, ?, ?)").run(hoje, existente.senha, ts, existente.inicio_at || ts, ts, agendaStr);
      db.prepare("DELETE FROM fila WHERE id = ?").run(existente.id);
      setCfg('ultima_at', Date.now());
      io.emit('update_status', { message: 'Fila atualizada' });
      res.json({ ok: true, senha });

      // Atualiza GSheets se tiver agenda
      if (agendaStr) {
        let agDados = {};
        try { agDados = JSON.parse(agendaStr); } catch(e) {}
        if (agDados && agDados.tipo !== 'ENCAIXE') {
          const linhas = Array.isArray(agDados.linhas) ? agDados.linhas : (agDados.linha ? [agDados.linha] : []);
          if (linhas.length > 0) {
            const ssId = process.env.CADASTRO_UNICO_SS_ID;
            if (ssId) {
              console.log('🚀 [Recepção Ausente] Disparando baixa de AUSENTE no GSheets para as linhas:', linhas);
              updateAgendamentoStatus(ssId, linhas, 'AUSENTE').catch(err => {
                console.error('❌ Erro na promessa de update do GSheets (recepcao/ausente):', err);
              });
            }
          }
        }
      }
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 11. GET /recepcao/fila
  router.get('/recepcao/fila', (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM fila").all();
      const aguardando = [];
      const atendimento = [];
      const now = new Date();

      for (const r of rows) {
        if (r.status === 'AGUARDANDO') {
          let ag = {};
          try { if (r.agenda_json) ag = JSON.parse(r.agenda_json); } catch (e) { }
          let elapsedMin = 0;
          if (r.chamado_em) {
            const parts = r.chamado_em.split(' ');
            if (parts.length === 2) {
              const dateParts = parts[0].split('/');
              const timeParts = parts[1].split(':');
              const ts = new Date(dateParts[2], dateParts[1] - 1, dateParts[0], timeParts[0], timeParts[1], timeParts[2]);
              elapsedMin = Math.floor((now - ts) / 60000);
            }
          }
          const horaMatch = ag.hora ? ag.hora.match(/^(\d{1,2}):(\d{2})/) : null;
          const agMin = horaMatch ? Number(horaMatch[1]) * 60 + Number(horaMatch[2]) : null;
          const agoraMin = now.getHours() * 60 + now.getMinutes();
          const chamavel = ag.tipo === 'ENCAIXE' || agMin === null || agMin <= agoraMin + 15;
          aguardando.push({ senha: String(r.senha), nome: ag.nome || '', tipo_agenda: ag.tipo || '', hora_ag: ag.hora || '', elapsedMin, chamavel });
        } else if (r.status === 'ATENDIMENTO') {
          let ag = {};
          try { if (r.agenda_json) ag = JSON.parse(r.agenda_json); } catch (e) { }
          atendimento.push({ senha: String(r.senha), balcao: String(r.balcao), nome: ag.nome || '' });
        }
      }
      res.json({
        pendente: getCfg('recepcao_pendente') || '',
        ultimo: Number(getCfg('ultimo_numero_chamado')) || 0,
        aguardando,
        atendimento,
        total_fila: aguardando.length,
        total_fichas: Number(getCfg('total_fichas')) || 20
      });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 12. POST /recepcao/ligar_proxima
  router.post('/recepcao/ligar_proxima', (req, res) => {
    try {
      const pendente = getCfg('recepcao_pendente') || '';
      if (pendente && pendente !== '0') return res.json({ ok: false, erro: `Valide ou pule a senha ${pendente} antes de chamar a próxima.` });

      const ultimo = Number(getCfg('ultimo_numero_chamado')) || 0;
      const totalFichas = Number(getCfg('total_fichas')) || 20;
      const proximo = (ultimo % totalFichas) + 1;
      const nowMs = Date.now();

      setBatchCfg({
        recepcao_pendente: String(proximo), ultimo_numero_chamado: proximo,
        ultima_senha: String(proximo), ultimo_balcao: 'Recepção',
        ultimo_atendente: '', ultima_at: nowMs,
        ultima_rechamada: 'false', ultimo_nome: '', ultimo_tipo_agenda: ''
      });

      addHistorico({ id: nowMs + '_REC', senha: String(proximo), balcao: 'Recepção', at: nowMs, rechamada: false, tipo: 'aviso' });
      io.emit('update_status', { message: 'Nova senha ligada' });
      io.emit('nova_chamada', { senha: String(proximo), balcao: 'Recepção', nome: '', tipo: 'aviso' });

      res.json({ ok: true, senha: String(proximo) });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 13. POST /recepcao/rechamar
  router.post('/recepcao/rechamar', (req, res) => {
    try {
      const pendente = getCfg('recepcao_pendente') || '';
      if (!pendente || pendente === '0') return res.json({ ok: false, erro: 'Nenhuma ficha pendente.' });

      const nowMs = Date.now();
      setBatchCfg({
        ultima_senha: pendente, ultimo_balcao: 'Recepção',
        ultimo_atendente: '', ultima_at: nowMs,
        ultima_rechamada: 'true', ultimo_nome: '', ultimo_tipo_agenda: 'aviso'
      });

      addHistorico({ id: nowMs + '_REC_r', senha: String(pendente), balcao: 'Recepção', at: nowMs, rechamada: true, tipo: 'aviso' });
      io.emit('update_status', { message: 'Rechamada na recepcao' });
      io.emit('nova_chamada', { senha: String(pendente), balcao: 'Recepção', nome: '', tipo: 'aviso' });

      res.json({ ok: true, senha: pendente });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 14. POST /recepcao/validar
  router.post('/recepcao/validar', (req, res) => {
    const { senhaHint } = req.body;
    try {
      let pendente = getCfg('recepcao_pendente') || '';
      if ((!pendente || pendente === '0') && senhaHint) pendente = String(senhaHint);
      if (!pendente || pendente === '0') return res.json({ ok: false, erro: 'Nenhuma senha pendente.' });

      const existente = db.prepare("SELECT id FROM fila WHERE senha = ? AND status IN ('AGUARDANDO', 'ATENDIMENTO')").get(pendente);

      if (!existente) {
        const { hoje, ts } = getTs();
        const agendaStr = JSON.stringify({ tipo: 'ENCAIXE', nome: 'Encaixe' });

        db.prepare("INSERT INTO fila (senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, agenda_json) VALUES (?, '', ?, 0, '', 'AGUARDANDO', '', ?)").run(pendente, ts, agendaStr);
        db.prepare("INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json) VALUES (?, ?, 'Recepção', ?, 0, 'Recepção', 'TRIAGEM', ?, ?, ?)").run(hoje, pendente, ts, ts, ts, agendaStr);
      }

      setBatchCfg({ recepcao_pendente: '', ultima_at: Date.now() });
      io.emit('update_status', { message: 'Fila atualizada' });
      res.json({ ok: true, senha: pendente });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  function toDate(str) {
    if (!str) return new Date();
    if (!isNaN(str) && Number(str) > 10000) return new Date(Number(str));
    if (String(str).includes('T')) return new Date(str);
    const p = String(str).trim().split(' ');
    if (p.length === 2 && p[0].includes('/')) {
      const dParts = p[0].split('/');
      const tParts = p[1].split(':');
      if (dParts.length === 3 && tParts.length >= 2) {
        return new Date(dParts[2], dParts[1] - 1, dParts[0], tParts[0], tParts[1], tParts[2] || 0);
      }
    }
    if (p.length === 1 && p[0].includes('/')) {
      const dParts = p[0].split('/');
      if (dParts.length === 3) {
        return new Date(dParts[2], dParts[1] - 1, dParts[0]);
      }
    }
    return new Date(str);
  }

  function extrairSegundos(str) {
    if (!str) return 0;
    const d = toDate(str);
    if (isNaN(d.getTime())) return 0;
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }

  function mesclarAgentes(map) {
    const arr = [];
    for (const [nome, v] of Object.entries(map)) {
      arr.push({ nome, ...v });
    }
    arr.sort((a, b) => b.atendimentos - a.atendimentos);
    const m = {};
    arr.forEach(x => m[x.nome] = x);
    return m;
  }

  function normTipo(raw) {
    const t = String(raw || '').toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove diacritics
    if (t.includes('inclu')) return 'inclusao';
    if (t.includes('atual')) return 'atualizacao';
    if (t.includes('encaixe') || t === 'encaixe') return 'encaixe';
    return 'outro';
  }

  function normNome(n) {
    return String(n || '').trim().toUpperCase();
  }

  // 15. GET /dashboard
  router.get('/dashboard', (req, res) => {
    try {
      const filaAll = db.prepare("SELECT * FROM fila").all();
      const arch = db.prepare("SELECT * FROM arquivo_morto").all();

      const filaAtiva = filaAll.filter(r => String(r.status).trim() === 'ATENDIMENTO');
      const naFila = filaAll.filter(r => String(r.status).trim() === 'AGUARDANDO').length;
      
      const agoraObj = new Date();
      const hojeY = agoraObj.getFullYear();
      const hojeM = agoraObj.getMonth();
      const hojeD = agoraObj.getDate();

      function isHoje(str) {
        if (!str) return false;
        const d = toDate(str);
        if (isNaN(d.getTime())) return false;
        return d.getFullYear() === hojeY && d.getMonth() === hojeM && d.getDate() === hojeD;
      }

      const hojeArch = arch.filter(r => isHoje(r.data) || isHoje(r.inicio_at) || isHoje(r.chamado_em) || isHoje(r.fim_at));

      const porAgente = {}, porAgenteHoje = {};
      function acum(map, nome, rec, t) {
        const n = String(nome || '').trim(); 
        if (!n || n.toUpperCase() === 'RECEPÇÃO' || n === 'Recepção') return;
        if (!map[n]) map[n] = { atendimentos: 0, rechamadas: 0, ausentes: 0, tempoTotal: 0, countTempo: 0 };
        map[n].atendimentos++;
        map[n].rechamadas += rec;
        if (t > 5 && t < 7200) { map[n].tempoTotal += t; map[n].countTempo++; }
      }
      function acumAus(map, nome) {
        const n = String(nome || '').trim(); 
        if (!n || n.toUpperCase() === 'RECEPÇÃO' || n === 'Recepção') return;
        if (!map[n]) map[n] = { atendimentos: 0, rechamadas: 0, ausentes: 0, tempoTotal: 0, countTempo: 0 };
        map[n].ausentes++;
      }

      for (const r of arch) {
        const st = String(r.status).trim();
        if (st === 'CONCLUIDO') acum(porAgente, r.atendente, Number(r.rechamadas) || 0, Math.abs(extrairSegundos(r.fim_at) - extrairSegundos(r.inicio_at)));
        else if (st === 'AUSENTE' && String(r.balcao).trim() !== 'Recepção') acumAus(porAgente, r.atendente);
      }
      for (const r of filaAtiva) acum(porAgente, r.atendente, Number(r.rechamadas) || 0, 0);

      for (const r of hojeArch) {
        const st = String(r.status).trim();
        if (st === 'CONCLUIDO') acum(porAgenteHoje, r.atendente, Number(r.rechamadas) || 0, Math.abs(extrairSegundos(r.fim_at) - extrairSegundos(r.inicio_at)));
        else if (st === 'AUSENTE' && String(r.balcao).trim() !== 'Recepção') acumAus(porAgenteHoje, r.atendente);
      }
      for (const r of filaAtiva) acum(porAgenteHoje, r.atendente, Number(r.rechamadas) || 0, 0);

      const pFinal = mesclarAgentes(porAgente), pHFinal = mesclarAgentes(porAgenteHoje);
      function fmtD(s) {
        if (!s || s <= 0) return '--';
        const m = Math.floor(s / 60), sg = Math.round(s % 60);
        return m > 0 ? m + 'min ' + String(sg).padStart(2, '0') + 's' : sg + 's';
      }
      [pFinal, pHFinal].forEach(map => {
        for (const v of Object.values(map)) v.mediaTempo = v.countTempo > 0 ? fmtD(v.tempoTotal / v.countTempo) : '--';
      });

      let tH = 0, cH = 0, tG = 0, cG = 0;
      for (const r of hojeArch) { if (String(r.status).trim() !== 'CONCLUIDO') continue; const d = Math.abs(extrairSegundos(r.fim_at) - extrairSegundos(r.inicio_at)); if (d > 5 && d < 7200) { tH += d; cH++; } }
      for (const r of arch) { if (String(r.status).trim() !== 'CONCLUIDO') continue; const d = Math.abs(extrairSegundos(r.fim_at) - extrairSegundos(r.inicio_at)); if (d > 5 && d < 7200) { tG += d; cG++; } }

      function calcPico(rows) {
        const h = {};
        rows.forEach(r => { 
          const dObj = toDate(r.inicio_at || r.chamado_em || r.data);
          if (isNaN(dObj.getTime())) return;
          const hora = dObj.getHours();
          h[hora] = (h[hora] || 0) + 1;
        });
        return h;
      }

      const _hojeConc = hojeArch.filter(r => String(r.status).trim() === 'CONCLUIDO').length;
      const _hojeAus = hojeArch.filter(r => String(r.status).trim() === 'AUSENTE' && String(r.balcao).trim() !== 'Recepção').length;
      const _totConc = arch.filter(r => String(r.status).trim() === 'CONCLUIDO').length;
      const _totAus = arch.filter(r => String(r.status).trim() === 'AUSENTE' && String(r.balcao).trim() !== 'Recepção').length;

      const recHojeEncerradas = hojeArch.filter(r => String(r.balcao).trim() === 'Recepção' && String(r.status).trim() === 'ENCERRADA').length;
      const recHojeTriagens = hojeArch.filter(r => String(r.balcao).trim() === 'Recepção' && String(r.status).trim() === 'TRIAGEM').length;
      const recHojeAusentes = hojeArch.filter(r => String(r.balcao).trim() === 'Recepção' && String(r.status).trim() === 'AUSENTE').length;

      const recTotalEncerradas = arch.filter(r => String(r.balcao).trim() === 'Recepção' && String(r.status).trim() === 'ENCERRADA').length;
      const recTotalTriagens = arch.filter(r => String(r.balcao).trim() === 'Recepção' && String(r.status).trim() === 'TRIAGEM').length;
      const recTotalAusentes = arch.filter(r => String(r.balcao).trim() === 'Recepção' && String(r.status).trim() === 'AUSENTE').length;

      res.json({
        totalAtend: _totConc, totalRecham: arch.reduce((s, r) => s + (Number(r.rechamadas) || 0), 0),
        hojeCompletos: _hojeConc,
        hojeConcluidosReais: _hojeConc,
        recHojeEncerradas, recHojeTriagens, recHojeAusentes,
        recTotalEncerradas, recTotalTriagens, recTotalAusentes,
        hojeAusentes: _hojeAus,
        hojeRechamadas: hojeArch.reduce((s, r) => s + (Number(r.rechamadas) || 0), 0),
        recTotal: recTotalAusentes,
        emAtendimento: filaAtiva.length, naFila,
        porAgente: pFinal, porAgenteHoje: pHFinal,
        mediaTempoHoje: fmtD(cH > 0 ? tH / cH : 0), mediaTempoGeral: fmtD(cG > 0 ? tG / cG : 0),
        picoHoje: calcPico(hojeArch.filter(r => String(r.status).trim() === 'CONCLUIDO')),
        picoGeral: calcPico(arch.filter(r => String(r.status).trim() === 'CONCLUIDO')),
        taxaAtendHoje: (_hojeConc + _hojeAus) > 0 ? Math.round(_hojeConc / (_hojeConc + _hojeAus) * 100) : 0,
        taxaAtendGeral: (_totConc + _totAus) > 0 ? Math.round(_totConc / (_totConc + _totAus) * 100) : 0,
        taxaPresencaHoje: (() => {
          const atend = _hojeConc + recHojeEncerradas;
          const aus = _hojeAus + recHojeAusentes;
          return (atend + aus) > 0 ? Math.round(atend / (atend + aus) * 100) : 0;
        })(),
        taxaPresencaGeral: (() => {
          const atend = _totConc + recTotalEncerradas;
          const aus = _totAus + recTotalAusentes;
          return (atend + aus) > 0 ? Math.round(atend / (atend + aus) * 100) : 0;
        })(),
        mediaEsperaHoje: (() => {
          let t = 0, c = 0;
          for (const r of hojeArch) {
            if (String(r.status).trim() !== 'CONCLUIDO') continue;
            const espera = Math.abs(extrairSegundos(r.inicio_at) - extrairSegundos(r.chamado_em));
            if (espera > 0 && espera < 14400) { t += espera; c++; }
          }
          return fmtD(c > 0 ? t / c : 0);
        })(),
        mediaEsperaGeral: (() => {
          let t = 0, c = 0;
          for (const r of arch) {
            if (String(r.status).trim() !== 'CONCLUIDO') continue;
            const espera = Math.abs(extrairSegundos(r.inicio_at) - extrairSegundos(r.chamado_em));
            if (espera > 0 && espera < 14400) { t += espera; c++; }
          }
          return fmtD(c > 0 ? t / c : 0);
        })()
      });
    } catch (e) {
      console.error('❌ ERRO NO DASHBOARD:', e);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 16. GET /dashboard/historico
  router.get('/dashboard/historico', (req, res) => {
    try {
      const arch = db.prepare("SELECT * FROM arquivo_morto").all();
      const hoje = new Date();
      const todayY = hoje.getFullYear();
      const todayM = hoje.getMonth();
      const todayD = String(hoje.getDate()).padStart(2, '0');
      const monthStr = String(hoje.getMonth() + 1).padStart(2, '0');
      const hojeStr = `${todayD}/${monthStr}/${todayY}`;

      const byDate = {};
      const byMonth = {};
      const byDateTipo = {};
      const byMonthTipo = {};
      const tipoHoje = {
        inclusao: { concluidos: 0, ausentes: 0 },
        atualizacao: { concluidos: 0, ausentes: 0 },
        encaixe: { concluidos: 0, ausentes: 0 }
      };

      const pd = {
        hoje: { ag: {}, bnf: {}, cras: {} },
        semana: { ag: {}, bnf: {}, cras: {} },
        mes: { ag: {}, bnf: {}, cras: {} },
        ano: { ag: {}, bnf: {}, cras: {} },
        geral: { ag: {}, bnf: {}, cras: {} }
      };

      const d0Ms = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
      const s0Ms = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 6).getTime();

      for (const r of arch) {
        const status = String(r.status).trim();
        const balcao = String(r.balcao).trim();
        if (!status) continue;
        const isAtend = balcao !== 'Recepção';

        const dObj = toDate(r.inicio_at || r.data || r.chamado_em);
        if (isNaN(dObj.getTime())) continue;

        const rY = dObj.getFullYear(), rM = dObj.getMonth(), rD = dObj.getDate();
        const dateStr = `${String(rD).padStart(2, '0')}/${String(rM + 1).padStart(2, '0')}/${rY}`;
        const monthKey = rY + '-' + String(rM + 1).padStart(2, '0');
        const rMs = new Date(rY, rM, rD).getTime();

        if (!byDate[dateStr])
          byDate[dateStr] = { concluidos: 0, ausentes: 0, rechamadas: 0, tempoTotal: 0, countTempo: 0 };

        if (!byMonth[monthKey])
          byMonth[monthKey] = { concluidos: 0, ausentes: 0, rechamadas: 0, tempoTotal: 0, countTempo: 0 };

        const pKeys = ['geral'];
        if (rY === todayY) {
          pKeys.push('ano');
          if (rM === todayM) pKeys.push('mes');
        }
        if (rMs >= s0Ms && rMs <= d0Ms) pKeys.push('semana');
        if (rMs === d0Ms) pKeys.push('hoje');

        let ag = {};
        try { if (r.agenda_json) ag = JSON.parse(String(r.agenda_json)); } catch (e) { }
        // Tenta tipoAtendimento primeiro; se vazio, tenta tipo; combina ambos para máxima cobertura
        const rawTipoAt = String(ag.tipoAtendimento || '').trim();
        const rawTipo = String(ag.tipo || '').trim();
        const tipo = normTipo(rawTipoAt) !== 'outro' ? normTipo(rawTipoAt) : normTipo(rawTipo);

        if (!byDateTipo[dateStr]) byDateTipo[dateStr] = { inclusao: 0, atualizacao: 0, encaixe: 0 };
        if (!byMonthTipo[monthKey]) byMonthTipo[monthKey] = { inclusao: 0, atualizacao: 0, encaixe: 0 };

        const benef = String(ag.beneficio || '').trim();
        const cras = String(ag.unidade || '').trim();
        const nomeAgente = String(r.atendente || '').trim();

        if (status === 'CONCLUIDO' && isAtend) {
          byDate[dateStr].concluidos++;
          byMonth[monthKey].concluidos++;
          const rec = Number(r.rechamadas) || 0;
          byDate[dateStr].rechamadas += rec;
          byMonth[monthKey].rechamadas += rec;
          const diff = Math.abs(extrairSegundos(r.fim_at) - extrairSegundos(r.inicio_at));
          const isTempoValido = (diff > 5 && diff < 7200);

          if (isTempoValido) {
            byDate[dateStr].tempoTotal += diff; byDate[dateStr].countTempo++;
            byMonth[monthKey].tempoTotal += diff; byMonth[monthKey].countTempo++;
          }

          if (tipo === 'inclusao' || tipo === 'atualizacao' || tipo === 'encaixe') {
            byDateTipo[dateStr][tipo]++;
            byMonthTipo[monthKey][tipo]++;
            if (dateStr === hojeStr) tipoHoje[tipo].concluidos++;
          }

          pKeys.forEach(pk => {
            if (benef) pd[pk].bnf[benef] = (pd[pk].bnf[benef] || 0) + 1;
            if (cras) {
              if (!pd[pk].cras[cras]) pd[pk].cras[cras] = { concluidos: 0, ausentes: 0 };
              pd[pk].cras[cras].concluidos++;
            }
            if (nomeAgente && normNome(nomeAgente) !== 'RECEPÇÃO') {
              const normAg = normNome(nomeAgente);
              if (!pd[pk].ag[normAg]) pd[pk].ag[normAg] = { nome: nomeAgente, atendimentos: 0, ausentes: 0, tempoTotal: 0, countTempo: 0, freq: 0 };
              pd[pk].ag[normAg].atendimentos++;
              if (pd[pk].ag[normAg].atendimentos > pd[pk].ag[normAg].freq) {
                pd[pk].ag[normAg].freq = pd[pk].ag[normAg].atendimentos;
                pd[pk].ag[normAg].nome = nomeAgente;
              }
              if (isTempoValido) {
                pd[pk].ag[normAg].tempoTotal += diff;
                pd[pk].ag[normAg].countTempo++;
              }
            }
          });

        } else if (status === 'AUSENTE') {
          byDate[dateStr].ausentes++;
          byMonth[monthKey].ausentes++;
          if (tipo === 'inclusao' || tipo === 'atualizacao' || tipo === 'encaixe') {
            if (dateStr === hojeStr) tipoHoje[tipo].ausentes++;
          }

          pKeys.forEach(pk => {
            if (isAtend && nomeAgente && normNome(nomeAgente) !== 'RECEPÇÃO') {
              const normAg = normNome(nomeAgente);
              if (!pd[pk].ag[normAg]) pd[pk].ag[normAg] = { nome: nomeAgente, atendimentos: 0, ausentes: 0, tempoTotal: 0, countTempo: 0, freq: 0 };
              pd[pk].ag[normAg].ausentes++;
            }
            if (cras) {
              if (!pd[pk].cras[cras]) pd[pk].cras[cras] = { concluidos: 0, ausentes: 0 };
              pd[pk].cras[cras].ausentes++;
            }
          });
        }
      }

      const DIAS_NOMES = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

      const ultimos7dias = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - i);
        const ds = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        const s = byDate[ds] || { concluidos: 0, ausentes: 0, rechamadas: 0, countTempo: 0, tempoTotal: 0 };
        const st = byDateTipo[ds] || { inclusao: 0, atualizacao: 0, encaixe: 0 };
        ultimos7dias.push({
          data: ds, dia: DIAS_NOMES[d.getDay()],
          concluidos: s.concluidos, ausentes: s.ausentes, rechamadas: s.rechamadas,
          mediaSeg: s.countTempo > 0 ? Math.round(s.tempoTotal / s.countTempo) : 0,
          inclusao: st.inclusao, atualizacao: st.atualizacao, encaixe: st.encaixe || 0
        });
      }

      const diaSemanaAtual = hoje.getDay();
      const diasAteMundo = diaSemanaAtual === 0 ? 6 : diaSemanaAtual - 1;
      const semanaComparativo = [];
      for (let i = 0; i < 7; i++) {
        const dAtual = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - diasAteMundo + i);
        const dAnterior = new Date(dAtual.getFullYear(), dAtual.getMonth(), dAtual.getDate() - 7);
        const strAtual = `${String(dAtual.getDate()).padStart(2, '0')}/${String(dAtual.getMonth() + 1).padStart(2, '0')}/${dAtual.getFullYear()}`;
        const strAnt = `${String(dAnterior.getDate()).padStart(2, '0')}/${String(dAnterior.getMonth() + 1).padStart(2, '0')}/${dAnterior.getFullYear()}`;
        const sAt = byDate[strAtual] || { concluidos: 0, ausentes: 0 };
        const sAn = byDate[strAnt] || { concluidos: 0, ausentes: 0 };
        semanaComparativo.push({
          dia: ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'][i],
          dataAtual: strAtual, dataAnterior: strAnt,
          atualConcluidos: sAt.concluidos, atualAusentes: sAt.ausentes,
          anteriorConcluidos: sAn.concluidos, anteriorAusentes: sAn.ausentes,
          isFuture: dAtual > hoje
        });
      }

      const NOMES_MES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
      const porMes = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        const s = byMonth[key] || { concluidos: 0, ausentes: 0, rechamadas: 0, countTempo: 0, tempoTotal: 0 };
        const st = byMonthTipo[key] || { inclusao: 0, atualizacao: 0, encaixe: 0 };
        porMes.push({
          chave: key, mes: NOMES_MES[d.getMonth()], ano: d.getFullYear(),
          concluidos: s.concluidos, ausentes: s.ausentes, rechamadas: s.rechamadas,
          mediaSeg: s.countTempo > 0 ? Math.round(s.tempoTotal / s.countTempo) : 0,
          inclusao: st.inclusao, atualizacao: st.atualizacao, encaixe: st.encaixe || 0
        });
      }

      const dia7Tipo = ultimos7dias.map(d => ({
        dia: d.dia, data: d.data, inclusao: d.inclusao, atualizacao: d.atualizacao, encaixe: d.encaixe
      }));

      const mensalTipo = porMes.map(m => ({
        mes: m.mes, ano: m.ano, inclusao: m.inclusao, atualizacao: m.atualizacao, encaixe: m.encaixe
      }));

      function topDict(dict, limit) {
        const total = Object.values(dict).reduce((a, b) => a + b, 0) || 1;
        return Object.keys(dict)
          .map(k => ({ nome: k, count: dict[k], pct: Math.round((dict[k] / total) * 100) }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);
      }
      function topCras(dict, limit) {
        const total = Object.values(dict).reduce((a, b) => a + b.concluidos, 0) || 1;
        return Object.keys(dict)
          .map(k => {
            const c = dict[k];
            const pctAusencia = (c.concluidos + c.ausentes) > 0 ? Math.round((c.ausentes / (c.concluidos + c.ausentes)) * 100) : 0;
            return { nome: k, count: c.concluidos, pct: Math.round((c.concluidos / total) * 100), ausentes: c.ausentes, pctAusencia };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);
      }

      function topAg(agMap, limit) {
        return Object.values(agMap)
          .sort((a, b) => b.atendimentos - a.atendimentos)
          .slice(0, limit)
          .map(v => {
            const med = v.countTempo > 0 ? v.tempoTotal / v.countTempo : 0;
            const mediaTempo = med > 0 ? (Math.floor(med / 60) + 'min ' + String(Math.round(med % 60)).padStart(2, '0') + 's') : '--';
            return [v.nome || '', { atendimentos: v.atendimentos, ausentes: v.ausentes, mediaTempo }];
          });
      }

      // Converte pd para formato compatível com o frontend (topAg, topBenef, topCRAS)
      const exportDataFormatado = {};
      for (const pk of ['hoje', 'semana', 'mes', 'ano', 'geral']) {
        exportDataFormatado[pk] = {
          topAg: topAg(pd[pk].ag, 9999),
          topBenef: topDict(Object.fromEntries(Object.entries(pd[pk].bnf).filter(([k]) => k !== 'Outros')), 9999),
          topCRAS: topCras(pd[pk].cras, 9999)
        };
      }

      res.json({
        ultimos7dias,
        semanaComparativo,
        porMes,
        porTipo: { hoje: tipoHoje, dia7: dia7Tipo, mensal: mensalTipo },
        topBeneficios: topDict(Object.fromEntries(Object.entries(pd.geral.bnf).filter(([k]) => k !== 'Outros')), 15),
        topCRAS: topCras(pd.geral.cras, 15),
        exportData: exportDataFormatado
      });
    } catch (e) {
      console.error('❌ ERRO NO DASHBOARD HISTORICO:', e);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 17. POST /recepcao/agendamento_ausente
  router.post('/recepcao/agendamento_ausente', (req, res) => {
    const { agendaJSON } = req.body;
    try {
      const { hoje, ts } = getTs();
      db.prepare("INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json) VALUES (?, '-', 'Recepção', ?, 0, 'Recepção', 'AUSENTE', ?, ?, ?)").run(hoje, ts, ts, ts, agendaJSON);
      res.json({ ok: true });

      // Atualiza a planilha no Google Sheets assincronamente
      let agDados = {};
      try { if (agendaJSON) agDados = typeof agendaJSON === 'string' ? JSON.parse(agendaJSON) : agendaJSON; } catch(e) {}
      if (agDados && agDados.tipo !== 'ENCAIXE') {
        const linhas = Array.isArray(agDados.linhas) ? agDados.linhas : (agDados.linha ? [agDados.linha] : []);
        if (linhas.length > 0) {
          const ssId = process.env.CADASTRO_UNICO_SS_ID;
          if (ssId) {
            console.log('🚀 [Recepção Agendamento Ausente] Disparando baixa de AUSENTE no GSheets para as linhas:', linhas);
            updateAgendamentoStatus(ssId, linhas, 'AUSENTE').catch(err => {
              console.error('❌ Erro na promessa de update do GSheets (recepcao/agendamento_ausente):', err);
            });
          }
        }
      }
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 18. POST /recepcao/encerrar
  router.post('/recepcao/encerrar', (req, res) => {
    const { senhaHint } = req.body;
    try {
      let pendente = getCfg('recepcao_pendente') || '';
      if ((!pendente || pendente === '0') && senhaHint) pendente = String(senhaHint);
      if (!pendente || pendente === '0') return res.json({ ok: false, erro: 'Nenhuma ficha pendente.' });

      const { hoje, ts } = getTs();
      db.prepare("INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json) VALUES (?, ?, 'Recepção', ?, 0, 'Recepção', 'ENCERRADA', ?, ?, ?)").run(hoje, pendente, ts, ts, ts, '{"tipo":"INFORMATIVO"}');
      setBatchCfg({ recepcao_pendente: '', ultima_at: Date.now() });
      io.emit('update_status', { message: 'Fila atualizada' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });



  // 19. POST /recepcao/zerar_senhas
  router.post('/recepcao/zerar_senhas', (req, res) => {
    try {
      const { hoje, ts } = getTs();
      const ativas = db.prepare("SELECT * FROM fila WHERE status IN ('AGUARDANDO', 'ATENDIMENTO')").all();
      const insertArq = db.prepare(
        "INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json) VALUES (?, ?, ?, ?, ?, ?, 'ZERADO', ?, ?, ?)"
      );
      const deleteFilaStmt = db.prepare('DELETE FROM fila WHERE id = ?');
      db.transaction(() => {
        for (const r of ativas) {
          insertArq.run(hoje, r.senha, r.balcao || 'Recepção', r.chamado_em || ts, r.rechamadas || 0, r.atendente || 'Recepção', r.inicio_at || ts, ts, r.agenda_json || '{}');
          deleteFilaStmt.run(r.id);
        }
      })();
      setBatchCfg({
        recepcao_pendente: '',
        ultimo_numero_chamado: '0',
        ultima_senha: '',
        ultimo_balcao: '',
        ultimo_atendente: '',
        ultima_at: String(Date.now()),
        ultima_rechamada: 'false',
        ultimo_nome: '',
        ultimo_tipo_agenda: '',
        historico_recente: '[]'
      });
      io.emit('update_status', { message: 'Senhas zeradas pela recepção' });
      res.json({ ok: true, zeradas: ativas.length });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // 20. GET /relatorio/dia
  router.get('/relatorio/dia', (req, res) => {
    try {
      const { hoje } = getTs();
      const data = req.query.data || hoje;

      const rows = db.prepare(
        "SELECT senha, balcao, atendente, status, inicio_at, fim_at, agenda_json FROM arquivo_morto WHERE data = ? AND status IN ('CONCLUIDO', 'AUSENTE') ORDER BY rowid ASC"
      ).all(data);

      const registros = rows.map(r => {
        let ag = {};
        try { if (r.agenda_json) ag = JSON.parse(r.agenda_json); } catch (e) {}

        const horaInicio = (() => {
          if (!r.inicio_at) return '';
          const partes = r.inicio_at.split(' ');
          return partes.length === 2 ? partes[1].substring(0, 5) : '';
        })();

        return {
          nome: ag.nome || '',
          cpf: ag.cpf || '',
          cras: ag.unidade || '',
          status: r.status,
          atendente: r.atendente || '',
          hora_inicio: horaInicio
        };
      });

      res.json({ ok: true, data, total: registros.length, registros });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Ativar/desativar modo mutirão (10 mesas + usuário Convidado)
  router.post('/mutirao/modo', (req, res) => {
    const { ativo } = req.body;
    try {
      if (ativo) {
        const original = getCfg('num_mesas') || '6';
        setBatchCfg({ num_mesas_backup: original, num_mesas: '10', modo_mutirao: 'true' });
      } else {
        const backup = getCfg('num_mesas_backup') || '6';
        setBatchCfg({ num_mesas: backup, modo_mutirao: 'false' });
      }
      res.json({ ok: true, ativo });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Exportar dados do mutirão (arquivo_morto sem IDs para merge sem conflito)
  router.get('/mutirao/exportar', (req, res) => {
    try {
      const registros = db.prepare('SELECT data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json FROM arquivo_morto').all();
      const exportado_em = new Date().toLocaleString('pt-BR');
      const payload = JSON.stringify({ exportado_em, total: registros.length, registros }, null, 2);
      const nomeArquivo = `mutirao_${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      res.setHeader('Content-Type', 'application/json');
      res.send(payload);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Importar dados do mutirão no banco principal (reatribui IDs automaticamente)
  router.post('/mutirao/importar', (req, res) => {
    const { registros } = req.body;
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ ok: false, erro: 'Nenhum registro recebido.' });
    }
    try {
      const insert = db.prepare(`
        INSERT INTO arquivo_morto (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json)
        VALUES (@data, @senha, @balcao, @chamado_em, @rechamadas, @atendente, @status, @inicio_at, @fim_at, @agenda_json)
      `);
      const inserirTodos = db.transaction((rows) => {
        for (const r of rows) insert.run({
          data: r.data || '', senha: r.senha || '', balcao: r.balcao || '',
          chamado_em: r.chamado_em || '', rechamadas: r.rechamadas || 0,
          atendente: r.atendente || '', status: r.status || '',
          inicio_at: r.inicio_at || '', fim_at: r.fim_at || '',
          agenda_json: r.agenda_json || ''
        });
      });
      inserirTodos(registros);
      res.json({ ok: true, importados: registros.length });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // DEBUG: Inspecionar tipos dos registros (remover depois de diagnosticar)
  router.get('/debug/tipos', (req, res) => {
    try {
      const rows = db.prepare("SELECT status, balcao, atendente, agenda_json FROM arquivo_morto WHERE status = 'CONCLUIDO' LIMIT 30").all();
      const result = rows.map(r => {
        let ag = {};
        try { if (r.agenda_json) ag = JSON.parse(r.agenda_json); } catch(e) {}
        const rawTipoAt = String(ag.tipoAtendimento || '').trim();
        const rawTipo = String(ag.tipo || '').trim();
        return {
          balcao: r.balcao, atendente: r.atendente,
          tipo: rawTipo || '(vazio)', tipoAtendimento: rawTipoAt || '(vazio)',
          beneficio: ag.beneficio || '(vazio)', unidade: ag.unidade || '(vazio)',
          normTipoResult: normTipo(rawTipoAt) !== 'outro' ? normTipo(rawTipoAt) : normTipo(rawTipo)
        };
      });
      res.json({ total: rows.length, amostras: result });
    } catch(e) { res.status(500).json({ erro: e.message }); }
  });

  // Encerramento automático de mesas ociosas após 90 minutos contínuos
  const INATIVIDADE_MS = 90 * 60 * 1000;

  function executarLimpezaInatividade() {
    try {
      const { hoje, ts, nowMs } = getTs();
      const corte = nowMs - INATIVIDADE_MS;
      let alterado = false;
      const mesasEncerradas = new Set();

      const travadas = db.prepare(
        "SELECT * FROM fila WHERE status = 'ATENDIMENTO' AND inicio_at != ''"
      ).all();

      if (travadas.length > 0) {
        const insArquivo = db.prepare(
          `INSERT INTO arquivo_morto
             (data, senha, balcao, chamado_em, rechamadas, atendente, status, inicio_at, fim_at, agenda_json)
           VALUES (?, ?, ?, ?, ?, ?, 'TIMEOUT', ?, ?, ?)`
        );
        const delFila = db.prepare('DELETE FROM fila WHERE id = ?');

        db.transaction(() => {
          for (const row of travadas) {
            const inicioMs = _parseTsToMs(row.inicio_at);
            if (!inicioMs || inicioMs > corte) continue;
            insArquivo.run(
              hoje, row.senha, row.balcao, row.chamado_em,
              row.rechamadas, row.atendente, row.inicio_at, ts,
              row.agenda_json || ''
            );
            delFila.run(row.id);
            mesasEncerradas.add(String(row.balcao));
            alterado = true;
          }
        })();
      }

      const histRow = db.prepare("SELECT valor FROM config WHERE chave = 'historico_recente'").get();
      let hist = [];
      try { hist = JSON.parse(histRow ? histRow.valor : '[]'); } catch (e) {}

      const emAtend = new Set(
        db.prepare("SELECT DISTINCT balcao FROM fila WHERE status = 'ATENDIMENTO'").all()
          .map(r => String(r.balcao))
      );

      const ultimaPorMesa = {};
      for (const item of hist) {
        const b = String(item.balcao);
        if (b === 'Recepção') continue;
        if (!ultimaPorMesa[b] || item.at > ultimaPorMesa[b]) ultimaPorMesa[b] = item.at;
      }

      for (const [balcao, ultimaAt] of Object.entries(ultimaPorMesa)) {
        if (emAtend.has(balcao)) continue;
        if (ultimaAt < corte) mesasEncerradas.add(balcao);
      }

      if (mesasEncerradas.size > 0) {
        const histFiltrado = hist.filter(item => !mesasEncerradas.has(String(item.balcao)));
        db.prepare("UPDATE config SET valor = ? WHERE chave = 'historico_recente'").run(
          JSON.stringify(histFiltrado)
        );
        alterado = true;
      }

      if (alterado) {
        io.emit('update_status', { message: 'limpeza_inatividade' });
        console.log(`[monitor] ${new Date().toLocaleTimeString('pt-BR')} — ${mesasEncerradas.size} mesa(s) encerrada(s) por inatividade.`);
      }
    } catch (err) {
      console.error('[monitor] Erro na limpeza de inatividade:', err);
    }
  }

  setInterval(executarLimpezaInatividade, 5 * 60 * 1000);
  executarLimpezaInatividade();

  return router;

}

module.exports = createRoutes;
