// Electron-обёртка персональной версии «Расписание ВГУ».
// Загружает локальный фронтенд (../app) и обращается к API сервиса удалённо.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 420,
        height: 780,
        minWidth: 380,
        minHeight: 620,
        autoHideMenuBar: true,
        title: 'Расписание ВГУ',
        backgroundColor: '#0b0f1a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.setMenuBarVisibility(false);
    // Фронтенд лежит в подпапке app/ проекта (и в dev, и в упакованном asar).
    win.loadFile(path.join(__dirname, 'app', 'index.html'));

    // Вход через Telegram: открываем ссылку бота во внешнем браузере, а не в окне приложения.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    // location.href на внешние ссылки тоже уводим в браузер, само окно остаётся на file://.
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) {
            e.preventDefault();
            if (/^https?:/.test(url)) shell.openExternal(url);
        }
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});