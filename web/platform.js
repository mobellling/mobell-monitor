'use strict';

const { b64encode, b64decode } = require('../core/util');
const { VERSION } = require('../core/config');

const REQUEST_TIMEOUT = 45000;

function createJsonStore(load, save) {
  let cache = null;
  return {
    async get(key, fallback) {
      if (cache === null) {
        try {
          cache = (await load()) || {};
        } catch (error) {
          cache = {};
        }
      }
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
    },
    async set(key, value) {
      if (cache === null) {
        try {
          cache = (await load()) || {};
        } catch (error) {
          cache = {};
        }
      }
      cache[key] = value;
      await save(cache);
    },
    async all() {
      if (cache === null) {
        try {
          cache = (await load()) || {};
        } catch (error) {
          cache = {};
        }
      }
      return cache;
    },
  };
}

function browserPlatform() {
  const stateKey = 'mobell-state-v1';
  const settingsKey = 'mobell-settings-v1';
  const read = (key) => {
    try {
      return JSON.parse(window.localStorage.getItem(key) || '{}') || {};
    } catch (error) {
      return {};
    }
  };
  const write = (key, value) => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // 存储配额不足时忽略
    }
  };
  return {
    kind: 'browser',
    demo: true,
    version: VERSION,
    async httpText(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        throw new Error(error.name === 'AbortError' ? '请求超时' : `网络请求失败：${error.message}`);
      } finally {
        clearTimeout(timer);
      }
    },
    github: {
      async request({ method = 'GET', path }) {
        if (method !== 'GET') {
          throw new Error('网页预览版为只读模式，发布请使用桌面版或移动端');
        }
        const response = await fetch(`https://api.github.com${path}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          credentials: 'omit',
        });
        let json = null;
        try {
          json = await response.json();
        } catch (error) {
          json = null;
        }
        return { status: response.status, json };
      },
    },
    async testToken() {
      throw new Error('浏览器预览模式不支持 Token 校验');
    },
    token: {
      async has() {
        return Boolean(window.sessionStorage.getItem('mobell-token'));
      },
      async set(value) {
        window.sessionStorage.setItem('mobell-token', value);
      },
      async clear() {
        window.sessionStorage.removeItem('mobell-token');
      },
    },
    storage: createJsonStore(async () => read(stateKey), async (value) => write(stateKey, value)),
    settingsStore: createJsonStore(async () => read(settingsKey), async (value) => write(settingsKey, value)),
    async notify(title, body) {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body });
    },
    openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },
    isMini: false,
    async toggleMini() {},
    onMode() {},
    async updateWidget() {},
    invokeDesktop() {
      return Promise.resolve(null);
    },
  };
}

function windowsPlatform(api) {
  const invoke = (channel, payload) => api.invoke(channel, payload);
  async function httpText(url) {
    const result = await invoke('http-text', { url });
    if (!result || result.ok === false) throw new Error((result && result.error) || '网络请求失败');
    if (result.status >= 400) throw new Error(`HTTP ${result.status}`);
    return result.text;
  }
  const storage = createJsonStore(
    async () => invoke('state-load'),
    async (value) => invoke('state-save', value),
  );
  const settingsStore = createJsonStore(
    async () => invoke('settings-load'),
    async (value) => invoke('settings-save', value),
  );
  return {
    kind: 'windows',
    demo: false,
    version: VERSION,
    httpText,
    github: {
      async request({ method, path, body }) {
        const result = await invoke('github-request', { method, path, body });
        if (!result) throw new Error('GitHub 请求没有返回');
        return result;
      },
    },
    async testToken() {
      return invoke('github-request', { method: 'GET', path: '/user' });
    },
    token: {
      has: () => invoke('token-has'),
      set: (value) => invoke('token-set', value),
      clear: () => invoke('token-clear'),
    },
    storage,
    settingsStore,
    notify: (title, body) => invoke('notify', { title, body }),
    openExternal: (url) => invoke('open-external', { url }),
    isMini: new URLSearchParams(window.location.search).get('mini') === '1',
    toggleMini: () => invoke('mini-toggle'),
    onMode(callback) {
      if (typeof api.on === 'function') api.on('mode', callback);
    },
    updateWidget: async () => {},
    invokeDesktop(channel, payload) {
      return invoke(channel, payload);
    },
  };
}

function androidPlatform(bridge) {
  const callbacks = new Map();
  let seq = 0;
  window.__mobellResolve = function resolve(id, payloadJson) {
    const entry = callbacks.get(id);
    if (!entry) return;
    callbacks.delete(id);
    clearTimeout(entry.timer);
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (error) {
      entry.reject(new Error('原生响应解析失败'));
      return;
    }
    if (payload && payload.ok) entry.resolve(payload);
    else entry.reject(new Error((payload && payload.error) || '请求失败'));
  };

  function nativeAsync(method, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      seq += 1;
      const id = `r${Date.now()}-${seq}`;
      const timer = setTimeout(() => {
        callbacks.delete(id);
        reject(new Error('请求超时'));
      }, timeoutMs || REQUEST_TIMEOUT);
      callbacks.set(id, { resolve, reject, timer });
      try {
        bridge[method](id, ...args);
      } catch (error) {
        callbacks.delete(id);
        clearTimeout(timer);
        reject(new Error(error.message || String(error)));
      }
    });
  }

  async function httpText(url) {
    const payload = await nativeAsync('httpRequest', [url]);
    if (payload.status >= 400) throw new Error(`HTTP ${payload.status}`);
    return b64decode(payload.bodyBase64 || '');
  }

  function readJson(method, fallback) {
    try {
      const raw = bridge[method]();
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  const decodeState = () => readJson('getState', {});
  const decodeSettings = () => readJson('getSettings', {});
  const storage = createJsonStore(
    async () => decodeState(),
    async (value) => bridge.setState(JSON.stringify(value)),
  );
  const settingsStore = createJsonStore(
    async () => decodeSettings(),
    async (value) => bridge.setSettings(JSON.stringify(value)),
  );

  return {
    kind: 'android',
    demo: false,
    version: VERSION,
    httpText,
    github: {
      async request({ method, path, body }) {
        const payload = await nativeAsync('githubRequest', [
          String(method || 'GET').toUpperCase(),
          path,
          body ? b64encode(JSON.stringify(body)) : '',
        ]);
        let json = null;
        try {
          json = payload.bodyBase64 ? JSON.parse(b64decode(payload.bodyBase64)) : null;
        } catch (error) {
          json = null;
        }
        return { status: payload.status, json };
      },
    },
    async testToken() {
      return this.github.request({ method: 'GET', path: '/user' });
    },
    token: {
      has: () => {
        try {
          return Boolean(bridge.hasToken());
        } catch (error) {
          return false;
        }
      },
      set: (value) => bridge.setToken(value),
      clear: () => bridge.clearToken(),
    },
    storage,
    settingsStore,
    notify: (title, body) => {
      try {
        bridge.notify(title, body);
      } catch (error) {
        // 通知不可用时忽略
      }
    },
    openExternal: (url) => {
      try {
        bridge.openExternal(url);
      } catch (error) {
        window.open(url, '_blank');
      }
    },
    isMini: false,
    async toggleMini() {},
    onMode() {},
    updateWidget: (data) => {
      try {
        bridge.updateWidget(JSON.stringify(data));
      } catch (error) {
        // 小组件更新失败不影响主界面
      }
    },
    invokeDesktop() {
      return Promise.resolve(null);
    },
  };
}

function iosPlatform(handler) {
  const callbacks = new Map();
  let seq = 0;
  window.__mobellResolve = function resolve(id, payloadJson) {
    const entry = callbacks.get(id);
    if (!entry) return;
    callbacks.delete(id);
    clearTimeout(entry.timer);
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (error) {
      entry.reject(new Error('原生响应解析失败'));
      return;
    }
    if (payload && payload.ok) entry.resolve(payload);
    else entry.reject(new Error((payload && payload.error) || '请求失败'));
  };

  function nativeCall(method, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      seq += 1;
      const id = `i${Date.now()}-${seq}`;
      const timer = setTimeout(() => {
        callbacks.delete(id);
        reject(new Error('请求超时'));
      }, timeoutMs || REQUEST_TIMEOUT);
      callbacks.set(id, { resolve, reject, timer });
      try {
        handler.postMessage({ id, method, args: args || [] });
      } catch (error) {
        callbacks.delete(id);
        clearTimeout(timer);
        reject(new Error(error.message || String(error)));
      }
    });
  }

  async function httpText(url) {
    const payload = await nativeCall('httpRequest', [url]);
    if (payload.status >= 400) throw new Error(`HTTP ${payload.status}`);
    return b64decode(payload.bodyBase64 || '');
  }

  const readState = async () => {
    try {
      const payload = await nativeCall('getState');
      return payload.value ? JSON.parse(payload.value) : {};
    } catch (error) {
      return {};
    }
  };
  const readSettings = async () => {
    try {
      const payload = await nativeCall('getSettings');
      return payload.value ? JSON.parse(payload.value) : {};
    } catch (error) {
      return {};
    }
  };
  const storage = createJsonStore(readState, async (value) => nativeCall('setState', [JSON.stringify(value)]));
  const settingsStore = createJsonStore(
    readSettings,
    async (value) => nativeCall('setSettings', [JSON.stringify(value)]),
  );

  return {
    kind: 'ios',
    demo: false,
    version: VERSION,
    httpText,
    github: {
      async request({ method, path, body }) {
        const payload = await nativeCall('githubRequest', [
          String(method || 'GET').toUpperCase(),
          path,
          body ? b64encode(JSON.stringify(body)) : '',
        ]);
        let json = null;
        try {
          json = payload.bodyBase64 ? JSON.parse(b64decode(payload.bodyBase64)) : null;
        } catch (error) {
          json = null;
        }
        return { status: payload.status, json };
      },
    },
    async testToken() {
      return this.github.request({ method: 'GET', path: '/user' });
    },
    pickFiles(kind, multiple) {
      return nativeCall('pickFiles', [kind, Boolean(multiple)], 120000);
    },
    token: {
      async has() {
        try {
          const payload = await nativeCall('hasToken');
          return Boolean(payload.value);
        } catch (error) {
          return false;
        }
      },
      set: (value) => nativeCall('setToken', [value]),
      clear: () => nativeCall('clearToken'),
    },
    storage,
    settingsStore,
    notify(title, body) {
      nativeCall('notify', [title, body]).catch(() => {});
    },
    openExternal(url) {
      nativeCall('openExternal', [url]).catch(() => {});
    },
    isMini: false,
    async toggleMini() {},
    onMode() {},
    async updateWidget() {},
    invokeDesktop() {
      return Promise.resolve(null);
    },
  };
}

function createPlatform() {
  if (typeof window !== 'undefined' && window.mobellDesktop) {
    return windowsPlatform(window.mobellDesktop);
  }
  if (typeof window !== 'undefined' && window.MobellAndroid) {
    return androidPlatform(window.MobellAndroid);
  }
  if (
    typeof window !== 'undefined'
    && window.webkit
    && window.webkit.messageHandlers
    && window.webkit.messageHandlers.mobell
  ) {
    return iosPlatform(window.webkit.messageHandlers.mobell);
  }
  return browserPlatform();
}

module.exports = { createPlatform };
