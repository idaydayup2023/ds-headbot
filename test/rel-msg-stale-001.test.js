// REL-MSG-STALE-001（P3，0.4.29 候批弹药）：升级成功态 message 随 currentVersion 同步刷新。
// 生产现场 2026-11-20：0.4.28 带外落位（mv 程序）后卡面 release 卡 message="已升级到 0.4.27"——
// completed 态的展示件来自上一轮升级 run 的 state 账，installed 翻代后成残影。
// 锁定五枚：残影刷新+落盘归位／同版幂等零重写／failed 态不洗白／在途归正腿回归（既有行为）／无账 idle 零话术。
// 不碰真网络：release 缓存预置，fetchImpl 触网即炸。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotReleaseUpdater } from '../lib/release-updater.js'

const INSTALLED = '0.4.27'

async function makeUpdater(stateContents) {
  const root = await mkdtemp(path.join(tmpdir(), 'rel-msg-stale-'))
  const updater = new HeadbotReleaseUpdater({
    currentVersion: INSTALLED,
    manager: { root, parentHome: root, dshCommand: 'dsh' },
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => { throw new Error('REL-MSG-STALE-001：测试不得触网') },
  })
  updater.cache = { checkedAt: Date.now(), release: { version: INSTALLED, url: 'https://example.invalid/rel' } }
  if (stateContents !== undefined) await writeFile(updater.stateFile, JSON.stringify(stateContents))
  return updater
}

test('REL-MSG-STALE-001 ①残影刷新：completed+旧 targetVersion → message 随 currentVersion 且落盘归位、completedAt 不动', async () => {
  const completedAt = '2026-11-17T11:40:00.000Z'
  const updater = await makeUpdater({ state: 'completed', targetVersion: '0.4.26', message: '已升级到 0.4.26', completedAt })
  const card = await updater.check()
  assert.equal(card.state, 'completed', 'completed 语义不得翻动')
  assert.equal(card.currentVersion, INSTALLED)
  assert.equal(card.message, `已升级到 ${INSTALLED}`, 'REL-MSG-STALE-001：残影必须被刷成随装版')
  const persisted = JSON.parse(await readFile(updater.stateFile, 'utf8'))
  assert.equal(persisted.message, `已升级到 ${INSTALLED}`, '刷新须落盘自愈，不许每次读现场重算')
  assert.equal(persisted.targetVersion, INSTALLED, 'targetVersion 归位后本腿闭合，不得反复重写')
  assert.equal(persisted.completedAt, completedAt, 'completedAt=最后真实完成时刻，展示刷新不伪造新完成事件')
})

test('REL-MSG-STALE-001 ②同版 completed 幂等：账与装同版时零重写', async () => {
  const before = JSON.stringify({ state: 'completed', targetVersion: INSTALLED, message: `已升级到 ${INSTALLED}`, completedAt: '2026-11-20T06:13:48.000Z' })
  const updater = await makeUpdater(JSON.parse(before))
  let writes = 0
  const original = updater.writeState.bind(updater)
  updater.writeState = (value) => { writes += 1; return original(value) }
  const card = await updater.check()
  assert.equal(card.message, `已升级到 ${INSTALLED}`)
  assert.equal(writes, 0, 'REL-MSG-STALE-001：同版幂等=一次重写都不许发生（字节相等不算不重写）')
  const after = await readFile(updater.stateFile, 'utf8')
  assert.equal(after, before, '同版无残影=一个字节都不许动')
})

test('REL-MSG-STALE-001 ③failed 态不洗白：旧 targetVersion 的失败账原样透传', async () => {
  const updater = await makeUpdater({ state: 'failed', targetVersion: '0.4.26', message: '升级失败: boom', failedAt: '2026-11-16T00:00:00.000Z' })
  const card = await updater.check()
  assert.equal(card.state, 'failed', 'REL-MSG-STALE-001：失败史实不得被展示刷新洗成成功')
  assert.equal(card.message, '升级失败: boom')
})

test('REL-MSG-STALE-001 ④在途归正腿回归：targetVersion 命中的 downloading 照旧翻 completed+盖章', async () => {
  const updater = await makeUpdater({ state: 'downloading', targetVersion: INSTALLED, message: '正在准备升级包' })
  const card = await updater.check()
  assert.equal(card.state, 'completed')
  assert.equal(card.message, `已升级到 ${INSTALLED}`)
  const persisted = JSON.parse(await readFile(updater.stateFile, 'utf8'))
  assert.equal(persisted.state, 'completed', '既有归正腿（L108）必须继续落盘')
})

test('REL-MSG-STALE-001 ⑤无 state 账=idle 零话术：刷新腿不得无中生有', async () => {
  const updater = await makeUpdater(undefined)
  const card = await updater.check()
  assert.equal(card.state, 'idle')
  assert.equal(card.message, '', 'REL-MSG-STALE-001：没升过就不许出现「已升级到」')
})
