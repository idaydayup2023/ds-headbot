import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// F5 lock (third-party audit finding P3): the README version line drifted to 0.4.9 for fifteen
// releases. The card version line is now welded to package.json — releasing without doc sync
// fails the suite — and the sections that had to be written in 0.4.24 carry coverage probes so
// future features cannot silently vanish from the documentation again.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = await readFile(path.join(root, 'README.md'), 'utf8')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

test('the README version line is welded to package.json (release without doc sync is red)', () => {
  const match = readme.match(/Current package version: \*\*([^*]+)\*\*/)
  assert.ok(match, 'README carries the version line')
  assert.equal(match[1], pkg.version, 'README version matches package.json; bump both together')
})

test('every management card and its upgrade path is documented', () => {
  for (const card of ['DS Headbot', 'DS Bot', 'DeepSeek Harness', 'LiteLLM', 'SparkDash']) {
    assert.ok(readme.includes(card), `card ${card} is named in the README`)
  }
  assert.match(readme, /升级到 vX\.Y\.Z/, 'the upgrade button contract is documented')
  assert.match(readme, /升级中/, 'the upgrading button state is documented')
  assert.match(readme, /v2\.90\.0/, 'the SparkDash tag-as-version mapping is documented with its real tag')
})

test('the 0.4.24 feature set stays in the documentation', async () => {
  assert.match(readme, /githubToken/, 'the GitHub token configuration is documented')
  assert.match(readme, /LITELLM_UPGRADE_GITHUB_TOKEN/, 'the per-card token environment fallbacks are documented')
  assert.match(readme, /inbox push/, 'inbox push delivery is documented')
  assert.match(readme, /audit\.000001\.jsonl/, 'journal segmentation file naming is documented')
  assert.match(readme, /journalRotateBytes/, 'the rotate size knob is documented')
  assert.match(readme, /Back up \*\*by segment\*\*/, 'backups are documented per segment, not as one growing file')
  assert.ok(!readme.includes('0.4.9'), 'the stale 0.4.9 version line is gone for good')
})

test('the 0.4.25 feature set stays in the documentation', () => {
  assert.match(readme, /Team model settings inheritance/, 'the single-source inheritance section exists')
  assert.match(readme, /model-inherited-/, 'the legacy-copy migration naming is documented')
  assert.match(readme, /model-selection\.patch\.yml/, 'the generated team selection overlay is documented')
  assert.match(readme, /model-override\.patch\.yml/, 'the explicit team override file is documented')
  assert.match(readme, /adopted the still-serving/, 'the adoption log line is documented as on-disk-visible')
  assert.match(readme, /input.*modalit/i, 'catalog input modalities are documented')
})
