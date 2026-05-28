const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Inicializa o banco de dados SQLite em pasta segura do usuário
const publicDir = process.env.PUBLIC || path.join(os.homedir(), '..', 'Public');
const dataDir = path.join(publicDir, 'SoftwareTV_Data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'banco.db');

// Verifica se o banco já existe
const isNewDb = !fs.existsSync(dbPath);

if (isNewDb) {
  // Procura pelo banco inicial pré-carregado (seja rodando no Node ou dentro do executável Electron)
  let bancoInicialPath = path.join(__dirname, 'banco_inicial.db');
  
  // No Electron após o build (app.asar), arquivos de banco não podem ser lidos facilmente se empacotados.
  // Normalmente, o banco_inicial.db pode estar na raiz extraída ou resources.
  if (!fs.existsSync(bancoInicialPath) && process.resourcesPath) {
    bancoInicialPath = path.join(process.resourcesPath, 'banco_inicial.db');
  }

  if (fs.existsSync(bancoInicialPath)) {
    try {
      fs.copyFileSync(bancoInicialPath, dbPath);
      console.log('Banco de dados pré-carregado copiado com sucesso!');
    } catch (err) {
      console.error('Erro ao copiar o banco de dados inicial:', err);
    }
  }
}

const db = new Database(dbPath);

// Habilita o modo WAL (Write-Ahead Logging) para melhor performance em concorrência
db.pragma('journal_mode = WAL');

function initDb() {
  // Criação da tabela config (chave, valor)
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );
  `);

  // Criação da tabela fila
  db.exec(`
    CREATE TABLE IF NOT EXISTS fila (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      senha TEXT,
      balcao TEXT,
      chamado_em TEXT,
      rechamadas INTEGER DEFAULT 0,
      atendente TEXT,
      status TEXT,
      inicio_at TEXT,
      agenda_json TEXT
    );
  `);

  // Criação da tabela arquivo_morto
  db.exec(`
    CREATE TABLE IF NOT EXISTS arquivo_morto (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT,
      senha TEXT,
      balcao TEXT,
      chamado_em TEXT,
      rechamadas INTEGER DEFAULT 0,
      atendente TEXT,
      status TEXT,
      inicio_at TEXT,
      fim_at TEXT,
      agenda_json TEXT
    );
  `);

  // Valores padrão para a tabela config, copiados do code.gs
  const defaults = [
    ['ultima_senha', ''], ['ultimo_balcao', ''], ['ultimo_atendente', ''],
    ['ultima_at', ''], ['ultima_rechamada', 'false'], ['historico_recente', '[]'],
    ['recepcao_pendente', ''], ['ultimo_numero_chamado', '0'],
    ['total_fichas', '20'], ['num_mesas', '6'],
    ['ultimo_nome', ''], ['ultimo_tipo_agenda', ''], ['media_atend_seg', '0']
  ];

  // Insere as configurações iniciais, ignorando as que já existem
  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
  
  const insertMany = db.transaction((configs) => {
    for (const conf of configs) {
      insertConfig.run(conf[0], String(conf[1]));
    }
  });

  insertMany(defaults);
  console.log('Banco de dados inicializado com sucesso.');
}

// Só roda a inicialização das tabelas se o banco não for uma cópia pronta ou se precisar garantir as tabelas
initDb();

module.exports = db;
