// 配置持久化：%APPDATA%\dsh-dock\config.json
// 所有字段"自动获取 + 可自定义"双通道；setConfig 合并写入，读方每次读盘即时生效。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

// userData 固定为 %APPDATA%\dsh-dock（不受 productName 空格影响）
function appDataDir() {
  return path.join(app.getPath('appData'), 'dsh-dock')
}
function ensureDirs() {
  for (const dir of [appDataDir(), path.join(appDataDir(), 'logs')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return appDataDir()
}
function configFile() {
  return path.join(appDataDir(), 'config.json')
}

function defaults() {
  return {
    projectDir: '',
    launchMode: 'source', // source | npm
    node: { path: '', version: '' },
    proxy: '',
    closeBehavior: 'tray', // tray | exit | ask
    keepServiceOnClose: true, // 方案 A 结构性恒真，仅用于 UI 展示
    autostart: false,
    autoRestart: { enabled: true, maxRetries: 3 },
    theme: 'dark',
    update: {
      autoCheck: true,
      intervalHours: 1,
      notifiedVersion: '',
      mirrorFallback: true,
    },
    recentProjects: [],
  }
}

function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value)
    if (isPlainObject && base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

let cached = null

function loadConfig() {
  let disk = {}
  try {
    disk = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // 配置损坏时重置为默认，不阻塞启动；旧文件保留为 .broken 供排查
      try { fs.renameSync(configFile(), configFile() + '.broken') } catch { /* 重命名失败则直接覆盖 */ }
    }
    disk = {}
  }
  cached = mergeDeep(defaults(), disk)
  return cached
}

function getConfig() {
  return cached || loadConfig()
}

function saveConfig(patch) {
  const next = mergeDeep(getConfig(), patch)
  ensureDirs()
  const tmp = configFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, configFile())
  cached = next
  return next
}

// 最近项目去重记录，最多 8 条
function rememberProject(dir) {
  if (!dir) return
  const list = getConfig().recentProjects.filter((d) => d !== dir)
  list.unshift(dir)
  saveConfig({ recentProjects: list.slice(0, 8) })
}

module.exports = { appDataDir, ensureDirs, configFile, loadConfig, getConfig, saveConfig, rememberProject, defaults }
