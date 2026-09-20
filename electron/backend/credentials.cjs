// 启动前自愈 / 校验 ~/.dsh/.credentials.yaml
//
// deepseek-harness 凭证格式有两代，互不兼容：
// 1) 旧发布包（npx @deepseek-ai/dsh，flat）：整份文件是「键 → 非空字符串」扁平映射
// 2) 本地新源码（versioned v1）：必须是
//      version: 1          # YAML 数字，不是 "1"
//      refs: { KEY: "..." }
//      records?: { ... }
//
// Dock 不能把两代格式互相无损转换（records 只存在于 v1）。策略：
// - 源码模式：若 version 被写成 "1"，自动纠正为数字 1
// - NPM 模式：若检测到 v1 嵌套布局，直接拒绝启动并提示改用源码模式（避免空转重启）
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CREDENTIALS_NAME = '.credentials.yaml'

/** 与 dsh 默认一致：优先 DSH_HOME，否则 ~/.dsh */
function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

function credentialsPath(env = process.env) {
  return path.join(resolveDshHome(env), CREDENTIALS_NAME)
}

/**
 * 粗识别凭证布局（不引入 YAML 库，只看顶层键形态）。
 * @param {string} text
 * @returns {'missing' | 'empty' | 'versioned-v1' | 'flat' | 'unknown'}
 */
function detectCredentialsLayout(text) {
  if (text === undefined || text === null) return 'missing'
  const lines = String(text).split(/\r?\n/)
  let sawVersion = false
  let sawRefs = false
  let sawRecords = false
  let sawOtherTop = false
  for (const raw of lines) {
    if (!raw || /^\s*$/.test(raw) || /^\s*#/.test(raw)) continue
    // 只看缩进 0 的顶层键
    if (/^\s/.test(raw)) continue
    if (/^version\s*:/.test(raw)) sawVersion = true
    else if (/^refs\s*:/.test(raw)) sawRefs = true
    else if (/^records\s*:/.test(raw)) sawRecords = true
    else if (/^[A-Za-z_][\w-]*\s*:/.test(raw)) sawOtherTop = true
  }
  if (!sawVersion && !sawRefs && !sawRecords && !sawOtherTop) return 'empty'
  if (sawVersion && (sawRefs || sawRecords) && !sawOtherTop) return 'versioned-v1'
  if (sawVersion && sawRefs) return 'versioned-v1' // 偶发其它顶层键仍按 v1 处理，交给上游报错
  if (!sawVersion && sawOtherTop) return 'flat'
  if (sawVersion && !sawRefs && !sawRecords) return 'unknown'
  return sawOtherTop ? 'flat' : 'unknown'
}

/**
 * 源码模式：把 `version: "1"` / `version: '1'` 纠正为 YAML 数字 `version: 1`。
 * 新版 credentials-local 用 `fields.version !== 1` 严格比较。
 * @param {string} text
 */
function rewriteVersionToNumber(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = /[\r\n]$/.test(text)
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (!/^version\s*:/.test(trimmed)) return { text, fixed: false }
    const match = raw.match(/^(\s*version\s*:\s*)(["'])1\2(\s*)(#.*)?$/)
    if (!match) return { text, fixed: false }
    lines[index] = match[1] + '1' + (match[3] || '') + (match[4] || '')
    let out = lines.join(newline)
    if (endsWithNewline && !/[\r\n]$/.test(out)) out += newline
    return { text: out, fixed: true, from: '"1"', to: '1' }
  }
  return { text, fixed: false }
}

/**
 * 仅用于单测 / 旧逻辑对照：把数字 version 写成带引号字符串。
 * NPM 旧包要的是整份 flat 布局，不是只改 version 引号。
 * @param {string} text
 */
function rewriteCredentialsVersion(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = /[\r\n]$/.test(text)
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (!/^version\s*:/.test(trimmed)) return { text, fixed: false }
    if (/^\s*version\s*:\s*(["']).+\1\s*(#.*)?$/.test(raw)) return { text, fixed: false }
    const match = raw.match(/^(\s*version\s*:\s*)([^#]+?)(\s*)(#.*)?$/)
    if (!match) return { text, fixed: false }
    const value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return { text, fixed: false }
    }
    if (!/^(?:[-+]?\d+(?:\.\d+)?|true|false|null|True|False|NULL|Null)$/.test(value)) {
      return { text, fixed: false }
    }
    lines[index] = match[1] + '"' + value + '"' + (match[3] || '') + (match[4] || '')
    let out = lines.join(newline)
    if (endsWithNewline && !/[\r\n]$/.test(out)) out += newline
    return { text: out, fixed: true, from: value, to: '"' + value + '"' }
  }
  return { text, fixed: false }
}

function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 按启动模式准备凭证文件。
 * @param {{ mode?: 'source' | 'npm', env?: NodeJS.ProcessEnv, path?: string, hasLocalProject?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   fixed: boolean,
 *   path: string,
 *   layout: string,
 *   message: string,
 *   preferSource?: boolean,
 *   error?: string,
 * }}
 */
function ensureCredentialsForMode(options = {}) {
  const mode = options.mode === 'npm' ? 'npm' : 'source'
  const file = options.path || credentialsPath(options.env || process.env)

  if (!fs.existsSync(file)) {
    return {
      ok: true,
      fixed: false,
      path: file,
      layout: 'missing',
      message: '凭证文件尚不存在，跳过布局检查',
    }
  }

  let original
  try {
    original = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return {
      ok: false,
      fixed: false,
      path: file,
      layout: 'unknown',
      message: '无法读取凭证文件',
      error: error && error.message ? error.message : String(error),
    }
  }

  const layout = detectCredentialsLayout(original)

  if (mode === 'npm' && layout === 'versioned-v1') {
    return {
      ok: false,
      fixed: false,
      path: file,
      layout,
      preferSource: true,
      message: '当前 ~/.dsh/.credentials.yaml 已是 versioned v1（version/refs/records），与 NPM 发布包的扁平凭证格式不兼容。请切换到「源码」模式启动；强行用 NPM 只会启动失败。',
    }
  }

  if (mode === 'source' && layout === 'versioned-v1') {
    const result = rewriteVersionToNumber(original)
    if (!result.fixed) {
      return { ok: true, fixed: false, path: file, layout, message: '凭证 versioned v1 布局可用' }
    }
    try {
      writeAtomic(file, result.text)
    } catch (error) {
      return {
        ok: false,
        fixed: false,
        path: file,
        layout,
        message: '无法写入凭证文件',
        error: error && error.message ? error.message : String(error),
      }
    }
    return {
      ok: true,
      fixed: true,
      path: file,
      layout,
      message: '已将 version: ' + result.from + ' 纠正为 YAML 数字 version: ' + result.to + '（源码模式要求）',
    }
  }

  if (mode === 'source' && layout === 'flat') {
    return {
      ok: true,
      fixed: false,
      path: file,
      layout,
      message: '凭证仍是扁平布局；源码模式启动时 dsh 可能提示迁移到 version: 1 / refs',
    }
  }

  return {
    ok: true,
    fixed: false,
    path: file,
    layout,
    message: '凭证布局检查通过（' + layout + '）',
  }
}

/** @deprecated 兼容旧测试名；默认按源码模式处理 */
function ensureCredentialsVersion(options = {}) {
  return ensureCredentialsForMode({ ...options, mode: options.mode || 'source' })
}

/**
 * 从最近日志判断是否属于「修配置前再重启也没用」的启动致命错误。
 * @param {string[]} lines
 * @returns {string | null}
 */
function fatalBootReason(lines) {
  const blob = (Array.isArray(lines) ? lines : []).join('\n')
  if (/declares version .*; this build reads version/i.test(blob)) {
    return '凭证 version 类型与当前 dsh 构建不匹配（源码要数字 1，旧发布包不认 versioned 布局）。请用「源码」模式，或让 Dock 启动前自愈后再试。'
  }
  if (/the value for "version".*must be a string/i.test(blob)) {
    return 'NPM 发布包仍使用扁平凭证格式，与当前 versioned v1 凭证文件不兼容。请改用「源码」模式。'
  }
  if (/the value for "refs".*must be a string/i.test(blob)) {
    return 'NPM 发布包把 refs 当成普通字符串键，无法读取 versioned v1 凭证。请改用「源码」模式。'
  }
  if (/uses the pre-release flat layout/i.test(blob)) {
    return '凭证仍是扁平布局，当前源码构建需要 version: 1 与 refs: 嵌套。请按日志提示迁移，或改用兼容的发布包。'
  }
  if (/plugin tree failed to load/i.test(blob) && /credentials/i.test(blob)) {
    return '凭证插件加载失败，请检查 ~/.dsh/.credentials.yaml 与启动模式是否匹配（此类错误自动重启无效）。'
  }
  if (/required plugin did not activate/i.test(blob) && /credentials/i.test(blob)) {
    return 'credentials 插件未激活，多为凭证格式与启动模式不匹配。请改用「源码」模式或修复 ~/.dsh/.credentials.yaml。'
  }
  return null
}

module.exports = {
  CREDENTIALS_NAME,
  resolveDshHome,
  credentialsPath,
  detectCredentialsLayout,
  rewriteVersionToNumber,
  rewriteCredentialsVersion,
  ensureCredentialsForMode,
  ensureCredentialsVersion,
  fatalBootReason,
}
