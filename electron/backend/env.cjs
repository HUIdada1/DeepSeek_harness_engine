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
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: options.timeout ?? EXEC_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error && error.code !== undefined ? Number(error.code) || 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error })
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
  const fnmRoot = path.join(process.env.APPDATA || '', 'fnm', 'node-versions')
  try {
    for (const entry of fs.readdirSync(fnmRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        push(path.join(fnmRoot, entry.name, 'installation'), 'fnm')
      }
    }
  } catch { /* fnm 未安装 */ }
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
  const version = result.code === 0 ? result.stdout.trim().split(/\r?\n/).pop() : ''
  return { ok: result.code === 0 && /^\d+/.test(version), version }
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

// 构造注入了 Node 目录与代理的子进程环境
function nodeEnv(nodeDir) {
  const env = { ...process.env }
  if (nodeDir) {
    env.PATH = nodeDir + path.delimiter + (env.PATH || '')
    env.Path = env.PATH
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
  env.__nodeVersionRaw = ''
  return env
}

// ---- 一键初始化：ensure pnpm → install → build ----
// .cmd 脚本禁止直接 spawn（Node ≥18.20 安全策略），统一经 cmd.exe /c 执行
function spawnStream(command, cwd, env, timeoutMs, onLine) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, env, windowsHide: true })
    let timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
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
  env.__nodeVersionRaw = ''
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
  nodeEnv, runInit,
}
