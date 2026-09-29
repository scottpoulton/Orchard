const { app, BrowserWindow } = require('electron');
console.log('[TEST] start');

app.whenReady().then(() => {
  console.log('[TEST] whenReady');
  const win = new BrowserWindow({ width: 400, height: 300 });
  win.loadURL('data:text/html,<h1>Minimal Test</h1>');
});

process.on('exit', (code) => console.log('[TEST] process exit code', code));