'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, safeStorage, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ALLOWED_HOSTS = new Set([
  'mobellling.github.io',
  'events.vercount.one',
  'github.com',
  'api.github.com',
  'giscus.app',
]);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const REQUEST_TIMEOUT = 25000;

let mainWindow = null;
let miniWindow = null;
let tray = null;
let quitting = false;

function logLine(...parts) {
  try {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'renderer.log'), line, 'utf8');
  } catch (error) {
    // 日志失败不影响运行
  }
}

function wireLogging(window, label) {
  window.webContents.on('console-message', (event, level, message, line, sourceId) => {
    logLine(label, `console(${level})`, message, `${sourceId}:${line}`);
  });
  window.webContents.on('did-fail-load', (event, code, description, url) => {
    logLine(label, 'did-fail-load', code, description, url);
  });
  window.webContents.on('render-process-gone', (event, details) => {
    logLine(label, 'render-process-gone', JSON.stringify(details));
  });
  window.webContents.on('preload-error', (event, preloadPath, error) => {
    logLine(label, 'preload-error', preloadPath, error && error.message);
  });
}

function storePath() {
  return path.join(app.getPath('userData'), 'mobell-monitor.json');
}

function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      state: data.state && typeof data.state === 'object' ? data.state : {},
      settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
      token: typeof data.token === 'string' ? data.token : '',
    };
  } catch (error) {
    return { state: {}, settings: {}, token: '' };
  }
}

function writeStore(store) {
  const target = storePath();
  const temp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(store), 'utf8');
  fs.renameSync(temp, target);
}

function getToken() {
  const store = readStore();
  if (!store.token) return '';
  if (store.token.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(store.token.slice(4), 'base64'));
    } catch (error) {
      return '';
    }
  }
  if (store.token.startsWith('b64:')) {
    return Buffer.from(store.token.slice(4), 'base64').toString('utf8');
  }
  return '';
}

function setToken(token) {
  const store = readStore();
  if (!token) {
    store.token = '';
  } else if (safeStorage.isEncryptionAvailable()) {
    store.token = `enc:${safeStorage.encryptString(token).toString('base64')}`;
  } else {
    store.token = `b64:${Buffer.from(token, 'utf8').toString('base64')}`;
  }
  writeStore(store);
}

function isAllowed(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  } catch (error) {
    return false;
  }
}

async function httpText(url) {
  if (!isAllowed(url)) throw new Error('不允许访问该地址');
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        redirect: 'follow',
      });
      const text = await response.text();
      return { ok: true, status: response.status, text };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError && lastError.name === 'AbortError'
    ? '请求超时'
    : `网络请求失败：${lastError ? lastError.message : '未知错误'}`;
  return { ok: false, error: `${message}（已自动重试一次）` };
}

async function githubRequest({ method, path: apiPath, body }) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.includes('..')) {
    throw new Error('GitHub 接口路径无效');
  }
  const verb = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(verb)) throw new Error('不支持的请求方法');
  const token = getToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'MobellMonitor/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      method: verb,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      json = { message: text.slice(0, 300) };
    }
    return { status: response.status, json };
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'GitHub 请求超时' : `GitHub 请求失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function registerIpc() {
  ipcMain.handle('http-text', async (event, payload) => {
    try {
      const { url } = payload || {};
      if (typeof url !== 'string' || !isAllowed(url)) return { ok: false, error: '不允许访问该地址' };
      return await httpText(url);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('github-request', async (event, payload) => {
    return githubRequest(payload || {});
  });

  ipcMain.handle('token-has', () => Boolean(getToken()));
  ipcMain.handle('token-set', (event, token) => {
    if (typeof token !== 'string' || !token.trim()) throw new Error('Token 不能为空');
    setToken(token.trim());
    return true;
  });
  ipcMain.handle('token-clear', () => {
    const store = readStore();
    store.token = '';
    writeStore(store);
    return true;
  });

  ipcMain.handle('state-load', () => readStore().state);
  ipcMain.handle('state-save', (event, state) => {
    const store = readStore();
    store.state = state && typeof state === 'object' ? state : {};
    writeStore(store);
    return true;
  });
  ipcMain.handle('settings-load', () => readStore().settings);
  ipcMain.handle('settings-save', (event, settings) => {
    const store = readStore();
    store.settings = settings && typeof settings === 'object' ? settings : {};
    writeStore(store);
    return true;
  });

  ipcMain.handle('notify', (event, payload) => {
    if (!Notification.isSupported()) return false;
    const { title, body } = payload || {};
    new Notification({ title: title || 'Mobell 博客监控', body: body || '' }).show();
    return true;
  });

  ipcMain.handle('open-external', (event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });

  ipcMain.handle('set-always-on-top', (event, value) => {
    if (mainWindow) mainWindow.setAlwaysOnTop(Boolean(value));
    return true;
  });

  ipcMain.handle('toggle-mini', () => {
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.close();
      return false;
    }
    openMini();
    return true;
  });
  ipcMain.handle('mini-open', () => {
    openMini();
    return true;
  });
  ipcMain.handle('mini-close', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
    return true;
  });
  ipcMain.handle('mini-expand', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
    showMain();
    return true;
  });
  ipcMain.handle('app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
  }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 780,
    minWidth: 720,
    minHeight: 540,
    backgroundColor: '#f6f7fb',
    title: 'Mobell 博客监控',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  wireLogging(mainWindow, 'main');
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'web', 'app.html'));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function openMini() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show();
    miniWindow.focus();
    return miniWindow;
  }
  const display = screen.getPrimaryDisplay();
  const width = 300;
  const height = 196;
  miniWindow = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 18,
    y: display.workArea.y + display.workArea.height - height - 18,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Mobell 博客监控',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  miniWindow.setAlwaysOnTop(true, 'floating');
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wireLogging(miniWindow, 'mini');
  miniWindow.loadFile(path.join(__dirname, '..', 'dist', 'web', 'app.html'), { query: { mini: '1' } });
  miniWindow.on('closed', () => {
    miniWindow = null;
  });
  return miniWindow;
}

function showMain() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function iconPath() {
  return path.join(app.getAppPath(), 'build', 'icon.png');
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Mobell 博客监控');
  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: showMain },
    { label: '显示 / 隐藏悬浮窗', click: () => { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close(); else openMini(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showMain);
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    createTray();
    app.on('activate', showMain);
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', (event) => {
  if (!quitting) event.preventDefault();
});
