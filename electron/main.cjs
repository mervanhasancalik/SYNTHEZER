const { app, BrowserWindow, Tray, Menu, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

let mainWindow = null;
let tray = null;
let serverProcess = null;

/**
 * Find the system Node.js binary (not Electron's embedded one).
 * Works on macOS, Linux, and Windows. Handles nvm, homebrew, system installs.
 */
function findSystemNode() {
  const { execFileSync } = require('child_process');
  const isWin = process.platform === 'win32';

  // Try to resolve via shell
  try {
    let resolved;
    if (isWin) {
      resolved = execFileSync('cmd.exe', ['/c', 'where node'], { encoding: 'utf-8' })
        .split(/\r?\n/)[0].trim();  // `where` can return multiple matches
    } else {
      resolved = execFileSync('/bin/sh', ['-lc', 'which node'], { encoding: 'utf-8' }).trim();
    }
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* ignore */ }

  // Common paths per platform
  const candidates = isWin
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
        path.join(process.env.APPDATA || '', 'nvm', 'current', 'node.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'fnm_multishells', 'node.exe'),
      ]
    : [
        '/opt/homebrew/bin/node',       // macOS ARM (Homebrew)
        '/usr/local/bin/node',          // macOS Intel (Homebrew) / Linux
        '/usr/bin/node',                // Linux system install
        '/snap/bin/node',               // Linux snap install
      ];

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }

  // Last resort — hope 'node' is on PATH
  return 'node';
}

function log(message) {
  try {
    const logDir = app.getPath('userData');
    const logPath = path.join(logDir, 'synthezer.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // ignore logging failures
  }
}

/**
 * Start the Express server.
 *
 * Packaged builds (npm run dist):
 *   electron-builder rebuilds native modules for Electron's Node ABI,
 *   so we can import serve.js directly in-process.
 *
 * Development (npm run desktop):
 *   Native modules are compiled for system Node.js, so we spawn a
 *   child process with the system node binary to avoid ABI mismatch.
 */
function startServer(port, dbPath) {
  const serverPath = path.join(__dirname, '..', 'serve.js');
  const env = {
    ...process.env,
    SYNTHEZER_PORT: String(port),
    SYNTHEZER_DB_PATH: dbPath,
    CLAWZER_PORT: process.env.CLAWZER_PORT || String(port),
    CLAWZER_DB_PATH: process.env.CLAWZER_DB_PATH || dbPath
  };

  if (app.isPackaged) {
    return startServerInProcess(serverPath, env);
  }
  return startServerChildProcess(serverPath, env, port, dbPath);
}

/** Packaged mode: import serve.js in-process (native modules rebuilt for Electron) */
function startServerInProcess(serverPath, env) {
  return new Promise((resolve, reject) => {
    Object.assign(process.env, env);
    log('Starting server in-process (packaged mode)');
    import(serverPath)
      .then(() => {
        log('Server module loaded');
        resolve();
      })
      .catch((err) => {
        log(`In-process server failed: ${err.message}`);
        reject(err);
      });
    // Timeout: if server hasn't loaded in 15s, try health check anyway
    setTimeout(() => resolve(), 15000);
  });
}

/** Development mode: spawn system node child process (avoids ABI mismatch) */
function startServerChildProcess(serverPath, env, port, dbPath) {
  return new Promise((resolve, reject) => {
    const nodePath = findSystemNode();
    log(`Starting server as child process on port ${port} with DB path: ${dbPath} (node: ${nodePath})`);

    serverProcess = spawn(nodePath, [serverPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '..')
    });

    let startupOutput = '';

    serverProcess.stdout.on('data', (data) => {
      startupOutput += data.toString();
      // Server is listening once we see the banner
      if (startupOutput.includes('Synthezer Pipeline')) {
        log('Server started successfully');
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      log(`Server stderr: ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err) => {
      log(`Server process error: ${err.message}`);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      log(`Server process exited with code ${code}`);
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited with code ${code}: ${startupOutput.trim()}`));
      }
      serverProcess = null;
    });

    // Timeout: if server hasn't printed its banner in 10s, try health check anyway
    setTimeout(() => resolve(), 10000);
  });
}

function waitForServer(url, retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, res => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (retries <= 0) return reject(new Error('Server did not start'));
        retries -= 1;
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function checkHealth(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function resolvePort(preferred) {
  if (await checkHealth(preferred)) {
    return { port: preferred, shouldStart: false };
  }
  if (await isPortAvailable(preferred)) {
    return { port: preferred, shouldStart: true };
  }
  for (let port = preferred + 1; port <= preferred + 10; port += 1) {
    if (await isPortAvailable(port)) {
      return { port, shouldStart: true };
    }
  }
  return { port: preferred, shouldStart: true };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#000000',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false,
    frame: false,
    autoHideMenuBar: true,
    center: true,
    skipTaskbar: false,
    title: 'Synthezer',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  
  win.on('ready-to-show', () => {
    log('Window ready-to-show');
    win.show();
    win.focus();
  });
  
  win.on('closed', () => {
    log('Window closed');
    mainWindow = null;
  });
  
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log(`did-fail-load: ${code} ${desc}`);
  });
  
  win.webContents.on('did-finish-load', () => {
    log('did-finish-load');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html><body style="background:#000;color:#fff;font-family:Arial, sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
      <div style="text-align:center;">
        <div style="font-size:14px;letter-spacing:2px;">Synthezer</div>
        <div style="font-size:11px;color:#777;letter-spacing:2px;margin-top:8px;">STARTING LOCAL SERVER...</div>
      </div>
    </body></html>
  `));
  
  // Fallback: force show if ready-to-show never fires
  setTimeout(() => {
    if (win && !win.isVisible()) {
      log('Force showing window after timeout');
      win.show();
      win.focus();
    }
  }, 1500);
  
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Window control IPC handlers
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

app.whenReady().then(async () => {
  app.setAppUserModelId('com.synthezer.app');

  // Set dock icon on macOS (required in dev mode since there's no .app bundle)
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = path.join(__dirname, '..', 'assets', 'icon.png');
    if (fs.existsSync(dockIcon)) {
      const { nativeImage } = require('electron');
      app.dock.setIcon(nativeImage.createFromPath(dockIcon));
    }
  }

  log('App ready');
  mainWindow = createWindow();
  const userDataDir = app.getPath('userData');
  const dbPath = path.join(userDataDir, 'synthezer.db');
  if (!fs.existsSync(dbPath)) {
    const legacyCandidates = [
      path.join(userDataDir, 'clawzer.db'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'ClawZer', 'clawzer.db') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ClawZer', 'clawzer.db') : null
    ].filter(Boolean);
    for (const legacyPath of legacyCandidates) {
      if (fs.existsSync(legacyPath)) {
        try {
          fs.copyFileSync(legacyPath, dbPath);
          log(`Migrated legacy database from ${legacyPath}`);
          break;
        } catch (err) {
          log('Failed to migrate legacy database: ' + err.message);
        }
      }
    }
  }
  const preferredPort = parseInt(process.env.SYNTHEZER_PORT, 10) || 8090;
  const { port, shouldStart } = await resolvePort(preferredPort);
  if (shouldStart) {
    try {
      await startServer(port, dbPath);
    } catch (err) {
      log(`FATAL: Server failed to start: ${err.message}`);
      if (mainWindow) {
        const safeMsg = String(err.message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
          <html><body style="background:#000;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;padding:40px;">
            <div style="text-align:center;max-width:600px;">
              <div style="font-size:16px;color:#f44;margin-bottom:16px;">Server Failed to Start</div>
              <div style="font-size:12px;color:#888;text-align:left;background:#111;padding:16px;border-radius:8px;word-break:break-all;">${safeMsg}</div>
              <div style="font-size:11px;color:#555;margin-top:16px;">${app.isPackaged ? 'Please reinstall the application or report this issue.' : 'Try running: npm rebuild better-sqlite3'}</div>
            </div>
          </body></html>
        `));
      }
      return;
    }
  } else {
    log(`Using existing server on port ${port}`);
  }
  try {
    await waitForServer(`http://localhost:${port}/api/health`);
    log('Server health check ok');
  } catch (e) {
    log('Server health check failed: ' + e.message);
    // still attempt to load the app even if health check isn't ready
  }
  if (mainWindow) {
    mainWindow.loadURL(`http://localhost:${port}`);

    // Restrict navigation to localhost only
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      const parsedUrl = new URL(navigationUrl);
      if (parsedUrl.origin !== `http://localhost:${port}`) {
        event.preventDefault();
      }
    });
  }
  
  // Tray for recovery if window is hidden
  try {
    // macOS "Template" images adapt to menu bar theme automatically
    const trayIconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const iconPath = path.join(__dirname, '..', 'assets', trayIconName);
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
      const menu = Menu.buildFromTemplate([
        { label: 'Show Synthezer', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: 'Quit', click: () => app.quit() }
      ]);
      tray.setToolTip('Synthezer');
      tray.setContextMenu(menu);
      tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    }
  } catch {
    // ignore tray failures
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (serverProcess) {
    log('Stopping server process');
    serverProcess.kill();
    serverProcess = null;
  }
});

