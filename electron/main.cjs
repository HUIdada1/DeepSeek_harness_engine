// DSH Dock 主进程：窗口 / 托盘 / 单实例 / IPC 装配
'use strict'
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const config = require('./backend/config.cjs')
const env = require('./backend/env.cjs')
const service = require('./backend/service.cjs')
const updater = require('./backend/updater.cjs')

const SMOKE = process.env.DSH_DOCK_SMOKE === '1'
const E2E = process.env.DSH_DOCK_E2E === '1'
// 自动化测试模式：不显示窗口、不创建托盘，全部后台静默运行
const HEADLESS = SMOKE || E2E
let mainWindow = null
let serviceWindow = null
let tray = null
let quitting = false
let lastAutoOpenedUrl = '' // 服务页内嵌窗口：每次 running 只自动打开一次，重启换 token 后重开
let adoptDone = false // 开机自启/回连（adopt）静默恢复，不触发自动开窗；用户主动启动才开

process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error && error.stack || error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason && reason.stack || reason)
})

// userData 可用环境变量隔离（自动化测试/截图不占用正式版实例与配置）
app.setPath('userData', process.env.DSH_DOCK_USER_DATA || path.join(app.getPath('appData'), 'dsh-dock'))
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
      // running 即在应用内打开服务页（--no-open 已阻止 dsh 拉系统浏览器）；
      // adopt 回连静默恢复不弹窗，仅用户主动启动后的 running 才开
      if (payload.type === 'service' && payload.status === 'running' && payload.url && !HEADLESS) {
        if (adoptDone && payload.url !== lastAutoOpenedUrl) {
          lastAutoOpenedUrl = payload.url
          openServiceWindow(payload.url)
        }
      }
    },
  })
  createWindow()
  createTray()
  wireIpc()

  service.adoptOrphan().finally(() => { adoptDone = true })

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
      mainWindow.webContents.executeJavaScript('JSON.stringify({ ver: document.querySelector("#curVer").textContent, logs: document.querySelectorAll("#logBody .log-line").length, nodeVer: document.querySelector("#nodeBig").textContent, nodeFit: !document.querySelector("#nodeFit").hidden, proj: document.querySelector("#projPathInput").value })')
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
  // 原生标题栏颜色随应用主题（不设置时 Windows 永远是系统色，暗色主题下外框发白）
  nativeTheme.themeSource = configData.theme === 'light' ? 'light' : 'dark'
  mainWindow = new BrowserWindow({
    width: 924,
    height: 722,
    minWidth: 740,
    minHeight: 580,
    backgroundColor: configData.theme === 'light' ? '#f3f4f8' : '#0b0c10',
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
    // 界面目检模式：DSH_DOCK_SHOT=输出路径，渲染稳定后整页截图并退出
    const shotPath = process.env.DSH_DOCK_SHOT
    if (shotPath && !HEADLESS) {
      setTimeout(async () => {
        try {
          if (process.env.DSH_DOCK_SHOT_OPEN === 'settings') {
            await mainWindow.webContents.executeJavaScript("document.querySelector('#settingsBtn').click()")
            await new Promise((resolve) => setTimeout(resolve, 600))
          }
          const image = await mainWindow.webContents.capturePage()
          fs.writeFileSync(shotPath, image.toPNG())
          console.log('[shot] 已输出', shotPath)
        } catch (error) {
          console.error('[shot] 失败：', error.message)
        }
        app.quit()
      }, 2500)
    }
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
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  // 托盘专用 16px 图（HiDPI 自动拾取同目录 tray@2x.png）；缺失时回退大图强制缩放
  const image = nativeImage.createFromPath(path.join(dir, 'build', 'tray.png'))
  if (image.isEmpty()) {
    console.error('[tray] 图标缺失：', path.join(dir, 'build', 'tray.png'))
    return nativeImage.createFromPath(path.join(dir, 'build', 'icon.png')).resize({ width: 16, height: 16 })
  }
  return image
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
  const url = service.getStatus().url
  const updatePhase = updater.getStatus().phase
  tray.setToolTip('DSH Dock 引擎坞 · 服务' + ({ running: '运行中', starting: '启动中', degraded: '异常', stopping: '停止中', stopped: '已停止' }[serviceStatus] || serviceStatus) + (updatePhase === 'available' || updatePhase === 'downloaded' ? ' · 有更新' : ''))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开界面', click: () => showWindow() },
    { label: '打开服务页面', enabled: Boolean(url), click: () => openServiceWindow(service.getStatus().url) },
    { type: 'separator' },
    // 勾选即运行状态：勾上点击=启动，取消勾选=停止（stopping 期不可再点）
    { label: '运行服务', type: 'checkbox', checked: running, enabled: serviceStatus !== 'stopping', click: (item) => {
      if (item.checked) startFromConfig().finally(refreshTray) // 启动失败时状态事件不触发，主动重建菜单回正勾选
      else service.stop('tray')
    } },
    { label: '重启服务', enabled: running, click: () => service.restart() },
    { type: 'separator' },
    // 勾选状态以系统注册为准（config 只做回滚缓存），否则安装器注册的自启不会显示勾选
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => quitWithAsk() },
  ]))
}

// 服务页内嵌窗口：替代系统浏览器。重启后 token 变化 → loadURL 刷新到最新地址
function openServiceWindow(url) {
  if (!url || !/^https?:\/\//.test(url)) return
  if (serviceWindow && !serviceWindow.isDestroyed()) {
    serviceWindow.loadURL(url).catch(() => {})
    serviceWindow.show()
    serviceWindow.focus()
    return
  }
  serviceWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'DSH 服务',
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  serviceWindow.loadURL(url).catch(() => {})
  serviceWindow.on('closed', () => { serviceWindow = null })
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

// ---- 开机自启：注册表 Run 项（HKCU，无需管理员权限；schtasks ONLOGON 触发器必须管理员，普通权限必报「拒绝访问」）----
function setAutostart(enabled) {
  if (!app.isPackaged) {
    broadcast({ type: 'log', level: 'warn', line: '[autostart] 开发模式不注册开机自启' })
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
    const actual = app.getLoginItemSettings().openAtLogin
    if (actual !== enabled) {
      config.saveConfig({ autostart: actual }) // 注册未生效时回滚，UI 与真实状态一致
      broadcast({ type: 'config-changed', config: config.getConfig() })
      broadcast({ type: 'log', level: 'err', line: '[autostart] 注册未生效，已回退为' + (actual ? '开启' : '关闭') })
    } else {
      broadcast({ type: 'log', level: 'info', line: enabled ? '[autostart] 已开启开机自启：登录 Windows 后自动拉起' : '[autostart] 已关闭开机自启' })
    }
  } catch (error) {
    config.saveConfig({ autostart: false })
    broadcast({ type: 'config-changed', config: config.getConfig() })
    broadcast({ type: 'log', level: 'err', line: '[autostart] 设置失败：' + error.message })
  }
  refreshTray()
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
    if (clean.theme) {
      nativeTheme.themeSource = clean.theme // 原生标题栏随应用主题切换
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(clean.theme === 'light' ? '#e7e9ed' : '#0a0c10')
    }
    broadcast({ type: 'config-changed', config: next })
    return next
  })
  ipcMain.handle('service:start', (_event, overrides) => startFromConfig(overrides || {}))
  ipcMain.handle('service:stop', () => service.stop('ui'))
  ipcMain.handle('service:restart', () => service.restart())
  ipcMain.handle('service:openWindow', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) openServiceWindow(url)
  })
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
  ipcMain.handle('update:check', () => updater.check(true))
  ipcMain.handle('update:download', () => updater.download())
  ipcMain.handle('update:install', () => updater.triggerInstall())
  ipcMain.handle('update:status', () => updater.getStatus())
  ipcMain.handle('update:openReleases', () => updater.openReleases())
}
