const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

function _parseHoraDisplay(s) {
  if (!s) return '--:--';
  const hm = s.match(/^(\d{1,2}):(\d{2})/);
  if (hm) return hm[1].padStart(2, '0') + ':' + hm[2];
  const hbr = s.match(/^(\d{1,2})h(\d{0,2})/i);
  if (hbr) return hbr[1].padStart(2, '0') + ':' + (hbr[2] || '00').padStart(2, '0');
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    if (ampm[3].toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ampm[3].toUpperCase() === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + ampm[2];
  }
  const n = parseFloat(s);
  if (!isNaN(n) && n > 0 && n < 1) {
    const totalMin = Math.round(n * 24 * 60);
    return String(Math.floor(totalMin / 60)).padStart(2, '0') + ':' + String(totalMin % 60).padStart(2, '0');
  }
  return s.substring(0, 5);
}

async function fetchAgendamentos(spreadsheetId) {
  try {
    console.log('📡 Tentando ler a planilha ID:', spreadsheetId);
    const timeoutMs = 15000;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout ao acessar Google Sheets (15s)')), timeoutMs)
    );
    const response = await Promise.race([
      sheets.spreadsheets.values.get({ spreadsheetId, range: 'Agendamentos!A:M' }),
      timeoutPromise
    ]);

    const data = response.data.values;
    console.log('📊 Linhas retornadas da aba Agendamentos:', data ? data.length : 0);
    if (!data || data.length === 0) return { ok: false, erro: 'Sem dados na planilha.' };

    const agora = new Date();
    const todayY = agora.getFullYear();
    const todayM = agora.getMonth();
    const todayD = agora.getDate();
    
    console.log('📅 Node.js Hoje:', todayD, '/', todayM + 1, '/', todayY);

    const resultados = [];
    
    // data[0] is header, so start from i=1
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) continue;
      const p = String(row[1]).trim().split('/');
      if (p.length !== 3) continue;
      
      const rowD = parseInt(p[0], 10);
      const rowM = parseInt(p[1], 10) - 1;
      const rowY = parseInt(p[2], 10);
      
      if (rowY !== todayY || rowM !== todayM || rowD !== todayD) continue;
      if (String(row[8] || '').trim().toUpperCase() !== 'AGENDADO') continue;

      const nomeAtual = String(row[5] || '').trim();
      const codFamiliar = String(row[4] || '').trim();
      let existente = nomeAtual ? resultados.find(r => r.nome.toUpperCase() === nomeAtual.toUpperCase()) : null;

      if (existente) {
        if (!existente.linhas) existente.linhas = [existente.linha];
        existente.linhas.push(i + 1);
        existente.hora += ' / ' + _parseHoraDisplay(String(row[2]).trim());
      } else {
        resultados.push({
          linha: i + 1, 
          linhas: [i + 1],
          id: String(row[0] || ''), 
          hora: _parseHoraDisplay(String(row[2] || '').trim()),
          idProfissional: String(row[3] || ''), 
          codigoFamiliar: codFamiliar,
          nome: nomeAtual, 
          qtdPessoas: parseInt(row[6] || '1', 10) || 1,
          tipoAtendimento: String(row[7] || ''), 
          status: String(row[8] || ''),
          unidade: String(row[9] || ''), 
          beneficio: String(row[10] || ''),
          obsJustificativa: String(row[11] || ''), 
          obsInterna: String(row[12] || '')
        });
      }
    }

    resultados.sort((a, b) => a.hora.localeCompare(b.hora));
    return { ok: true, resultados, total: resultados.length };
  } catch (error) {
    console.error('❌ ERRO FATAL NO GOOGLE SHEETS (Sincronização Falhou):', error);
    return { ok: false, erro: error.message || 'Falha ao acessar Google Sheets' };
  }
}

async function updateAgendamentoStatus(spreadsheetId, linha, status) {
  try {
    const linhasToUpdate = Array.isArray(linha) ? linha : [linha];
    console.log('✍️ Tentando atualizar as linhas no Sheets:', linhasToUpdate, 'para o status:', status);
    
    for (const l of linhasToUpdate) {
      if (Number.isInteger(Number(l)) && Number(l) > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Agendamentos!I${l}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[status]]
          }
        });
      }
    }
    return { ok: true };
  } catch (error) {
    console.error('❌ ERRO AO ESCREVER NO SHEETS:', error.response ? error.response.data : error);
    return { ok: false, erro: error.message };
  }
}

module.exports = {
  fetchAgendamentos,
  updateAgendamentoStatus
};