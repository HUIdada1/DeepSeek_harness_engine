// DSH Dock 渲染层：仪器面板 UI 与主进程 IPC 装配
'use strict'
const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => document.querySelectorAll(selector)

const ARC_C = 565.49
const state = {
  config: null,
  service: { status: 'stopped', pid: null, url: '', projectDir: '', mode: 'source' },
  update: { phase: 'idle' },
  initRunning: false,
  checkingCooldown: false,
  lastServiceOpts: null,
}

// ---------- 通用 ----------
function stamp() {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}
function debounce(fn, ms) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
async function setConfig(patch) {
  state.config = await window.dock.setConfig(patch)
  renderConfig()
}

// ---------- 日志 ----------
const logBody = $('#logBody')
let logFilter = 'all'
function classify(line, level) {
  if (level) return level
  if (/\[err|失败|错误|异常退出|error|ECONN|ENOENT|EINVAL/i.test(line)) return 'err'
  if (/warn|重试|超时|attention|回退/i.test(line)) return 'warn'
  if (/HTTP 200|URL 解析成功|完成|passed|恢复/i.test(line)) return 'ok'
  return 'info'
}
function appendLog(line, level) {
  const div = document.createElement('div')
  const resolved = classify(line, level)
  div.dataset.level = resolved
  div.className = 'log-line ' + resolved
  const safe = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  div.innerHTML = '<span class="t">' + stamp() + '</span>' + safe
  if (/dsh web:\s*https?:\/\//i.test(line)) {
    div.innerHTML = div.innerHTML.replace(/(dsh web:\s*https?:\/\/\S+)/, '<span class="url">$1</span>')
  }
  const nearBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 60
  const cursor = logBody.querySelector('.cursor-line')
  if (cursor) cursor.remove()
  logBody.appendChild(div)
  if (logBody.childElementCount > 500) logBody.firstElementChild.remove()
  const tail = document.createElement('div')
  tail.className = 'log-line cursor-line'
  tail.innerHTML = '<span class="cursor"></span>'
  tail.dataset.level = logFilter === 'all' ? 'info' : logFilter
  logBody.appendChild(tail)
  if (nearBottom) logBody.scrollTop = logBody.scrollHeight
  applyFilter()
}
function applyFilter() {
  for (const div of logBody.children) {
    div.style.display = logFilter === 'all' || div.dataset.level === logFilter ? '' : 'none'
  }
}

// ---------- 表盘与服务状态 ----------
const gaugeBtn = $('#gaugeBtn')
const readout = $('#readout')
const arc = $('#gaugeArc')
let upTimer = null

function setActions(on) {
  for (const id of ['restartBtn', 'openBtn', 'copyBtn']) $('#' + id).disabled = !on
}
function renderPill(status) {
  const map = {
    running: ['ok', '运行中'], degraded: ['warn', '异常'],
    starting: ['warn', '启动中'], stopping: ['warn', '停止中'], stopped: ['err', '已停止'],
  }
  const [cls, text] = map[status] || map.stopped
  $('#pillDot').className = 'dot ' + cls
  $('#pillText').textContent = text
  if (status === 'stopped') $('#pillUp').textContent = '00:00:00'
}
function gaugeVisual(status) {
  gaugeBtn.classList.remove('stopped', 'starting', 'running', 'degraded')
  readout.classList.remove('stopped', 'starting')
  renderPill(status)
  if (status === 'stopped') {
    gaugeBtn.classList.add('stopped')
    readout.classList.add('stopped')
    $('#stateText').textContent = '已停止'
    $('#actHint').textContent = '点击启动'
    $('#readUp').textContent = '运行 00:00:00'
    $('#readProbe').textContent = '--'
    $('#specUrl').textContent = '未运行'
    $('#specPid').textContent = '--'
    arc.style.transition = 'stroke-dashoffset 700ms cubic-bezier(0.32,0.72,0,1)'
    arc.style.strokeDashoffset = String(ARC_C)
  } else if (status === 'starting' || status === 'stopping') {
    gaugeBtn.classList.add('starting')
    readout.classList.add('starting')
    $('#stateText').textContent = status === 'starting' ? '启动中' : '停止中'
    $('#actHint').textContent = status === 'starting' ? '正在拉起服务' : '正在终止进程树'
  } else if (status === 'running' || status === 'degraded') {
    gaugeBtn.classList.add(status === 'degraded' ? 'degraded' : 'running')
    $('#stateText').textContent = status === 'running' ? '运行中' : '异常'
    $('#actHint').textContent = '点击停止'
    arc.style.transition = 'stroke-dashoffset 700ms cubic-bezier(0.32,0.72,0,1)'
    arc.style.strokeDashoffset = '0'
  }
  setActions(status === 'running' || status === 'degraded')
}
function renderService(payload) {
  state.service = { ...state.service, ...payload }
  const status = payload.status
  gaugeVisual(status)
  if (status === 'running' || status === 'degraded') {
    $('#readProbe').textContent = status === 'running' ? 'OK' : (payload.probeFails || 0) + '/' + 3
    $('#specUrl').textContent = payload.url || '探测中'
    $('#specUrl').title = payload.url || '' // 地址过长截断显示，悬停看全文
    $('#specPid').textContent = payload.pid || '--'
    if (!upTimer && payload.startedAt) startUptime(payload.startedAt)
  }
  if (status === 'starting') {
    $('#specUrl').textContent = '解析中'
    $('#specUrl').title = ''
    $('#specPid').textContent = payload.pid || '--'
    stopUptime()
    arc.style.transition = 'stroke-dashoffset 1500ms cubic-bezier(0.32,0.72,0,1)'
    arc.style.strokeDashoffset = String(ARC_C * 0.65)
  }
  if (status === 'stopped') {
    stopUptime()
    $('#specUrl').title = ''
  }
}
function startUptime(startedAt) {
  stopUptime()
  const tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    const h = String(Math.floor(seconds / 3600)).padStart(2, '0')
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
    const s = String(seconds % 60).padStart(2, '0')
    const text = '运行 ' + h + ':' + m + ':' + s
    $('#readUp').textContent = text
    $('#pillUp').textContent = h + ':' + m + ':' + s
  }
  tick()
  upTimer = setInterval(tick, 1000)
}
function stopUptime() {
  if (upTimer) { clearInterval(upTimer); upTimer = null }
}

gaugeBtn.addEventListener('click', async () => {
  if (!state.config) return // boot 未完成时不响应
  const status = state.service.status
  if (status === 'starting' || status === 'stopping') return
  if (status === 'running' || status === 'degraded') {
    await window.dock.stop()
    return
  }
  const projectDir = $('#projPathInput').value.trim()
  const mode = state.config.launchMode || 'source'
  const result = await window.dock.start({ projectDir, mode })
  if (result && result.error) appendLog('[start] ' + result.error, 'err')
})

$('#restartBtn').addEventListener('click', () => window.dock.restart())
$('#openBtn').addEventListener('click', () => {
  const url = state.service.url
  if (url) window.dock.openService(url) // 应用内嵌窗口打开，不弹系统浏览器
})
$('#copyBtn').addEventListener('click', async () => {
  const url = state.service.url
  if (!url || $('#copyBtn').classList.contains('copied')) return
  try { await navigator.clipboard.writeText(url) } catch { /* 剪贴板失败静默 */ }
  $('#copyBtn').classList.add('copied')
  setTimeout(() => { $('#copyBtn').classList.remove('copied') }, 1500)
})

// ---------- Node 环境 ----------
function renderNode(info) {
  const current = (info && info.current) || null
  const configuredPath = state.config.node && state.config.node.path
  const activePath = configuredPath || (current && current.path) || ''
  $('#nodePathInput').value = activePath
  const activeVersion = (configuredPath && state.config.node.version) || (current && current.version) || '--'
  $('#nodeBig').textContent = activeVersion
  const satisfies = current ? current.satisfies : false
  $('#nodeFit').hidden = !satisfies
  $('#nodeBad').hidden = satisfies
  $('#nodeLed').classList.toggle('off', !satisfies)
  const bank = $('#verBank')
  bank.textContent = ''
  const versions = (info && info.versions) || []
  versions.slice(0, 6).forEach((item) => {
    const btn = document.createElement('button')
    btn.className = 'lamp-btn' + (item.path === activePath ? ' on' : '')
    btn.innerHTML = '<i class="dot"></i>' + item.version + (item.satisfies ? '' : ' ⚠')
    btn.title = item.path
    btn.addEventListener('click', async () => {
      await setConfig({ node: { path: item.path, version: item.version } })
      renderNode(info)
      appendLog('[env] Node 切换为 ' + item.version + '（' + item.path + '），仅注入服务启动进程', 'info')
    })
    bank.appendChild(btn)
  })
}

$('#detectNodeBtn').addEventListener('click', async () => {
  $('#detectNodeBtn').disabled = true
  const info = await window.dock.detectNode()
  state.nodeInfo = info
  if (!state.config.node.path && info.current) {
    await setConfig({ node: { path: info.current.path, version: info.current.version } })
  }
  renderNode(info)
  $('#detectNodeBtn').disabled = false
})

$('#nodePathInput').addEventListener('change', async () => {
  const value = $('#nodePathInput').value.trim()
  await setConfig({ node: { path: value, version: state.config.node.version } })
  if (state.nodeInfo) renderNode(state.nodeInfo)
  scheduleReadiness()
})

// ---------- 项目 ----------
function renderMode() {
  const mode = state.config.launchMode || 'source'
  for (const btn of $$('#modeBank .lamp-btn')) {
    btn.classList.toggle('on', btn.dataset.mode === mode)
  }
  const specMode = $('#specMode')
  specMode.textContent = { source: '源码', npm: 'NPM' }[mode] || mode
  specMode.title = mode === 'npm' ? 'npx @deepseek-ai/dsh web' : 'pnpm dsh web'
}
for (const btn of $$('#modeBank .lamp-btn')) {
  btn.addEventListener('click', async () => {
    await setConfig({ launchMode: btn.dataset.mode })
    renderMode()
    scheduleReadiness()
  })
}

$('#browseBtn').addEventListener('click', async () => {
  const dir = await window.dock.pickDir()
  if (dir) {
    $('#projPathInput').value = dir
    await setConfig({ projectDir: dir })
    scheduleReadiness()
  }
})
$('#projPathInput').addEventListener('change', async () => {
  await setConfig({ projectDir: $('#projPathInput').value.trim() })
  scheduleReadiness()
})

async function checkReadiness() {
  const projectDir = $('#projPathInput').value.trim()
  if (!projectDir) return
  const mode = state.config.launchMode || 'source'
  const rawPath = (state.config.node && state.config.node.path) || ''
  const trimmed = rawPath.replace(/[\\/]+$/, '')
  const nodeDir = /node\.exe$/i.test(trimmed) ? trimmed.replace(/[\\/][^\\/]*$/, '') : trimmed
  const readiness = await window.dock.readiness({ projectDir, mode, nodeDir })
  renderReadiness(readiness)
}
const scheduleReadiness = debounce(checkReadiness, 600)

function renderReadiness(r) {
  const rows = [
    ['#rdNode', r.nodeVersionOk, r.nodeVersionOk ? '满足' : '不满足'],
    ['#rdPnpm', r.pnpmOk, r.pnpmOk ? (r.pnpmVersion || '已安装') : '未安装'],
    ['#rdDeps', r.depsInstalled, r.depsInstalled ? 'node_modules ✓' : '未安装'],
  ]
  for (const [id, ok, text] of rows) {
    const led = $(id).previousElementSibling
    led.classList.toggle('off', !ok)
    led.classList.toggle('bad', !ok)
    $(id).textContent = text
  }
  const buildLed = $('#rdBuild').previousElementSibling
  if (state.config.launchMode === 'npm') {
    buildLed.className = 'led off'
    $('#rdBuild').textContent = 'npm 模式无需构建'
  } else if (r.buildOk === null) {
    buildLed.className = 'led off'
    $('#rdBuild').textContent = '--'
  } else {
    buildLed.className = 'led' + (r.buildOk ? '' : ' bad')
    $('#rdBuild').textContent = r.buildOk ? 'dsh web --help ✓' : '需构建'
  }
  const allOk = r.nodeVersionOk && r.pnpmOk && r.depsInstalled && (state.config.launchMode === 'npm' || r.buildOk === true)
  $('#projLed').classList.toggle('off', !allOk || state.initRunning)
  $('#initBtn').disabled = state.initRunning || allOk
  if (allOk && !state.initRunning) {
    $('#initFill').style.width = '100%'
    $('#initPct').textContent = '就绪'
    $('#initLab').textContent = '一键初始化 · 已就绪无需执行'
  } else if (!state.initRunning) {
    $('#initFill').style.width = '0%'
    $('#initPct').textContent = '--'
    $('#initLab').textContent = '一键初始化 · install + build'
  }
}

$('#initBtn').addEventListener('click', async () => {
  if (state.initRunning || !state.config) return
  state.initRunning = true
  $('#initBtn').disabled = true
  try {
    const projectDir = $('#projPathInput').value.trim()
    const result = await window.dock.runInit({ projectDir, mode: state.config.launchMode || 'source' })
    if (!result || !result.ok) {
      appendLog('[init] 初始化失败' + (result && result.failedStep ? '于步骤 ' + result.failedStep : ''), 'err')
    } else {
      appendLog('[init] 一键初始化全部完成', 'ok')
    }
  } catch (error) {
    appendLog('[init] 初始化异常：' + ((error && error.message) || error), 'err')
  } finally {
    state.initRunning = false
    scheduleReadiness()
  }
})

// ---------- 日志工具条 ----------
for (const btn of $$('.filter')) {
  btn.addEventListener('click', () => {
    for (const other of $$('.filter')) other.classList.remove('on')
    btn.classList.add('on')
    logFilter = btn.dataset.filter
    applyFilter()
  })
}
$('#clearBtn').addEventListener('click', () => { logBody.textContent = '' })
$('#exportBtn').addEventListener('click', () => window.dock.exportLog())
$('#logFolderBtn').addEventListener('click', () => window.dock.openLogFolder())

// ---------- 设置弹窗（tab 切换） ----------
const overlay = $('#overlay')
$('#settingsBtn').addEventListener('click', () => { overlay.hidden = false })
$('#modalClose').addEventListener('click', () => { overlay.hidden = true })
overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.hidden = true })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !overlay.hidden) overlay.hidden = true
})
for (const tab of $$('.modal-tabs .tab')) {
  tab.addEventListener('click', () => {
    if (tab.classList.contains('on')) return
    for (const other of $$('.modal-tabs .tab')) {
      other.classList.toggle('on', other === tab)
      other.setAttribute('aria-selected', other === tab)
    }
    for (const pane of $$('.m-pane')) {
      pane.classList.toggle('on', pane.id === 'pane-' + tab.dataset.tab)
    }
  })
}

function renderUpdate(update) {
  state.update = update
  $('#updateDot').hidden = !(update.phase === 'available' || update.phase === 'downloaded')
  $('#upLed').classList.toggle('off', !(update.phase === 'available' || update.phase === 'downloaded'))
  $('#curVer').textContent = 'v' + (update.currentVersion || '?')
  const texts = {
    idle: '未检查', checking: '检查中…', 'up-to-date': '已是最新', available: '有可用更新',
    downloading: '下载中 ' + (update.percent || 0) + '%', downloaded: '已下载，待安装', error: '错误',
  }
  $('#updateStateText').textContent = texts[update.phase] || update.phase
  const showLatest = update.phase === 'available' || update.phase === 'downloading' || update.phase === 'downloaded'
  $('#latestRow').hidden = !showLatest
  if (showLatest) $('#latestVer').textContent = update.latestVersion || '--'
  const showNotes = Boolean(update.notes) && update.phase !== 'checking'
  $('#notesWell').hidden = !showNotes
  if (showNotes) $('#notesWell').textContent = update.notes
  const showMeter = update.phase === 'downloading'
  $('#dlMeter').hidden = !showMeter
  if (showMeter) $('#dlFill').style.width = (update.percent || 0) + '%'
  $('#dlBtn').disabled = update.phase !== 'available' || Boolean(update.isPortable) // 便携版不能应用内更新
  $('#installBtn').disabled = update.phase !== 'downloaded'
  $('#checkBtn').disabled = state.checkingCooldown || update.phase === 'checking' || update.phase === 'downloading'
  if (update.message) $('#updateStateText').textContent += '（' + update.message + '）'
}

$('#checkBtn').addEventListener('click', async () => {
  state.checkingCooldown = true
  const status = await window.dock.checkUpdate()
  renderUpdate(status)
  setTimeout(() => { state.checkingCooldown = false; renderUpdate(state.update) }, 30_000)
})
$('#dlBtn').addEventListener('click', () => window.dock.downloadUpdate())
$('#installBtn').addEventListener('click', () => window.dock.installUpdate())
$('#releasesBtn').addEventListener('click', () => window.dock.openReleases())

// ---------- 配置项 ----------
function renderConfig() {
  const config = state.config
  if (!config) return
  const restartCfg = config.autoRestart
  const restartEnabled = restartCfg && restartCfg.enabled !== false
  const restartRetries = restartCfg && Number(restartCfg.maxRetries)
  const restartMax = Number.isFinite(restartRetries) ? restartRetries : 3
  $('#specRestart').textContent = restartEnabled ? '开启 · ≤' + restartMax + ' 次' : '已关闭'
  for (const btn of $$('#closeBank .lamp-btn')) {
    btn.classList.toggle('on', btn.dataset.close === config.closeBehavior)
  }
  $('#autostartSwitch').classList.toggle('on', Boolean(config.autostart))
  $('#autoCheckSwitch').classList.toggle('on', Boolean(config.update && config.update.autoCheck))
  const retries = config.autoRestart && Number(config.autoRestart.maxRetries)
  if (document.activeElement !== $('#maxRetriesInput')) $('#maxRetriesInput').value = Number.isFinite(retries) ? retries : 3
  if (document.activeElement !== $('#proxyInput')) $('#proxyInput').value = config.proxy || ''
  if (document.activeElement !== $('#projPathInput') && config.projectDir) $('#projPathInput').value = config.projectDir
  renderMode()
}
for (const btn of $$('#closeBank .lamp-btn')) {
  btn.addEventListener('click', () => setConfig({ closeBehavior: btn.dataset.close }))
}
$('#autostartSwitch').addEventListener('click', () => {
  setConfig({ autostart: !$('#autostartSwitch').classList.contains('on') })
})
$('#autoCheckSwitch').addEventListener('click', () => {
  setConfig({ update: { autoCheck: !$('#autoCheckSwitch').classList.contains('on') } })
})
$('#proxyInput').addEventListener('change', () => setConfig({ proxy: $('#proxyInput').value.trim() }))
$('#maxRetriesInput').addEventListener('change', () => {
  const value = Math.max(0, Math.min(10, Math.floor(Number($('#maxRetriesInput').value)) || 0))
  $('#maxRetriesInput').value = value
  setConfig({ autoRestart: { maxRetries: value } })
  appendLog('[config] 启动失败自动重试次数：' + (value === 0 ? '已关闭' : value + ' 次'), 'info')
})

// ---------- 主题 ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
}
$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  setConfig({ theme: next })
})

// ---------- 配置页签（环境 / 项目） ----------
for (const tab of $$('.env-tabs .tab')) {
  tab.addEventListener('click', () => {
    if (tab.classList.contains('on')) return
    for (const other of $$('.env-tabs .tab')) {
      other.classList.toggle('on', other === tab)
      other.setAttribute('aria-selected', other === tab)
    }
    for (const pane of $$('.pane')) {
      pane.classList.toggle('on', pane.id === 'pane-' + tab.dataset.tab)
    }
  })
}

// ---------- 主进程事件 ----------
window.dock.onEvent((payload) => {
  if (payload.type === 'service') renderService(payload)
  else if (payload.type === 'log') appendLog(payload.line, payload.level)
  else if (payload.type === 'update') renderUpdate(payload)
  else if (payload.type === 'init') {
    $('#initFill').style.width = payload.pct + '%'
    $('#initPct').textContent = payload.pct + '%'
    $('#initLab').textContent = '一键初始化 · ' + ({ pnpm: '检查 pnpm', install: '安装依赖', build: '构建产物', done: '完成' }[payload.step] || payload.step)
  } else if (payload.type === 'init-done') {
    scheduleReadiness()
  } else if (payload.type === 'config-changed') {
    // 主进程侧改动（如托盘自启勾选）回灌；事件直接携带新配置
    if (payload.config) { state.config = payload.config; renderConfig() }
  }
});

// ---------- 启动 ----------
;(async function boot() {
  const init = await window.dock.getInit()
  state.config = init.config
  applyTheme(init.config.theme || 'dark')
  $('#aboutLine').textContent = 'DSH Dock v' + init.version + ' · 作者 沐辉' + (init.isPortable ? ' · 便携版' : '')
  $('#logFileLabel').textContent = init.logFile
  $('#portableNote').hidden = !init.isPortable
  renderConfig()
  renderService(init.service)
  renderUpdate(init.update)
  appendLog('[dock] DSH Dock v' + init.version + ' 已启动' + (init.isPackaged ? '' : '（开发模式）'), 'info')

  const nodeInfo = await window.dock.detectNode()
  state.nodeInfo = nodeInfo
  if (!state.config.node.path && nodeInfo.current) {
    state.config = await window.dock.setConfig({ node: { path: nodeInfo.current.path, version: nodeInfo.current.version } })
  }
  renderNode(nodeInfo)

  if (init.project && init.project.found && init.project.dir) {
    $('#projPathInput').value = init.project.dir
    await setConfig({ projectDir: init.project.dir })
  } else if (init.project && init.project.found && !init.project.dir) {
    appendLog('[env] 检测到项目目录但路径为空，请手动浏览选择', 'warn')
  } else {
    appendLog('[env] 未自动找到 deepseek-harness 仓库，请在「项目目录」浏览选择', 'warn')
  }
  renderMode()
  scheduleReadiness()
})().catch((error) => appendLog('[dock] 初始化失败：' + ((error && error.message) || error), 'err'))
