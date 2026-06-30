require('dotenv').config();
const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');

require('./server.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'Painel Cadunico',
    icon: path.join(__dirname, 'build/icon.ico'),
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const port = process.env.PORT || 3000;
  mainWindow.loadURL(`http://localhost:${port}/display`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function configurarAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => console.log('[updater] verificando...'));
  autoUpdater.on('update-available', (i) => console.log('[updater] disponível:', i.version));
  autoUpdater.on('update-not-available', (i) => console.log('[updater] sem update, versão atual:', i.version));
  autoUpdater.on('error', (err) => console.log('[updater] erro:', err.message));
  autoUpdater.on('download-progress', (p) => console.log('[updater] download:', Math.round(p.percent) + '%'));
  autoUpdater.on('update-downloaded', async () => {
    console.log('[updater] download concluído, aguardando confirmação do usuário...');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Instalar agora', 'Mais tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Atualização pronta',
      message: 'Uma nova versão foi baixada e está pronta para instalar.',
      detail: 'Clique em "Instalar agora" para reiniciar o aplicativo e aplicar a atualização.'
    });
    if (response === 0) {
      console.log('[updater] usuário confirmou — instalando...');
      autoUpdater.quitAndInstall(true, true);
    } else {
      console.log('[updater] usuário adiou a instalação.');
    }
  });

  autoUpdater.checkForUpdates().catch((err) => console.log('[updater] checkForUpdates falhou:', err.message));
}

app.whenReady().then(() => {
  createWindow();
  configurarAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
