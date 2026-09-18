// DSH Dock 主进程：窗口 / 托盘 / 单实例 / IPC 装配
'use strict'
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const config = require('./backend/config.cjs')
const env = require('./backend/env.cjs')
const service = require('./backend/service.cjs')
const updater = require('./backend/updater.cjs')

const SMOKE = process.env.DSH_DOCK_SMOKE === '1'
const E2E = process.env.DSH_DOCK_E2E === '1'
// 自动化测试模式：不显示窗口、不创建托盘，全部后台静默运行
const HEADLESS = SMOKE || E2E
let mainWindow = null
let tray = null
let quitting = false

process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error && error.stack || error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason && reason.stack || reason)
})

app.setPath('userData', path.join(app.getPath('appData'), 'dsh-dock'))
config.ensureDirs()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(onReady)
}

app.on('before-quit', () => { quitting = true })

app.on('window-all-closed', () => {
  // tray/ask 模式下 close 已被 preventDefault，不会到达这里；到达即 exit 模式或测试模式
  app.quit()
})

function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:event', payload)
  }
  if (payload.type !== 'log') refreshTray() // 日志高频，托盘菜单只随状态重建
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function onReady() {
  service.init({
    dataDir: config.appDataDir(),
    onEvent: (payload) => {
      broadcast(payload) // 非 log 事件内部已刷新托盘
    },
  })
  createWindow()
  createTray()
  wireIpc()

  service.adoptOrphan()

  updater.init({
    onState: (status) => broadcast({ type: 'update', ...status }),
    onShowWindow: showWindow,
  })

  if (SMOKE) {
    setTimeout(() => {
      console.log('[smoke] main ready: window+tray+service+updater OK')
    }, 1500)
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { app.quit(); return }
      mainWindow.webContents.executeJavaScript('JSON.stringify({ foot: document.querySelector("#footLine").textContent, logs: document.querySelectorAll("#logBody .log-line").length, nodeVer: document.querySelector("#nodeBig").textContent, nodeFit: !document.querySelector("#nodeFit").hidden, proj: document.querySelector("#projPathInput").value })')
        .then((summary) => console.log('[renderer state]', summary))
        .catch(() => {})
        .finally(() => app.quit())
    }, 8000)
  }

  if (process.env.DSH_DOCK_E2E === '1') {
    // 端到端：真实启动 dsh web → 等待 running → 停止 → 退出
    const project = process.env.DSH_DOCK_PROJECT || ''
    const deadline = Date.now() + 180_000
    setTimeout(async () => {
      const result = await startFromConfig({ projectDir: project, mode: 'source' })
      console.log('[e2e] start →', JSON.stringify(result.error ? result : result.status))
    }, 1000)
    const watcher = setInterval(async () => {
      const status = service.getStatus()
      if (Date.now() > deadline) {
        console.log('[e2e] TIMEOUT status=' + status.status)
        clearInterval(watcher)
        await service.stop('e2e-timeout').catch(() => {})
        app.exit(1)
        return
      }
      if (status.status === 'running') {
        console.log('[e2e] running url=' + status.url)
        clearInterval(watcher)
        setTimeout(async () => {
          await service.stop('e2e')
          console.log('[e2e] stopped OK')
          app.exit(0)
        }, 3000)
      }
    }, 1000)
  }
}

function createWindow() {
  const configData = config.loadConfig()
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 940,
    minWidth: 940,
    minHeight: 700,
    backgroundColor: configData.theme === 'light' ? '#e7e9ed' : '#0a0c10',
    autoHideMenuBar: true,
    show: false,
    skipTaskbar: HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  if (SMOKE) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log('[renderer:' + level + ']', message, '@', sourceId + ':' + line)
    })
    mainWindow.webContents.executeJavaScript('JSON.stringify(Object.keys(window.dock || {}))')
      .then((keys) => console.log('[dock keys]', keys))
      .catch(() => {})
  }
  mainWindow.once('ready-to-show', () => {
    if (!HEADLESS) mainWindow.show()
  })
  // 关闭行为：tray 隐藏 / exit 退出 / ask 询问（可记住选择）
  mainWindow.on('close', (event) => {
    if (quitting || SMOKE) return
    const behavior = config.getConfig().closeBehavior
    if (behavior === 'tray') {
      event.preventDefault()
      mainWindow.hide()
      return
    }
    if (behavior === 'ask') {
      event.preventDefault()
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '关闭 DSH Dock',
        message: '关闭窗口时如何处理？',
        detail: '服务是独立后台进程，最小化到托盘不会中断它。',
        buttons: ['最小化到托盘', '直接退出', '取消'],
        defaultId: 0,
        cancelId: 2,
        checkboxLabel: '记住我的选择',
      }).then(({ response, checkboxChecked }) => {
        if (response === 2) return
        if (checkboxChecked) {
          config.saveConfig({ closeBehavior: response === 0 ? 'tray' : 'exit' })
          broadcast({ type: 'config-changed', config: config.getConfig() })
        }
        if (response === 0) mainWindow.hide()
        else app.quit()
      })
    }
    // behavior === 'exit'：不拦截，走默认关闭 → before-quit → quit
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function trayIcon() {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png')
  return nativeImage.createFromPath(p)
}

function createTray() {
  if (HEADLESS) return
  const image = trayIcon()
  if (image.isEmpty()) {
    console.error('[tray] 图标缺失：', app.isPackaged ? process.resourcesPath : 'build/')
  }
  tray = new Tray(image)
  tray.setToolTip('DSH Dock 引擎坞')
  tray.on('click', () => showWindow())
  refreshTray()
}

function refreshTray() {
  if (!tray) return
  const serviceStatus = service.getStatus().status
  const running = serviceStatus === 'running' || serviceStatus === 'starting'
  const updatePhase = updater.getStatus().phase
  tray.setToolTip('DSH Dock 引擎坞 · 服务' + ({ running: '运行中', starting: '启动中', degraded: '异常', stopping: '停止中', stopped: '已停止' }[serviceStatus] || serviceStatus) + (updatePhase === 'available' || updatePhase === 'downloaded' ? ' · 有更新' : ''))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开界面', click: () => showWindow() },
    { type: 'separator' },
    { label: '启动服务', enabled: serviceStatus === 'stopped', click: () => startFromConfig() },
    { label: '停止服务', enabled: serviceStatus !== 'stopped', click: () => service.stop('tray') },
    { label: '重启服务', enabled: serviceStatus === 'running' || serviceStatus === 'starting', click: () => service.restart() },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: config.getConfig().autostart, click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => quitWithAsk() },
  ]))
}

function quitWithAsk() {
  const serviceStatus = service.getStatus().status
  if (serviceStatus === 'stopped') {
    app.quit()
    return
  }
  dialog.showMessageBox({
    type: 'question',
    title: '退出 DSH Dock',
    message: '退出时是否停止正在运行的服务？',
    detail: '选择"仅退出"后，服务将在后台继续运行；下次打开 DSH Dock 会自动回连。',
    buttons: ['退出并停止服务', '仅退出（服务保持）', '取消'],
    defaultId: 1,
    cancelId: 2,
  }).then(({ response }) => {
    if (response === 2) return
    if (response === 0) service.stop('exit').then(() => app.quit())
    else app.quit()
  })
}

// ---- 开机自启：Task Scheduler 登录触发（比注册表 Run 项更可靠地覆盖便携版） ----
function setAutostart(enabled) {
  const taskName = 'DSH Dock Autostart'
  if (!app.isPackaged) {
    broadcast({ type: 'log', level: 'warn', line: '[autostart] 开发模式不注册计划任务' })
    return
  }
  const exe = process.execPath
  if (enabled) {
    execFile('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', '"' + exe + '"'], { windowsHide: true }, (error) => {
      if (error) {
        config.saveConfig({ autostart: false }) // 注册失败回滚，UI 与真实状态一致
        broadcast({ type: 'config-changed', config: config.getConfig() })
        broadcast({ type: 'log', level: 'err', line: '[autostart] 注册失败：' + error.message })
      } else {
        broadcast({ type: 'log', level: 'info', line: '[autostart] 已注册登录启动计划任务' })
      }
      refreshTray()
    })
  } else {
    execFile('schtasks.exe', ['/Delete', '/F', '/TN', taskName], { windowsHide: true }, (error) => {
      broadcast({ type: 'log', level: error && error.code !== 1 ? 'err' : 'info', line: '[autostart] ' + (error && error.code !== 1 ? '移除失败：' + error.message : '已移除登录启动计划任务') })
      refreshTray()
    })
  }
}

// ---- 从配置解析启动参数（Node 目录 / 项目目录 / 模式），并做就绪兜底 ----
async function resolveStartOpts(overrides) {
  const configData = config.getConfig()
  const projectDir = overrides.projectDir || configData.projectDir
  if (!env.validateProjectDir(projectDir)) {
    return { error: '项目目录无效：未找到 @deepseek-ai/dsh-root 仓库，请在「项目目录」中确认' }
  }
  const mode = overrides.mode || configData.launchMode || 'source'
  let nodeDir = overrides.nodeDir || configData.node.path || ''
  if (nodeDir && path.basename(nodeDir).toLowerCase() === 'node.exe') {
    nodeDir = path.dirname(nodeDir) // 允许配置到 node.exe 或其目录
  }
  if (!nodeDir || !fs.existsSync(path.join(nodeDir, 'node.exe'))) {
    const detected = await env.detectNode()
    const ok = detected.versions.find((v) => v.satisfies)
    if (!ok) return { error: '未检测到满足 ^22.19 || >=24 的 Node，请先在「Node 环境」中处理' }
    nodeDir = path.dirname(ok.path)
  }
  config.rememberProject(projectDir)
  config.saveConfig({ projectDir, launchMode: mode, node: { path: path.join(nodeDir, 'node.exe') } })
  return { opts: { projectDir, mode, nodeDir } }
}

async function startFromConfig(overrides = {}) {
  const resolved = await resolveStartOpts(overrides)
  if (resolved.error) {
    broadcast({ type: 'log', level: 'err', line: '[start] ' + resolved.error })
    return { error: resolved.error }
  }
  return service.start(resolved.opts)
}

// ---- IPC ----
function wireIpc() {
  ipcMain.handle('app:getInit', async () => {
    const configData = config.getConfig()
    const detected = await env.detectProject(configData.projectDir)
    return {
      version: app.getVersion(),
      isPortable: updater.isPortable(),
      isPackaged: app.isPackaged,
      config: configData,
      service: service.getStatus(),
      update: updater.getStatus(),
      releasesUrl: updater.GITHUB_RELEASES_URL,
      logFile: service.logPath(),
      project: detected,
    }
  })
  const CONFIG_FIELDS = new Set(['projectDir', 'launchMode', 'node', 'proxy', 'closeBehavior', 'keepServiceOnClose', 'autostart', 'autoRestart', 'theme', 'update', 'recentProjects'])
  ipcMain.handle('config:set', (_event, patch) => {
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => CONFIG_FIELDS.has(key)))
    for (const boolField of ['autostart', 'keepServiceOnClose']) {
      if (clean[boolField] !== undefined) clean[boolField] = clean[boolField] === true
    }
    const next = config.saveConfig(clean)
    if (clean.autostart !== undefined) setAutostart(clean.autostart)
    broadcast({ type: 'config-changed', config: next })
    return next
  })
  ipcMain.handle('service:start', (_event, overrides) => startFromConfig(overrides || {}))
  ipcMain.handle('service:stop', () => service.stop('ui'))
  ipcMain.handle('service:restart', () => service.restart())
  ipcMain.handle('env:detectNode', () => env.detectNode())
  ipcMain.handle('env:detectProject', (_event, dir) => env.detectProject(dir))
  ipcMain.handle('env:readiness', async (_event, payload) => env.checkReadiness(payload))
  ipcMain.handle('init:run', async (event, payload) => {
    if (!env.validateProjectDir(payload.projectDir)) {
      return { ok: false, failedStep: 'project', code: -1 }
    }
    const configData = config.getConfig()
    let nodeDir = configData.node.path ? path.dirname(configData.node.path) : ''
    const onLine = (line) => {
      if (!event.sender.isDestroyed()) event.sender.send('app:event', { type: 'log', line })
    }
    const onStep = (step, pct) => {
      if (!event.sender.isDestroyed()) event.sender.send('app:event', { type: 'init', step, pct })
    }
    const result = await env.runInit({ projectDir: payload.projectDir, mode: payload.mode, nodeDir, onStep, onLine })
    broadcast({ type: 'init-done', ...result })
    return result
  })
  ipcMain.handle('dialog:pickDir', async () => {
    const options = { properties: ['openDirectory'] }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('log:export', async () => {
    if (!fs.existsSync(service.logPath())) return null
    const options = { defaultPath: 'dsh-web-' + new Date().toISOString().slice(0, 10) + '.log' }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    fs.copyFileSync(service.logPath(), result.filePath)
    return result.filePath
  })
  ipcMain.handle('log:openFolder', () => shell.openPath(path.dirname(service.logPath())))
  ipcMain.handle('shell:open', (_event, url) => {
    if (!/^https?:\/\//.test(url)) return
    shell.openExternal(url)
  })
  ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize() })
  ipcMain.handle('win:hide', () => { if (mainWindow) mainWindow.hide() })
  ipcMain.handle('win:close', () => { if (mainWindow) mainWindow.close() })
  ipcMain.handle('update:check', () => updater.check(true))
  ipcMain.handle('update:download', () => updater.download())
  ipcMain.handle('update:install', () => updater.triggerInstall())
  ipcMain.handle('update:status', () => updater.getStatus())
  ipcMain.handle('update:openReleases', () => updater.openReleases())
}
