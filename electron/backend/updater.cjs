// 应用自更新（机制移植自 AgentHub electron/backend/updater.cjs，已验证）
// - 安装版：electron-updater，下载/安装均由用户在设置中心手动点
// - 便携版：net 模块直连 latest.yml 比版本，仅提示手动下载
// - 节奏：启动 60s 首查，之后每 intervalHours 小时一查；手动检查 30s 冷却
'use strict'
const path = require('node:path')
const { app, BrowserWindow, Notification, nativeImage, shell, net } = require('electron')

const GITHUB_REPO_URL = 'https://github.com/HUIdada1/DeepSeek_harness_engine'
const GITHUB_RELEASES_URL = GITHUB_REPO_URL + '/releases'
// latest 直链永远指最新 Release，不调 API 不受限流影响
const LATEST_YML_URL = GITHUB_RELEASES_URL + '/latest/download/latest.yml'
const MIRROR_PREFIX = 'https://ghproxy.net/' // 直连被墙时的镜像前缀（可在配置关闭）
const FIRST_CHECK_DELAY_MS = 60 * 1000
const MANUAL_COOLDOWN_MS = 30 * 1000
const FETCH_TIMEOUT_MS = 15_000

let autoUpdater = null
try {
  ({ autoUpdater } = require('electron-updater'))
} catch {
  // 依赖缺失时只能提示手动更新
}

let onState = () => {}
let status = idleStatus()
let lastManualCheckAt = 0
let installTriggered = false // quitAndInstall 会再触发一次 quit，防重入
let currentCheckIsManual = false
let timer = null

function isPortable() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true
  try {
    const fs = require('node:fs')
    return app.isPackaged && fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'portable.flag'))
  } catch {
    return false
  }
}

function idleStatus() {
  return {
    phase: 'idle', // idle | checking | up-to-date | available | downloading | downloaded | error
    isPortable: isPortable(),
    currentVersion: app.getVersion(),
    latestVersion: '',
    percent: 0,
    notes: '',
    message: '',
  }
}

function notifyIcon() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png')
    return nativeImage.createFromPath(p)
  } catch {
    return nativeImage.createEmpty()
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: notifyIcon() })
  n.on('click', () => { if (showWindow) showWindow() })
  n.show()
}

let showWindow = null

function setState(phase, extra = {}) {
  status = { ...status, ...extra, phase }
  onState(status)
}

// 每次读盘，设置页改完立刻生效
function autoCheckEnabled() {
  try {
    const config = require('./config.cjs').loadConfig()
    return !!(config.update && config.update.autoCheck)
  } catch {
    return true
  }
}
function intervalMs() {
  try {
    const config = require('./config.cjs').loadConfig()
    const hours = Number(config.update && config.update.intervalHours) || 1
    return Math.max(1, hours) * 60 * 60 * 1000
  } catch {
    return 60 * 60 * 1000
  }
}
function mirrorFallbackEnabled() {
  try {
    const config = require('./config.cjs').loadConfig()
    return !!(config.update && config.update.mirrorFallback)
  } catch {
    return true
  }
}

function compareVersions(a, b) {
  const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

// GitHub 把 release notes 渲染成 HTML；还原纯文本，&amp; 必须最后替换防二次解码
function htmlToText(html) {
  let s = String(html)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<h[1-6][^>]*>/gi, '\n')
  s = s.replace(/<\/(h[1-6]|p|div|blockquote|pre|ul|ol|table|tr|li)>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '- ')
  s = s.replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&amp;/g, '&')
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function toNotes(releaseNotes) {
  if (typeof releaseNotes === 'string') return htmlToText(releaseNotes)
  if (Array.isArray(releaseNotes)) {
    return htmlToText(releaseNotes.map((r) => (r && typeof r.note === 'string' ? r.note : '')).filter(Boolean).join('\n'))
  }
  return ''
}

// 同一版本跨会话只提醒一次
function notifyAvailable(version) {
  const config = require('./config.cjs')
  if (config.getConfig().update.notifiedVersion === version) return
  config.saveConfig({ update: { notifiedVersion: version } })
  if (isPortable()) {
    notify('检测到新版本 ' + version, '便携版不支持自动更新，请前往 GitHub 手动下载')
  } else {
    notify('发现新版本 ' + version, '点击打开设置中心查看更新内容')
  }
}

function onUpdateError(error) {
  const message = error && error.message ? error.message : String(error || '未知错误')
  const action =
    status.phase === 'checking' ? '检查更新失败' :
    status.phase === 'downloading' ? '下载更新失败' : '更新失败'
  setState('error', { percent: 0, message: action + '：' + message })
}

function checkInstalled() {
  if (!app.isPackaged) {
    setState('up-to-date', { latestVersion: '', notes: '', percent: 0, message: '开发模式不检查更新' })
    return status
  }
  if (!autoUpdater) {
    setState('error', { percent: 0, message: '更新组件缺失，请前往 GitHub 手动下载更新' })
    return status
  }
  setState('checking')
  autoUpdater.checkForUpdates().catch(() => {})
  return status
}

// 便携版用 Electron net 模块（走系统代理）；latest 直链会 302，手动跟随
function netFetch(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    let done = false
    let guard = null
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(guard)
      fn(value)
    }
    guard = setTimeout(() => {
      if (done) return
      done = true
      try { request.abort() } catch { /* 已结束 */ }
      reject(new Error('请求超时'))
    }, FETCH_TIMEOUT_MS)
    request.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.on('data', () => {})
        res.on('end', () => {
          try {
            const next = new URL(res.headers.location, url).toString()
            finish(() => netFetch(next, redirectsLeft - 1).then(resolve, reject))
          } catch (error) {
            finish(reject, error)
          }
        })
        return
      }
      if (res.statusCode !== 200) {
        res.on('data', () => {})
        res.on('end', () => finish(reject, new Error('HTTP ' + res.statusCode)))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
    })
    request.on('error', (error) => finish(reject, error))
    request.end()
  })
}

async function checkPortable() {
  setState('checking')
  const attempts = [LATEST_YML_URL]
  if (mirrorFallbackEnabled()) attempts.push(MIRROR_PREFIX + LATEST_YML_URL)
  let lastError = null
  for (const url of attempts) {
    try {
      const text = await netFetch(url, 5)
      const match = text.match(/^version:\s*([^\s]+)/m)
      if (!match) throw new Error('版本信息格式异常')
      const latest = match[1].trim()
      if (compareVersions(latest, app.getVersion()) > 0) {
        setState('available', { latestVersion: latest, percent: 0, message: '' })
        if (!currentCheckIsManual) notifyAvailable(latest)
      } else {
        setState('up-to-date', { latestVersion: '', notes: '', percent: 0, message: '' })
      }
      return status
    } catch (error) {
      lastError = error
    }
  }
  onUpdateError(lastError)
  return status
}

function check(manual) {
  // checking/downloading/downloaded 期间重入会让 electron-updater 状态机收到交错事件
  if (status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'downloaded') return status
  if (manual) {
    const now = Date.now()
    if (now - lastManualCheckAt < MANUAL_COOLDOWN_MS) {
      if (status.phase !== 'error') setState(status.phase, { message: '刚刚检查过，请稍后再试' })
      return status
    }
    lastManualCheckAt = now
  }
  currentCheckIsManual = !!manual
  if (isPortable()) return checkPortable()
  return checkInstalled()
}

function download() {
  if (isPortable() || status.phase !== 'available' || !autoUpdater) return status
  autoUpdater.downloadUpdate().catch(() => {})
  return status
}

function triggerInstall() {
  if (installTriggered || !autoUpdater || status.phase !== 'downloaded') return status
  installTriggered = true
  // 复位提醒去重：万一安装器被拦未装上，下次启动还能提醒
  require('./config.cjs').saveConfig({ update: { notifiedVersion: '' } })
  autoUpdater.quitAndInstall(true, true)
  // 杀软拦截时 electron-updater 只发 error 不退出；10s 后还活着说明没走起来
  setTimeout(() => {
    if (installTriggered) {
      installTriggered = false
      onUpdateError(new Error('安装程序未能启动'))
    }
  }, 10 * 1000)
  return status
}

function openReleases() {
  shell.openExternal(GITHUB_RELEASES_URL)
}

function bindUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => setState('checking'))
  autoUpdater.on('update-available', (info) => {
    setState('available', { latestVersion: info.version, notes: toNotes(info.releaseNotes), percent: 0, message: '' })
    if (!currentCheckIsManual) notifyAvailable(info.version)
  })
  autoUpdater.on('update-not-available', () => setState('up-to-date', { latestVersion: '', notes: '', percent: 0, message: '' }))
  autoUpdater.on('download-progress', (progress) => {
    setState('downloading', { percent: Number.isFinite(progress.percent) ? Math.round(progress.percent) : 0, message: '' })
  })
  autoUpdater.on('update-downloaded', () => {
    setState('downloaded', { percent: 100, message: '' })
    notify('新版本已就绪', '可在设置中心立即重启安装')
  })
  autoUpdater.on('error', (error) => onUpdateError(error))
}

function init(options) {
  showWindow = options.onShowWindow || null
  onState = options.onState || (() => {})
  status = idleStatus()
  if (autoUpdater) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    bindUpdaterEvents()
  }
  if (app.isPackaged) {
    timer = setTimeout(function tick() {
      if (autoCheckEnabled() && status.phase !== 'downloading' && status.phase !== 'downloaded') {
        check(false)
      }
      timer = setTimeout(tick, intervalMs())
    }, FIRST_CHECK_DELAY_MS)
  }
}

function getStatus() {
  return status
}

module.exports = { init, check, download, triggerInstall, getStatus, openReleases, isPortable, GITHUB_RELEASES_URL }
