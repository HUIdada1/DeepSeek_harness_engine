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
const URL_WAIT_MS = 30_000 // 首次宽限后提示：npm 模式 npx 首次启动要现场下载发布包，30s+ 很常见
const URL_CHECK_MS = 30_000 // 提示后的复查间隔，顺带轮询回退探测默认端口
const URL_FAIL_MS = 150_000 // 判定启动失败的总上限
const PROBE_INTERVAL_MS = 5_000
const PROBE_FAIL_TOLERANCE = 3
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const TAIL_POLL_MS = 500
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000]
const PORT_RELEASE_WAIT_MS = 8_000
const ADOPT_GIVEUP_MS = 90_000 // 收养态无 URL 的最长等待（pid 复用后 pidAlive 恒真，只能靠时间收口）
const ADOPT_FAIL_PROBES = 12 // 收养态有 URL 但持续探测失败的上限（12 × 5s）
// 0=正常结束；0xC000013A=Ctrl+C / 关闭终端。两者都判定为人为停止，不做自动重启
const MANUAL_STOP_CODES = new Set([0, 3221225786])

let emit = () => {}
let dir = null
let status = 'stopped'
let opts = null
let child = null
let logFile = null
let logOffset = 0
let tailPrimed = false // initTailOffset 已执行过，markStopped 才允许排干尾巴
let tailTimer = null
let urlTimer = null
let urlGuardGen = 0 // 守卫代际：start/adopt 重建守卫后，旧守卫在途的探测回调全部作废
let probeTimer = null
let restartTimer = null
let restartAttempts = 0
let userStop = false
let probeFails = 0
let adoptPromise = null
const RECENT_LOG_MAX = 48
let recentLogLines = [] // 用于识别「修配置前重启无效」的致命启动错误

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
function noteLogLine(line) {
  if (!line) return
  recentLogLines.push(String(line))
  if (recentLogLines.length > RECENT_LOG_MAX) recentLogLines.shift()
}

function appendDockLine(line) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true })
  fs.appendFileSync(logPath(), line + '\n', 'utf8')
  noteLogLine(line)
}
function initTailOffset() {
  try {
    logOffset = fs.statSync(logPath()).size
  } catch {
    logOffset = 0
  }
  tailPrimed = true
}

function pollTail(silent = false) {
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
    noteLogLine(line)
    emit({ type: 'log', line })
    const match = line.match(URL_RE)
    if (match && !state.url && !silent) {
      onUrlFound(match[1])
    }
  }
}

function startTailer() {
  if (!tailTimer) tailTimer = setInterval(() => pollTail(false), TAIL_POLL_MS)
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
  let probing = false // 防止 async 回调重叠导致 probeFails 多计
  probeTimer = setInterval(async () => {
    if (probing) return
    probing = true
    try {
      if (!state.url) {
        // 收养态无 URL 可探测：以 pid 存活兜底，死亡或超时即收口
        if (!child && state.pid) {
          const expired = Date.now() - state.startedAt > ADOPT_GIVEUP_MS
          if (expired || !pidAlive(state.pid)) {
            emit({ type: 'log', level: 'err', line: '[probe] ' + (expired ? '收养进程超时未输出 URL，放弃等待' : '收养的进程已退出（pid=' + state.pid + '）') })
            state.pid = null
            markStopped()
          }
        }
        return
      }
      const ok = await probeOnce(state.url)
      if (ok) {
        if (probeFails > 0) emit({ type: 'log', level: 'info', line: '[probe] 恢复 HTTP 响应' })
        probeFails = 0
        if (status === 'starting' || status === 'degraded') {
          if (status === 'starting') restartAttempts = 0 // 健康恢复，重启计数归零
          setStatus('running')
        }
      } else {
        probeFails += 1
        const adoptedDead = !child && state.pid && !pidAlive(state.pid)
        if (status === 'starting' && adoptedDead && probeFails >= PROBE_FAIL_TOLERANCE) {
          emit({ type: 'log', level: 'err', line: '[probe] 收养的启动中进程已死亡，停止等待' })
          state.pid = null
          markStopped()
          return
        }
        if (status === 'starting' && !child && probeFails >= ADOPT_FAIL_PROBES) {
          emit({ type: 'log', level: 'err', line: '[probe] 收养进程持续无响应，放弃收养' })
          state.pid = null
          markStopped()
          return
        }
        if (status === 'running' && probeFails >= PROBE_FAIL_TOLERANCE) {
          emit({ type: 'log', level: 'warn', line: '[probe] 连续 ' + probeFails + ' 次探测失败，标记异常（服务进程仍在）' })
          setStatus('degraded')
          if (adoptedDead) {
            state.pid = null
            markStopped()
          }
        }
      }
    } finally {
      probing = false
    }
  }, PROBE_INTERVAL_MS)
}
function stopProbing() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null }
  probeFails = 0
}

// 分层等待 URL：30s 无 URL 只提示不报错（进程活着就继续等），每 30s 复查一次回退端口，
// 150s 仍无才判定启动失败。此前固定 30s 即报「服务异常」，但 npm 模式首次启动 npx 要
// 现场下载发布包，实测 48s 才输出 URL——进程好好的却被误报失败，还弹错误弹窗
function urlWaitGuard() {
  clearTimeout(urlTimer)
  const gen = ++urlGuardGen
  const base = Date.now()
  let warned = false
  const check = async () => {
    if (gen !== urlGuardGen) return // 守卫已被新一轮 start/adopt/stop 接管
    urlTimer = null
    if (status !== 'starting' || state.url) return
    const fallback = 'http://127.0.0.1:' + FALLBACK_PORT + '/'
    const ok = await probeOnce(fallback)
    if (gen !== urlGuardGen || status !== 'starting' || state.url) return
    if (ok) {
      emit({ type: 'log', level: 'warn', line: '[state] stdout 未解析到 URL，回退探测 ' + fallback + ' 成功（无 token）' })
      onUrlFound(fallback)
      return
    }
    const elapsed = Date.now() - base
    if (elapsed >= URL_FAIL_MS) {
      await failUrlWait()
      return
    }
    if (!warned) {
      warned = true
      emit({ type: 'log', level: 'warn', line: '[state] ' + Math.round(elapsed / 1000) + 's 未解析到 URL，服务进程仍在运行，继续等待（npm 模式首次启动需下载发布包，可能较慢）' })
    }
    urlTimer = setTimeout(check, URL_CHECK_MS)
  }
  urlTimer = setTimeout(check, URL_WAIT_MS)
}

// URL 等待超时收口：主动终止进程树后如实置 stopped，并交给自动重启退避重试
// （此时 npx 包缓存已热，重试成功率高）。不依赖 taskkill 的退出码判定，
// 直接摘掉 exit/error 监听后自行收口，避免 onDeath 与本流程双重触发重启
async function failUrlWait() {
  const self = child
  if (status !== 'starting' || !self || userStop) return // 已被进程退出 / 用户停止收口
  emit({ type: 'log', level: 'err', line: '[state] ' + URL_FAIL_MS / 1000 + 's 内未解析到 URL 且默认端口无响应，判定启动失败' })
  self.removeAllListeners('exit')
  self.removeAllListeners('error')
  if (self.pid && pidAlive(self.pid)) {
    emit({ type: 'log', level: 'info', line: '[action] 停止服务 · taskkill /T /F pid=' + self.pid + '（启动超时）' })
    await taskkillTree(self.pid)
  }
  if (userStop) return // 收口期间用户已叫停，交由 stop() 收尾
  child = null
  state.pid = null
  state.url = ''
  state.port = null
  markStopped()
  userStop = false
  maybeAutoRestart()
}

// 终态统一收口：清定时器并如实置 stopped
function markStopped() {
  if (tailPrimed) pollTail(true) // 排干最后一次轮询之后落盘的输出：崩溃原因常落在 500ms 轮询间隔内
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
  urlTimer = null
  setStatus('starting')
  state.url = ''
  state.port = null
  state.startedAt = Date.now()
  state.mode = opts.mode
  state.projectDir = opts.projectDir
  state.nodeDir = opts.nodeDir || ''

  try {
    try {
      rotateIfNeeded()
    } catch (rotateError) {
      emit({ type: 'log', level: 'warn', line: '[log] 轮转失败（可能有进程仍持有日志句柄），继续追加：' + (rotateError.message || rotateError) })
    }
    recentLogLines = []
    // 启动前按模式校验/自愈凭证：源码要 version: 1（数字）；NPM 旧包不认 versioned v1
    const envModule = require('./env.cjs')
    const credentials = require('./credentials.cjs').ensureCredentialsForMode({
      mode: opts.mode === 'npm' ? 'npm' : 'source',
      hasLocalProject: Boolean(opts.projectDir && envModule.validateProjectDir(opts.projectDir)),
    })
    if (credentials.fixed) {
      emit({ type: 'log', level: 'ok', line: '[credentials] ' + credentials.message + '（' + credentials.path + '）' })
    } else if (!credentials.ok) {
      emit({ type: 'log', level: 'err', line: '[credentials] ' + credentials.message + (credentials.error ? '：' + credentials.error : '') + '（' + credentials.path + '）' })
      markStopped()
      return getStatus()
    } else if (credentials.message) {
      emit({ type: 'log', level: 'info', line: '[credentials] ' + credentials.message })
    }

    const env = envModule.nodeEnv(opts.nodeDir)
    // npm 模式 npx 每次启动要查 registry；用户未自配源时兜底国内镜像。
    // 只限 npm 模式：source 模式的 dsh 运行时插件解析依赖官方源完整性，注入镜像会坏
    if (opts.mode === 'npm' && !env.npm_config_registry && !env.NPM_CONFIG_REGISTRY) {
      env.npm_config_registry = envModule.NPM_MIRROR
    }
    // --no-open：不弹系统浏览器，由 Dock 内嵌窗口打开（running 后自动拉起）
    const baseCommand = opts.mode === 'npm' ? 'npx -y @deepseek-ai/dsh web --no-open' : 'pnpm dsh web --no-open'
    // npm 模式跑的是 registry 发布包，与本地项目无关；且 npx 在 pnpm workspace 根目录
    // 下会被本地 node_modules 结构干扰而找不到 bin（实测 'dsh' 不是内部或外部命令），
    // 固定用 Dock 数据目录作 cwd
    const spawnCwd = opts.mode === 'npm' ? require('./config.cjs').appDataDir() : opts.projectDir
    if (opts.mode === 'npm' && opts.projectDir && envModule.validateProjectDir(opts.projectDir)) {
      emit({ type: 'log', level: 'warn', line: '[start] 当前为 NPM 模式：实际运行的是 registry 发布包，不会使用本地仓库 ' + opts.projectDir + '。本地改代码 / 跟开发分支请切换到「源码」模式。' })
    }
    emit({ type: 'log', level: 'info', line: '[spawn] 分离进程启动：' + baseCommand + '（cwd ' + spawnCwd + '）' })
    appendDockLine('[dock] ---- DSH Dock 启动服务 ' + new Date().toISOString() + ' ----')
    initTailOffset()

    // 端口预检：未经 Dock 停止的残留 dsh web（如进程树被不完整终止）会占住默认端口，
    // 让 webserver 插件 EADDRINUSE、启动必败并空耗重启次数。给一句人话提示
    const portPid = await pidByPort(FALLBACK_PORT)
    if (portPid) {
      emit({ type: 'log', level: 'warn', line: '[start] 端口 ' + FALLBACK_PORT + ' 已被 pid=' + portPid + ' 占用（可能是历史残留的服务进程），本次启动可能失败；可结束该进程后重试' })
    }

    // 层 1：node.exe 直跑 pnpm/npx 的 CLI 入口，stdio 传日志句柄（spawn 同步返回后父进程
    // 即关句柄，子进程树持有继承句柄，管理器生死不影响写入）。不能经 detached 的 cmd
    // 重定向：1) Node 默认参数转义会把重定向命令里的 " 变 \"，cmd /s 剥外层引号后重定向
    // 目标成非法路径，进程立即 code=1 退出；2) 即使转义正确，DETACHED_PROCESS 的 cmd
    // 启动外部命令时也不传任何 stdio，输出全部丢失、URL 无法解析。
    // 层 2：探测失败（corepack / standalone 等形态）改用 helper 中间层——detached 的
    // node 再 spawn 普通子进程时句柄链正常（与直跑同构），命令原文经 argv 传递。
    const entry = await require('./env.cjs').resolveSpawnEntry(opts.nodeDir, opts.mode)
    let spawnFile
    let spawnArgs
    if (entry) {
      spawnFile = entry.exe
      spawnArgs = entry.args
    } else {
      emit({ type: 'log', level: 'warn', line: '[spawn] 未定位到 pnpm/npx 的 node 入口，改用 helper 中间层启动' })
      spawnFile = 'node.exe' // nodeEnv 已把 nodeDir 前置到 PATH
      spawnArgs = ['-e', require('./env.cjs').SPAWN_HELPER, logPath(), spawnCwd, baseCommand]
    }
    let logFd = null
    try {
      if (entry) logFd = fs.openSync(logPath(), 'a')
      child = spawn(spawnFile, spawnArgs, {
        cwd: spawnCwd,
        env,
        stdio: entry ? ['ignore', logFd, logFd] : 'ignore',
        windowsHide: true,
      })
      child.unref()
    } finally {
      if (logFd !== null) { try { fs.closeSync(logFd) } catch { /* 句柄可能已随错误释放 */ } }
    }
    state.pid = child.pid
    persistState()

    const self = child
    const onDeath = (kind, detail) => {
      if (child !== self) return // 已被新一轮 start/stop 接管
      child = null
      state.pid = null
      state.url = ''
      state.port = null
      if (userStop || status === 'stopping') return
      // 排干尾巴再判致命错误：credentials 等栈常落在最后几行
      try { pollTail(true) } catch { /* 排干失败不阻塞收口 */ }
      // 0=正常结束 / 0xC000013A=Ctrl+C / 关闭终端：判定为人为停止，不进自动重启
      const manual = kind === 'exit' && MANUAL_STOP_CODES.has(Number(detail))
      const fatal = require('./credentials.cjs').fatalBootReason(recentLogLines)
      try {
        if (kind === 'error') {
          emit({ type: 'log', level: 'err', line: '[service] 进程启动失败：' + detail })
        } else if (manual) {
          appendDockLine('[dock] 服务进程停止 code=' + detail + '（人为停止） ' + new Date().toISOString())
          emit({ type: 'log', level: 'warn', line: '[service] 服务进程已停止（退出码 ' + detail + '，判定为人为停止），不自动重启' })
        } else {
          appendDockLine('[dock] 服务进程异常退出 code=' + detail + ' ' + new Date().toISOString())
          emit({ type: 'log', level: 'err', line: '[service] 服务进程异常退出（code=' + detail + '），最近日志见上' })
        }
        if (fatal) {
          emit({ type: 'log', level: 'err', line: '[service] 检测到配置致命错误，跳过自动重启：' + fatal })
        }
      } catch { /* 日志写入失败不阻塞状态收口 */ }
      markStopped() // 如实反映进程已死，再进入退避
      if (!manual && !fatal) maybeAutoRestart()
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
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, (error) => {
      if (error) emit({ type: 'log', level: 'warn', line: '[action] taskkill 失败（' + (error.message || error) + '），进程可能仍存活' })
      resolve()
    })
  })
}

async function stop(reason) {
  userStop = true // 必须先于守卫：退避窗口（stopped 态）也要拦住挂起的自动重启
  cancelRestart(false)
  if (adoptPromise) await adoptPromise
  // stopping 期重入直接返回：并发 stop 会重复 taskkill 同一棵进程树
  if (status === 'stopped' || status === 'stopping') return getStatus()
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
  if (status !== 'stopped') return getStatus() // 与并发停止撞车时放弃本次重启，等用户再次触发
  return start(opts)
}

// ---- 退避自动重启（方案 6 #9）----
function maybeAutoRestart() {
  const config = require('./config.cjs').getConfig()
  if (!config.autoRestart.enabled || !(config.autoRestart.maxRetries > 0)) {
    emit({ type: 'log', level: 'warn', line: '[service] 自动重启已关闭（重试次数为 0），保持停止' })
    return
  }
  if (restartAttempts >= config.autoRestart.maxRetries) {
    emit({ type: 'log', level: 'err', line: '[service] 自动重启已达上限（' + config.autoRestart.maxRetries + ' 次），保持停止' })
    return
  }
  const delay = RESTART_BACKOFF_MS[Math.min(restartAttempts, RESTART_BACKOFF_MS.length - 1)]
  restartAttempts += 1
  emit({ type: 'log', level: 'warn', line: '[service] ' + delay / 1000 + 's 后第 ' + restartAttempts + ' 次自动重启（点表盘或托盘取消勾选「运行服务」可取消）' })
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
    if (!state.pid) {
      emit({ type: 'log', level: 'err', line: '[adopt] 无法定位占用端口的进程，放弃收养' })
      markStopped()
      return getStatus()
    }
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
