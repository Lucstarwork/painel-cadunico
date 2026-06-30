const path = require('path');
const os = require('os');
const fs = require('fs');

const publicDir = process.env.PUBLIC || path.join(os.homedir(), '..', 'Public');
const appDataPath = path.join(publicDir, 'SoftwareTV_Data');
if (!fs.existsSync(appDataPath)) { 
  fs.mkdirSync(appDataPath, { recursive: true }); 
}

require('dotenv').config({ path: path.join(appDataPath, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database'); // Inicializa a conexão com o SQLite
const createRoutes = require('./routes'); // Importa o arquivo de rotas

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Access-Control-Request-Private-Network"]
  }
});

// Intercepta preflights de Private Network Access (PNA) do Chrome no nível HTTP bruto,
// cobrindo rotas do socket.io que Express não alcança.
server.prependListener('request', (req, res) => {
  if (req.method === 'OPTIONS' && req.headers['access-control-request-private-network'] === 'true') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers['origin'] || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Access-Control-Request-Private-Network',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end();
  }
});

// Adiciona o header PNA a todas as respostas Express (fetch, scripts servidos pelo Express)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});

// Middleware para interpretar requisições em formato JSON
app.use(express.json());

// Monta as rotas da API em /api, passando o banco de dados e a instância do WebSocket
app.use('/api', createRoutes(db, io));

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;

const pkg = require('./package.json');

app.get('/api/system/info', (req, res) => {
  res.json({ ip: getLocalIp(), porta: PORT, version: pkg.version });
});

app.get('/api/version', (req, res) => {
  res.json({ version: pkg.version });
});

function serveFavicon(res, filename, contentType) {
  const candidatos = [
    path.join(process.resourcesPath || '', filename),
    path.join(__dirname, 'build', filename)
  ];
  const iconPath = candidatos.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!iconPath) return res.status(404).end();
  try {
    const data = fs.readFileSync(iconPath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(data);
  } catch {
    res.status(404).end();
  }
}

app.get('/favicon.png', (req, res) => serveFavicon(res, 'favicon.png', 'image/png'));
app.get('/favicon.ico', (req, res) => serveFavicon(res, 'favicon.png', 'image/png'));

app.get('/autoUpdate.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'autoUpdate.js'));
});

// Rota raiz redirecionando para a TV
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'display.html'));
});

// Rota para a interface do atendente/recepção
app.get('/agente', (req, res) => {
  res.sendFile(path.join(__dirname, 'agente.html'));
});

// Rota para a interface da TV
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'display.html'));
});

// Eventos e Conexões do WebSocket (Socket.io)
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  const localIp = getLocalIp();
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`- TV: http://${localIp}:${PORT}/display`);
  console.log(`- Agente: http://${localIp}:${PORT}/agente`);
});

// Garante que a chave de controle do reset existe no banco
db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)').run('ultimo_reset', '');

function executarResetDiario() {
  const agora = new Date();
  if (agora.getHours() < 16 || (agora.getHours() === 16 && agora.getMinutes() < 50)) return;

  const diaHoje = `${String(agora.getDate()).padStart(2, '0')}/${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;
  const ultimoReset = db.prepare("SELECT valor FROM config WHERE chave = 'ultimo_reset'").get();
  if (ultimoReset && ultimoReset.valor === diaHoje) return;

  try {
    db.prepare('DELETE FROM fila').run();

    const upd = db.prepare('UPDATE config SET valor = ? WHERE chave = ?');
    db.transaction(() => {
      [
        ['ultima_senha', ''], ['ultimo_balcao', ''], ['ultimo_atendente', ''],
        ['ultima_at', ''], ['ultima_rechamada', 'false'], ['historico_recente', '[]'],
        ['recepcao_pendente', ''], ['ultimo_numero_chamado', '0'],
        ['ultimo_nome', ''], ['ultimo_tipo_agenda', ''], ['media_atend_seg', '0'],
        ['ultimo_reset', diaHoje]
      ].forEach(([k, v]) => upd.run(v, k));
    })();

    io.emit('update_status', { message: 'reset_diario' });
    console.log(`✅ Reset diário executado — ${agora.toLocaleTimeString('pt-BR')} (${diaHoje})`);
  } catch (err) {
    console.error('❌ Erro no reset diário:', err);
  }
}

// Verifica ao iniciar (caso o servidor tenha ficado fora no horário exato)
executarResetDiario();
// Verifica a cada minuto
setInterval(executarResetDiario, 60 * 1000);
