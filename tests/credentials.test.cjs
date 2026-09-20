// 凭证布局识别 / 自愈纯逻辑单测：npm test（node --test，无需 Electron 运行时）
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  detectCredentialsLayout,
  rewriteVersionToNumber,
  rewriteCredentialsVersion,
  ensureCredentialsForMode,
  fatalBootReason,
  credentialsPath,
  resolveDshHome,
} = require('../electron/backend/credentials.cjs')

test('resolveDshHome：优先 DSH_HOME，否则 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'E:\\custom-dsh' }), 'E:\\custom-dsh')
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'))
  assert.equal(credentialsPath({ DSH_HOME: 'E:\\custom-dsh' }), path.join('E:\\custom-dsh', '.credentials.yaml'))
})

test('detectCredentialsLayout：识别 versioned v1 / flat / empty', () => {
  assert.equal(detectCredentialsLayout('version: 1\nrefs:\n  A: x\n'), 'versioned-v1')
  assert.equal(detectCredentialsLayout('version: "1"\nrefs: {}\nrecords: {}\n'), 'versioned-v1')
  assert.equal(detectCredentialsLayout('API_KEY: secret\nOTHER: value\n'), 'flat')
  assert.equal(detectCredentialsLayout('# only comments\n\n'), 'empty')
})

test('rewriteVersionToNumber：源码模式把 "1" 纠正为数字 1', () => {
  const result = rewriteVersionToNumber('version: "1"\nrefs:\n  K: v\n')
  assert.equal(result.fixed, true)
  assert.equal(result.from, '"1"')
  assert.equal(result.to, '1')
  assert.match(result.text, /^version: 1\n/)
})

test('rewriteVersionToNumber：已是数字则不改', () => {
  const input = 'version: 1\nrefs: {}\n'
  const result = rewriteVersionToNumber(input)
  assert.equal(result.fixed, false)
  assert.equal(result.text, input)
})

test('rewriteCredentialsVersion：对照旧逻辑仍可把数字写成字符串', () => {
  const result = rewriteCredentialsVersion('version: 1\nrefs: {}\n')
  assert.equal(result.fixed, true)
  assert.match(result.text, /^version: "1"\n/)
})

test('ensureCredentialsForMode：npm + versioned v1 → 拒绝并建议源码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'))
  const file = path.join(dir, '.credentials.yaml')
  fs.writeFileSync(file, 'version: 1\nrefs:\n  DEMO: secret\nrecords: {}\n', 'utf8')
  const result = ensureCredentialsForMode({ mode: 'npm', path: file })
  assert.equal(result.ok, false)
  assert.equal(result.preferSource, true)
  assert.equal(result.layout, 'versioned-v1')
  assert.match(result.message, /源码/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ensureCredentialsForMode：source + 引号 version → 落盘纠正为数字', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'))
  const file = path.join(dir, '.credentials.yaml')
  fs.writeFileSync(file, 'version: "1"\nrefs:\n  DEMO: secret\n', 'utf8')
  const result = ensureCredentialsForMode({ mode: 'source', path: file })
  assert.equal(result.ok, true)
  assert.equal(result.fixed, true)
  assert.match(fs.readFileSync(file, 'utf8'), /^version: 1\n/)
  const again = ensureCredentialsForMode({ mode: 'source', path: file })
  assert.equal(again.fixed, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ensureCredentialsForMode：缺文件跳过', () => {
  const missing = path.join(os.tmpdir(), 'dsh-cred-missing-' + process.pid + '.yaml')
  const result = ensureCredentialsForMode({ mode: 'source', path: missing })
  assert.equal(result.ok, true)
  assert.equal(result.layout, 'missing')
})

test('fatalBootReason：覆盖两代凭证错误文案', () => {
  assert.match(
    fatalBootReason(['credentials-local: file declares version "1"; this build reads version 1']),
    /不匹配/,
  )
  assert.match(
    fatalBootReason(['credentials-local: the value for "refs" in x must be a string']),
    /源码/,
  )
  assert.match(
    fatalBootReason(['StartupError: required plugin did not activate', 'credentials']),
    /credentials/,
  )
  assert.equal(fatalBootReason(['dsh web: http://127.0.0.1:3080/']), null)
})
