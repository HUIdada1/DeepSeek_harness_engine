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
  openService: (url) => ipcRenderer.invoke('service:openWindow', url),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:openReleases'),
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('app:event', handler)
    return () => ipcRenderer.removeListener('app:event', handler)
  },
})
