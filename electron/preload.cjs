// 预加载：以 contextBridge 暴露最小 IPC 面，渲染层零 Node 能力
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dock', {
  getInit: () => ipcRenderer.invoke('app:getInit'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  start: (opts) => ipcRenderer.invoke('service:start', opts),
  stop: () => ipcRenderer.invoke('service:stop'),
  restart: () => ipcRenderer.invoke('service:restart'),
  detectNode: () => ipcRenderer.invoke('env:detectNode'),
  detectProject: (dir) => ipcRenderer.invoke('env:detectProject', dir),
  readiness: (payload) => ipcRenderer.invoke('env:readiness', payload),
  runInit: (payload) => ipcRenderer.invoke('init:run', payload),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  exportLog: () => ipcRenderer.invoke('log:export'),
  openLogFolder: () => ipcRenderer.invoke('log:openFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  hideToTray: () => ipcRenderer.invoke('win:hide'),
  close: () => ipcRenderer.invoke('win:close'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:openReleases'),
  onEvent: (callback) => {
    ipcRenderer.on('app:event', (_event, payload) => callback(payload))
  },
})
