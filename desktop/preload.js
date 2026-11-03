'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'http-text',
  'github-request',
  'token-has',
  'token-set',
  'token-clear',
  'state-load',
  'state-save',
  'settings-load',
  'settings-save',
  'notify',
  'open-external',
  'set-always-on-top',
  'toggle-mini',
  'mini-open',
  'mini-close',
  'mini-expand',
  'app-info',
]);

contextBridge.exposeInMainWorld('mobellDesktop', {
  platform: 'windows',
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`不允许的通道：${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, callback) {
    if (channel !== 'mode') return () => {};
    const listener = (event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
