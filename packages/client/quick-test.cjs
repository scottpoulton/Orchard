const { app, BrowserWindow } = require('electron');

console.log('[TEST] starting (electron:', process.versions.electron, ', chrome:', process.versions.chrome, ')');

app.whenReady().then(() => {
  console.log('[TEST] whenReady');
  const win = new BrowserWindow({ width: 420, height: 260, center: true, show: true });
  win.loadURL('data:text/html,<h1>Electron OK</h1>');
});

app.on('window-all-closed', () => { console.log('[TEST] closed'); app.quit(); });