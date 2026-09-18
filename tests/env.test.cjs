// 引擎版本门槛的纯逻辑单测：npm test（node --test，无需 Electron 运行时）
// 覆盖启动决策的核心判定：Node 版本解析与 ^22.19.0 || >=24.0.0 门槛
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseVersion, satisfiesEngines, compareVersions } = require('../electron/backend/env.cjs')

test('parseVersion：解析 v 前缀版本，垃圾输入返回 null', () => {
  assert.deepEqual(parseVersion('v22.19.0'), { major: 22, minor: 19, patch: 0, raw: 'v22.19.0' })
  assert.equal(parseVersion('24.3.1').major, 24)
  assert.equal(parseVersion('  v18.20.4 ').major, 18) // 先 trim 再解析
  assert.equal(parseVersion('v22.19.0-rc.1').raw, 'v22.19.0') // prerelease 后缀被忽略
  assert.equal(parseVersion('not a version'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(null), null)
})

test('satisfiesEngines：门槛 ^22.19.0 || >=24.0.0', () => {
  assert.equal(satisfiesEngines(parseVersion('v22.18.9')), false)
  assert.equal(satisfiesEngines(parseVersion('v22.19.0')), true)
  assert.equal(satisfiesEngines(parseVersion('v22.20.3')), true)
  assert.equal(satisfiesEngines(parseVersion('v23.9.9')), false)
  assert.equal(satisfiesEngines(parseVersion('v24.0.0')), true)
  assert.equal(satisfiesEngines(parseVersion('v26.1.0')), true)
  assert.equal(satisfiesEngines(null), false)
})

test('compareVersions：按 major/minor/patch 升序比较', () => {
  const v = (s) => parseVersion(s)
  assert.ok(compareVersions(v('v22.19.0'), v('v24.0.0')) < 0)
  assert.ok(compareVersions(v('v24.0.0'), v('v22.19.0')) > 0)
  assert.ok(compareVersions(v('v22.19.1'), v('v22.19.0')) > 0)
  assert.equal(compareVersions(v('v24.0.0'), v('v24.0.0')), 0)
})

test('resolveSpawnEntry：定位 node CLI 入口，布局缺失则回退 null', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { resolveSpawnEntry } = require('../electron/backend/env.cjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-entry-'))
  const write = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '') }
  const nodeExe = path.join(tmp, 'node.exe')
  write(nodeExe)

  // 空 nodeDir → null
  assert.equal(resolveSpawnEntry('', 'source'), null)

  // pnpm 布局齐全 → source 模式返回 pnpm.cjs + dsh web
  const pnpmCjs = path.join(tmp, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  write(pnpmCjs)
  assert.deepEqual(resolveSpawnEntry(tmp, 'source'), { exe: nodeExe, args: [pnpmCjs, 'dsh', 'web'] })

  // npm 布局齐全 → npx-cli.js + -y @deepseek-ai/dsh web
  const npxCli = path.join(tmp, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  write(npxCli)
  assert.deepEqual(resolveSpawnEntry(tmp, 'npm'), { exe: nodeExe, args: [npxCli, '-y', '@deepseek-ai/dsh', 'web'] })

  // 入口文件缺失 → null（调用方回退 cmd 重定向）
  fs.rmSync(pnpmCjs)
  assert.equal(resolveSpawnEntry(tmp, 'source'), null)
  fs.rmSync(tmp, { recursive: true, force: true })
})
