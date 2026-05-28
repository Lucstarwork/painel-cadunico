require('dotenv').config();
const { app, BrowserWindow } = require('electron');
const path = require('path');

// Prevent Windows cache lock errors (Acesso negado)
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');

// 1. Inicia o servidor Express na mesma instância (irá escutar na porta definida no .env)
require('./server.js');

let mainWindow;

function createWindow() {
  // 2. Cria a janela do Electron (BrowserWindow)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'Painel Cadunico',
    icon: path.join(__dirname, 'build/icon.ico'),
    kiosk: true, // 3. Modo tela cheia automático (ideal para TV)
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false, // Segurança: scripts da página não têm acesso direto ao Node
      contextIsolation: true
    }
  });

  const port = process.env.PORT || 3000;
  
  // 4. Carrega a URL local do painel da TV
  mainWindow.loadURL(`http://localhost:${port}/display`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // No macOS, é comum recriar a janela quando o ícone do dock é clicado e não há outras janelas abertas.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Fecha o aplicativo quando todas as janelas forem fechadas, exceto no macOS
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
