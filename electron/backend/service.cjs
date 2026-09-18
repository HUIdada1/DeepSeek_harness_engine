// 服务管理：分离式后台进程（方案 A）
// - spawn detached，stdio ignore；输出由 cmd 内部重定向写日志文件，父进程不持句柄
//   （分离进程的孙节点必然继承 cmd 打开的句柄，管理器生死不影响写入）
// - 状态机 stopped → starting → running → stopping → stopped（degraded = 运行中但探测失败）
// - 崩溃按 5s/15s/60s 退避自动重启，上限 autoRestart.maxRetries；健康恢复即清零计数
'use strict'
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const URL_RE = /dsh web:\s*(https?:\/\/[^\s]+)/i
const FALLBACK_PORT = 3080
const URL_WAIT_MS = 30_000
const PROBE_INTERVAL_MS = 5_000
const PROBE_FAIL_TOLERANCE = 3
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const TAIL_POLL_MS = 500
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000]
const PORT_RELEASE_WAIT_MS = 8_000

let emit = () => {}
let dir = null
let status = 'stopped'
let opts = null
let child = null
let logFile = null
let logOffset = 0
let tailTimer = null
let urlTimer = null
let probeTimer = null
let restartTimer = null
let restartAttempts = 0
let userStop = false
let probeFails = 0
let adoptPromise = null

const state = {
  pid: null,
  url: '',
  port: null,
  startedAt: 0,
  mode: 'source',
  projectDir: '',
  nodeDir: '',
}

function stateFile() {
  return path.join(dir || require('./config.cjs').appDataDir(), 'state.json')
}
function logPath() {
  return path.join(dir || require('./config.cjs').appDataDir(), 'logs', 'dsh-web.log')
}

function persistState() {
  fs.writeFileSync(stateFile(), JSON.stringify({ ...state, status }, null, 2) + '\n', 'utf8')
}
function clearStateFile() {
  try { fs.unlinkSync(stateFile()) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function setStatus(next) {
  status = next
  persistState()
  emit({ type: 'service', status, ...snapshot() })
}
function snapshot() {
  return {
    pid: state.pid, url: state.url, port: state.port,
    startedAt: state.startedAt, mode: state.mode,
    projectDir: state.projectDir, nodeDir: state.nodeDir,
    probeFails,
    logFile: logFile || logPath(),
  }
}
function getStatus() {
  return { status, ...snapshot() }
}

// ---- 日志：轮转 + 追加 + 轮询读新行 ----
function rotateIfNeeded() {
  try {
    const stat = fs.statSync(logPath())
    if (stat.size > LOG_ROTATE_BYTES) {
      fs.renameSync(logPath(), logPath() + '.1')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
function appendDockLine(line) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true })
  fs.appendFileSync(logPath(), line + '\n', 'utf8')
}
function initTailOffset() {
  try {
    logOffset = fs.statSync(logPath()).size
  } catch {
    logOffset = 0
  }
}

function pollTail() {
  if (!logFile) return
  let stat
  try { stat = fs.statSync(logFile) } catch { return }
  if (stat.size < logOffset) logOffset = 0 // 轮转或重建
  if (stat.size === logOffset) return
  let buffer
  try {
    const fd = fs.openSync(logFile, 'r')
    buffer = Buffer.alloc(stat.size - logOffset)
    fs.readSync(fd, buffer, 0, buffer.length, logOffset)
    fs.closeSync(fd)
  } catch { return }
  // 只消费到最后一个换行字节：半行/多字节字符留待下次，URL 行不会被劈开
  const cut = buffer.lastIndexOf(0x0a)
  if (cut === -1) return
  logOffset += cut + 1
  for (const raw of buffer.subarray(0, cut + 1).toString('utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    emit({ type: 'log', line })
    const match = line.match(URL_RE)
    if (match && !state.url) {
      onUrlFound(match[1])
    }
  }
}

function startTailer() {
  if (!tailTimer) tailTimer = setInterval(pollTail, TAIL_POLL_MS)
}
function stopTailer() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null }
}

// ---- URL 与健康探测 ----
function onUrlFound(url) {
  if (status !== 'starting') return
  state.url = url
  try { state.port = Number(new URL(url).port) || 80 } catch { state.port = null }
  persistState()
  emit({ type: 'log', level: 'ok', line: '[state] URL 解析成功：' + url })
  startProbing()
}

function probeOnce(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 4000 }, (res) => {
      res.resume()
      resolve(true) // 任何 HTTP 响应都说明服务在监听
    })
    request.once('timeout', () => { request.destroy(); resolve(false) })
    request.once('error', () => resolve(false))
  })
}

function startProbing() {
  if (probeTimer) return
  probeTimer = setInterval(async () => {
    if (!state.url) return
    const ok = await probeOnce(state.url)
    if (ok) {
      if (probeFails > 0) emit({ type: 'log', level: 'info', line: '[probe] 恢复 HTTP 响应' })
      probeFails = 0
      if (status === 'starting') {
        restartAttempts = 0 // 健康恢复，重启计数归零
        setStatus('running')
      }
    } else {
      probeFails += 1
      if (status === 'running' && probeFails >= PROBE_FAIL_TOLERANCE) {
        emit({ type: 'log', level: 'warn', line: '[probe] 连续 ' + probeFails + ' 次探测失败，标记异常（服务进程仍在）' })
        setStatus('degraded')
      }
    }
  }, PROBE_INTERVAL_MS)
}
function stopProbing() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null }
  probeFails = 0
}

function urlWaitGuard() {
  clearTimeout(urlTimer)
  urlTimer = setTimeout(async () => {
    urlTimer = null
    if (status !== 'starting' || state.url) return
    // 30s 无 URL：回退探测默认端口（方案 6 #8）
    const fallback = 'http://127.0.0.1:' + FALLBACK_PORT + '/'
    const ok = await probeOnce(fallback)
    if (ok) {
      emit({ type: 'log', level: 'warn', line: '[state] stdout 未解析到 URL，回退探测 ' + fallback + ' 成功（无 token）' })
      onUrlFound(fallback)
    } else {
      emit({ type: 'log', level: 'err', line: '[state] ' + URL_WAIT_MS / 1000 + 's 内未解析到 URL 且默认端口无响应，请查看日志' })
    }
  }, URL_WAIT_MS)
}

// 终态统一收口：清定时器并如实置 stopped
function markStopped() {
  stopTailer()
  stopProbing()
  clearTimeout(urlTimer)
  urlTimer = null
  setStatus('stopped')
}

// ---- 启动 / 停止 ----
async function start(startOpts, options = {}) {
  const { keepAttempts = false } = options
  if (adoptPromise) await adoptPromise
  if (status === 'starting' || status === 'running' || status === 'stopping') return getStatus()
  if (status === 'degraded') {
    // degraded = 旧进程还活着：先停掉，避免端口冲突与日志句柄占用
    await stop('start-before-degraded')
    if (status !== 'stopped') return getStatus()
  }
  opts = { ...startOpts }
  userStop = false
  cancelRestart(keepAttempts)
  stopProbing()
  stopTailer()
  clearTimeout(urlTimer)
  setStatus('starting')
  state.url = ''
  state.port = null
  state.startedAt = Date.now()
  state.mode = opts.mode
  state.projectDir = opts.projectDir
  state.nodeDir = opts.nodeDir || ''

  try {
    rotateIfNeeded()
    const env = require('./env.cjs').nodeEnv(opts.nodeDir)
    const baseCommand = opts.mode === 'npm' ? 'npx -y @deepseek-ai/dsh web' : 'pnpm dsh web'
    emit({ type: 'log', level: 'info', line: '[spawn] 分离进程启动：' + baseCommand + '（cwd ' + opts.projectDir + '）' })
    appendDockLine('[dock] ---- DSH Dock 启动服务 ' + new Date().toISOString() + ' ----')
    initTailOffset()

    // 由 cmd 执行重定向：所有子孙进程的 stdout/stderr 都落到日志文件
    const command = baseCommand + ' >> "' + logPath() + '" 2>&1'
    child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd: opts.projectDir,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    state.pid = child.pid
    persistState()

    const self = child
    const onDeath = (kind, detail) => {
      if (child !== self) return // 已被新一轮 start/stop 接管
      child = null
      state.pid = null
      if (userStop || status === 'stopping') return
      if (kind === 'error') {
        emit({ type: 'log', level: 'err', line: '[service] 进程启动失败：' + detail })
      } else {
        appendDockLine('[dock] 服务进程异常退出 code=' + detail + ' ' + new Date().toISOString())
        emit({ type: 'log', level: 'err', line: '[service] 服务进程异常退出（code=' + detail + '），最近日志见上' })
      }
      markStopped() // 如实反映进程已死，再进入退避
      maybeAutoRestart()
    }
    self.once('error', (error) => onDeath('error', error && error.message ? error.message : String(error)))
    self.once('exit', (code) => onDeath('exit', code))
  } catch (error) {
    emit({ type: 'log', level: 'err', line: '[start] 启动失败：' + (error && error.message ? error.message : String(error)) })
    markStopped()
    return getStatus()
  }

  startTailer()
  urlWaitGuard()
  return getStatus()
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function pidByPort(port) {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      const lines = String(stdout).split(/\r?\n/).filter((l) => l.includes(':' + port + ' ') && l.includes('LISTENING'))
      const pid = Number(lines[0] && lines[0].trim().split(/\s+/).pop())
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null)
    })
  })
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve())
  })
}

async function stop(reason) {
  if (status === 'stopped') return getStatus()
  userStop = true
  cancelRestart(false)
  setStatus('stopping')
  stopProbing()
  stopTailer()
  clearTimeout(urlTimer)
  urlTimer = null

  let pid = state.pid
  if (!pid || !pidAlive(pid)) {
    // 进程已不在，但端口可能仍被占（手启/孤儿）：按端口兜底
    pid = state.port ? await pidByPort(state.port) : null
  }
  if (pid && pidAlive(pid)) {
    emit({ type: 'log', level: 'info', line: '[action] 停止服务 · taskkill /T /F pid=' + pid + (reason ? '（' + reason + '）' : '') })
    await taskkillTree(pid)
    // 等待端口真正释放，总时长封顶 PORT_RELEASE_WAIT_MS
    const deadline = Date.now() + PORT_RELEASE_WAIT_MS
    while (state.port && Date.now() < deadline) {
      if (!(await probeOnce('http://127.0.0.1:' + state.port + '/'))) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } else {
    emit({ type: 'log', level: 'info', line: '[action] 服务已不在运行，清理状态' + (reason ? '（' + reason + '）' : '') })
  }

  child = null
  state.pid = null
  state.url = ''
  state.port = null
  markStopped()
  return getStatus()
}

async function restart() {
  if (!opts) return getStatus()
  emit({ type: 'log', level: 'warn', line: '[action] 收到重启指令，优雅停止旧进程后重新拉起' })
  await stop('restart')
  return start(opts)
}

// ---- 退避自动重启（方案 6 #9）----
function maybeAutoRestart() {
  const config = require('./config.cjs').getConfig()
  if (!config.autoRestart.enabled) return
  if (restartAttempts >= config.autoRestart.maxRetries) {
    emit({ type: 'log', level: 'err', line: '[service] 自动重启已达上限（' + config.autoRestart.maxRetries + ' 次），保持停止' })
    return
  }
  const delay = RESTART_BACKOFF_MS[Math.min(restartAttempts, RESTART_BACKOFF_MS.length - 1)]
  restartAttempts += 1
  emit({ type: 'log', level: 'warn', line: '[service] ' + delay / 1000 + 's 后第 ' + restartAttempts + ' 次自动重启' })
  restartTimer = setTimeout(async () => {
    restartTimer = null
    if (userStop || child) return
    await start(opts, { keepAttempts: true })
  }, delay)
}
function cancelRestart(keepAttempts = false) {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (!keepAttempts) restartAttempts = 0
}

// ---- 回连（管理器重新打开 / 系统启动后恢复显示）----
async function doAdopt() {
  let disk = null
  try { disk = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { disk = null }
  if (!disk || !disk.pid) {
    clearStateFile()
    return getStatus()
  }
  Object.assign(state, {
    pid: disk.pid, url: disk.url || '', port: disk.port || null,
    startedAt: disk.startedAt || Date.now(), mode: disk.mode || 'source',
    projectDir: disk.projectDir || '', nodeDir: disk.nodeDir || '',
  })
  opts = { projectDir: state.projectDir, mode: state.mode, nodeDir: state.nodeDir }
  logFile = logPath()

  const alive = pidAlive(state.pid)
  const portAlive = state.url ? await probeOnce(state.url) : false
  if (alive && portAlive) {
    emit({ type: 'log', level: 'ok', line: '[adopt] 收养运行中的服务 pid=' + state.pid + ' · ' + state.url })
    initTailOffset()
    startTailer()
    startProbing()
    setStatus('running')
  } else if (alive) {
    emit({ type: 'log', level: 'info', line: '[adopt] 服务进程存活（pid=' + state.pid + '）但未就绪，继续等待 URL' })
    initTailOffset()
    startTailer()
    setStatus('starting')
    urlWaitGuard()
    startProbing()
  } else if (portAlive) {
    emit({ type: 'log', level: 'warn', line: '[adopt] 状态文件中的进程已死但端口仍存活，按端口收养' })
    state.pid = await pidByPort(state.port)
    persistState()
    initTailOffset()
    startTailer()
    startProbing()
    setStatus('running')
  } else {
    emit({ type: 'log', level: 'info', line: '[adopt] 状态文件已过期（进程与端口均失效），清理' })
    state.pid = null
    clearStateFile()
    markStopped()
  }
  return getStatus()
}
function adoptOrphan() {
  if (adoptPromise) return adoptPromise
  adoptPromise = doAdopt().catch((error) => {
    emit({ type: 'log', level: 'err', line: '[adopt] 收养失败：' + (error && error.message ? error.message : String(error)) })
    try { clearStateFile() } catch { /* 状态文件本就可能不存在 */ }
    markStopped()
  })
  return adoptPromise
}

function init(options) {
  emit = options.onEvent
  dir = options.dataDir
  fs.mkdirSync(path.dirname(logPath()), { recursive: true })
  logFile = logPath()
}

module.exports = { init, start, stop, restart, getStatus, adoptOrphan, logPath, probeOnce }
