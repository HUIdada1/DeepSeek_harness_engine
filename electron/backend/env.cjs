// 环境探测：Node / pnpm / 项目目录 / 就绪检查 / 一键初始化
// 只依赖"命令行为 + 文件存在"，不解析仓库内部实现（方案第 3/9 章）。
'use strict'
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const EXEC_TIMEOUT_MS = 15_000
const NPM_MIRROR = 'https://registry.npmmirror.com'
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

function run(cmd, args, options = {}) {
  // spawn + 手动超时：超时用 taskkill /T /F 杀整棵树（execFile 的 timeout 只杀第一层 cmd）
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(cmd, args, { windowsHide: true, cwd: options.cwd, env: options.env })
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.once('error', () => {}) // 杀树失败不挂起 Promise
      }
    }, options.timeout ?? EXEC_TIMEOUT_MS)
    const CAP = 1024 * 1024 // 输出上限，异常刷屏不膨胀内存
    child.stdout.on('data', (chunk) => { if (stdout.length < CAP) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < CAP) stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr, error })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : (code ?? -1), stdout, stderr, error: null })
    })
  })
}

// 经 shell 执行 .cmd 类命令（pnpm/npx 在 Windows 上是 .cmd）
function runShell(command, options = {}) {
  return run('cmd.exe', ['/d', '/s', '/c', command], options)
}

// ---- 极简 semver：只覆盖引擎要求 ^22.19.0 || >=24.0.0 的比较需求 ----
function parseVersion(text) {
  const match = String(text || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: 'v' + match.slice(1).join('.') }
}
function satisfiesEngines(version) {
  if (!version) return false
  if (version.major >= 24) return true
  return version.major === 22 && (version.minor > 19 || (version.minor === 19 && version.patch >= 0))
}
function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if ((a[key] || 0) !== (b[key] || 0)) return (a[key] || 0) - (b[key] || 0)
  }
  return 0
}

// ---- Node 探测 ----
async function nodeVersionOf(nodePath) {
  const result = await run(nodePath, ['-v'])
  if (result.code !== 0) return null
  return parseVersion(result.stdout)
}

async function whereLookup(name) {
  const result = await run('where.exe', [name])
  if (result.code !== 0) return []
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

// nvm-windows：NVM_HOME 下有 v* 版本目录，NVM_SYMLINK 是当前指向
function nvmDirs() {
  const out = []
  const home = process.env.NVM_HOME
  const symlink = process.env.NVM_SYMLINK
  if (symlink) out.push({ dir: symlink, source: 'nvm-symlink' })
  if (home) {
    try {
      for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name)) {
          out.push({ dir: path.join(home, entry.name), source: 'nvm', version: entry.name })
        }
      }
    } catch { /* NVM_HOME 不可读则跳过 */ }
  }
  return out
}

function candidateDirs() {
  const out = []
  const push = (dir, source) => { if (dir) out.push({ dir, source }) }
  push(process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'), 'program-files')
  push(process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs'), 'program-files-x86')
  for (const item of nvmDirs()) out.push(item)
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (!base) continue
    const fnmRoot = path.join(base, 'fnm', 'node-versions')
    try {
      for (const entry of fs.readdirSync(fnmRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          push(path.join(fnmRoot, entry.name, 'installation'), 'fnm')
        }
      }
    } catch { /* 该根不存在 */ }
  }
  const voltaRoot = path.join(process.env.LOCALAPPDATA || '', 'Volta', 'tools', 'image', 'node')
  try {
    for (const entry of fs.readdirSync(voltaRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) push(path.join(voltaRoot, entry.name), 'volta')
    }
  } catch { /* volta 未安装 */ }
  return out
}

async function detectNode() {
  const seen = new Set()
  const candidates = []
  const add = async function add(nodeExe, source) {
    if (!nodeExe || seen.has(nodeExe)) return
    seen.add(nodeExe)
    const version = await nodeVersionOf(nodeExe)
    if (version) candidates.push({ path: nodeExe, version: version.raw, satisfies: satisfiesEngines(version), source })
  }
  for (const p of await whereLookup('node')) await add(p, 'path')
  for (const item of candidateDirs()) {
    await add(path.join(item.dir, 'node.exe'), item.source)
  }
  // PATH 首个结果为当前默认；同版本去重保留第一个
  const current = candidates[0] || null
  const byVersion = new Map()
  for (const item of candidates) {
    if (!byVersion.has(item.version)) byVersion.set(item.version, item)
  }
  const versions = [...byVersion.values()].sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)))
  return { current, candidates, versions }
}

// ---- pnpm 探测 ----
async function detectPnpm(nodeDir) {
  const env = nodeEnv(nodeDir)
  const result = await runShell('pnpm -v', { env })
  const version = result.code === 0
    ? (result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^\d+(\.\d+)+/.test(line)) || '')
    : ''
  return { ok: Boolean(version), version }
}

// ---- 项目目录探测与校验 ----
function projectRootValid(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh-root') return false
    return fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'node_modules'))
  } catch {
    return false
  }
}

async function detectProject(configured) {
  const tried = []
  const test = (dir, source) => {
    if (!dir || tried.some((t) => t.dir.toLowerCase() === String(dir).toLowerCase())) return
    tried.push({ dir, source, valid: projectRootValid(dir) })
  }
  test(configured, 'configured')
  test(path.join(os.homedir(), 'deepseek-harness'), 'home')
  for (const drive of ['C:', 'D:', 'E:', 'F:']) test(path.join(drive + path.sep, 'deepseek-harness'), 'drive-root')
  for (const dir of (require('./config.cjs').getConfig().recentProjects || [])) test(dir, 'recent')
  return { found: tried.find((t) => t.valid) || null, tried }
}

function validateProjectDir(dir) {
  return Boolean(dir && projectRootValid(dir))
}

// ---- 就绪检查 ----
function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

async function checkReadiness({ projectDir, mode, nodeDir }) {
  const env = nodeEnv(nodeDir)
  const depsInstalled = dirExists(path.join(projectDir, 'node_modules'))
  const git = fs.existsSync(path.join(projectDir, '.git'))
  const pnpm = await detectPnpm(nodeDir)
  let buildOk = null
  if (mode === 'source' && depsInstalled && pnpm.ok) {
    // 行为验证：以命令退出码判定产物可用，不假设具体 lib 路径（方案 9.3）
    const result = await runShell('pnpm dsh web --help', { cwd: projectDir, env, timeout: 120_000 })
    buildOk = result.code === 0
  }
  let nodeVersionOk = false
  if (nodeDir) {
    const probe = await run(path.join(nodeDir, 'node.exe'), ['-v'])
    nodeVersionOk = satisfiesEngines(parseVersion(probe.stdout))
  }
  return { depsInstalled, git, pnpmOk: pnpm.ok, pnpmVersion: pnpm.version, buildOk, nodeVersionOk }
}

// ---- 服务启动入口定位 ----
// 优先让 node.exe 直跑 pnpm / npx 的 CLI 入口（进程最少）。不能经 detached 的 cmd 启动：
// DETACHED_PROCESS 下 cmd 启动外部命令时不传任何 stdio，输出无法落盘（内建 echo 可以，
// node/pnpm 不行）；node.exe 由 CreateProcess 的 STARTUPINFO 直接拿到日志句柄，
// pnpm→dsh 的子进程链再正常继承。
// --no-open：dsh web 默认会拉起系统浏览器，由 Dock 内嵌窗口打开代替。
function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

async function resolveSpawnEntry(nodeDir, mode, lookup = whereLookup) {
  const exe = path.join(nodeDir, 'node.exe')
  if (!nodeDir || !isFile(exe)) return null
  const npmEntry = () => {
    const script = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    return isFile(script) ? { exe, args: [script, '-y', '@deepseek-ai/dsh', 'web', '--no-open'] } : null
  }
  const pnpmEntry = (dir) => {
    const script = path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    return isFile(script) ? { exe, args: [script, 'dsh', 'web', '--no-open'] } : null
  }
  if (mode === 'npm') return npmEntry()
  // pnpm 布局 1：npm 全局安装（nodeDir\node_modules\pnpm）
  const direct = pnpmEntry(nodeDir)
  if (direct) return direct
  // 布局 2：where pnpm 命中的 shim 同目录（自定义全局 prefix 等场景）
  for (const hit of await lookup('pnpm')) {
    const entry = pnpmEntry(path.dirname(hit))
    if (entry) return entry
  }
  return null
}

// helper 中间层源码：层 1 探测失败（corepack / standalone 等 pnpm 形态）时，由一个
// detached 的 node 进程持有日志句柄并 spawn 普通子进程——DETACHED 的 node 再 spawn
// 子进程时句柄链完全正常（与 pnpm 直跑同构），对任意 pnpm 安装形态都适用。
// 参数：argv[1]=日志路径 argv[2]=cwd argv[3]=命令（node -e 无脚本名占位）；常驻转发退出码。
const SPAWN_HELPER = [
  "const { spawn } = require('node:child_process')",
  "const fs = require('node:fs')",
  // node -e 模式没有脚本名占位，用户参数从 argv[1] 开始（实测 node -e "…" a b c → argv=[node,'a','b','c']）
  "const [log, cwd, command] = process.argv.slice(1)",
  "const fd = fs.openSync(log, 'a')",
  "const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, stdio: ['ignore', fd, fd], windowsHide: true })",
  "try { fs.closeSync(fd) } catch {}",
  "child.once('exit', (code) => process.exit(code ?? 1))",
  "child.once('error', () => process.exit(1))",
].join('\n')

// 构造注入了 Node 目录与代理的子进程环境
function nodeEnv(nodeDir) {
  const env = { ...process.env }
  if (nodeDir) {
    // Windows 环境块键名为 Path；先合并原值再删除旧键，避免 PATH/Path 双键互相覆盖
    const currentPath = env.Path ?? env.PATH ?? ''
    delete env.PATH
    delete env.Path
    env.Path = nodeDir + path.delimiter + currentPath
  }
  const config = require('./config.cjs').getConfig()
  const proxy = config.proxy
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.NO_PROXY = 'localhost,127.0.0.1'
    env.NODE_USE_ENV_PROXY = '1'
  }
  // deepseek-harness 依赖树内含 Electron / 原生包，安装时走镜像防被墙
  env.ELECTRON_MIRROR = ELECTRON_MIRROR
  // 注意：不在此处兜底 npm_config_registry——source 模式下 dsh 运行时要解析
  // @deepseek-ai/dsh-host-* 插件包，镜像未同步会导致插件激活失败（实测）。
  // 镜像兜底只应在 npm 模式（npx 查询主包）注入，见 service.cjs start()。
  return env
}

// ---- 一键初始化：ensure pnpm → install → build ----
// .cmd 脚本禁止直接 spawn（Node ≥18.20 安全策略），统一经 cmd.exe /c 执行
function spawnStream(command, cwd, env, timeoutMs, onLine) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, env, windowsHide: true })
    let timer = setTimeout(() => {
      // 超时杀整棵树：child.kill() 只能杀 cmd.exe 第一层，pnpm/node 孙进程会变孤儿
      if (child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      resolve({ code: 124, timedOut: true })
    }, timeoutMs)
    const feed = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) onLine(line)
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.once('error', (error) => {
      clearTimeout(timer)
      onLine('[init] 进程启动失败：' + error.message)
      resolve({ code: -1, error: error.message })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1 })
    })
  })
}

async function runInit({ projectDir, mode, nodeDir, onStep, onLine }) {
  const env = nodeEnv(nodeDir)
  const steps = []
  const fail = (step, code) => ({ ok: false, failedStep: step, code, steps })

  onStep('pnpm', 4)
  const pnpm = await detectPnpm(nodeDir)
  if (!pnpm.ok) {
    onLine('[init] 未检测到 pnpm，尝试 corepack enable（Node 22+ 自带）')
    const corepack = await runShell('corepack enable', { cwd: projectDir, env, timeout: 60_000 })
    if (corepack.code !== 0) {
      onLine('[init] corepack 不可用，改用 npm 全局安装 pnpm（npmmirror 源）')
      const install = await spawnStream('npm install -g pnpm --registry=' + NPM_MIRROR, projectDir, env, 300_000, onLine)
      if (install.code !== 0) return fail('pnpm', install.code)
    }
  } else {
    onLine('[init] 检测到 pnpm ' + pnpm.version)
  }
  const verify = await detectPnpm(nodeDir)
  if (!verify.ok) return fail('pnpm', 1)
  onLine('[init] pnpm 就绪：' + verify.version)
  steps.push('pnpm')

  if (mode === 'source') {
    onStep('install', 12)
    const install = await spawnStream('pnpm install', projectDir, env, 15 * 60_000, onLine)
    if (install.code !== 0) return fail('install', install.code)
    onLine('[init] 依赖安装完成')
    steps.push('install')

    onStep('build', 55)
    const build = await spawnStream('pnpm run build', projectDir, env, 30 * 60_000, onLine)
    if (build.code !== 0) return fail('build', build.code)
    onLine('[init] 构建完成')
    steps.push('build')
  }

  onStep('done', 100)
  return { ok: true, steps }
}

module.exports = {
  run, runShell, parseVersion, satisfiesEngines, compareVersions,
  detectNode, detectPnpm, detectProject, validateProjectDir, checkReadiness,
  nodeEnv, resolveSpawnEntry, SPAWN_HELPER, runInit, NPM_MIRROR,
}
