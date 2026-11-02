import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import {
  writePrivateFile,
  httpError,
  safeError,
  feishuPluginDirectory,
  FEISHU_PLUGIN_NAME,
} from './shared.js'

function upsertDisabledPatch(patches, id, name) {
  const matches = patches.map((entry, index) => entry && entry.id === id ? index : -1).filter(index => index >= 0)
  if (matches.length > 1) throw new Error(`profile patch contains multiple ${id} entries`)
  const index = matches[0] ?? -1
  const patch = index >= 0 ? patches[index] : { id, name }
  patch.name = name
  patch.disabled = true
  if (index < 0) patches.push(patch)
}

async function hashPackageDirectory(directory) {
  const hash = createHash('sha256')
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const file = path.join(current, entry.name)
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(file, name)
      else if (entry.isFile()) {
        hash.update(name.replaceAll(path.sep, '/') + '\0')
        hash.update(await readFile(file))
      }
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

function runPack(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`packing ds-headbot-feishu failed with exit code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)))
  })
}

export const feishuMethods = {
  async isControllerFeishuInstalled() {
    return this.isPackagedFeishuPluginInstalled(this.parentHome)
  },

  feishuPluginPath() {
    return feishuPluginDirectory
  },

  async isPackagedFeishuPluginInstalled(home) {
    const packageJson = path.join(home, 'profiles', 'web', 'node_modules', FEISHU_PLUGIN_NAME, 'package.json')
    try {
      const installed = JSON.parse(await readFile(packageJson, 'utf8'))
      const source = JSON.parse(await readFile(path.join(this.feishuPluginPath(), 'package.json'), 'utf8'))
      if (installed.name !== FEISHU_PLUGIN_NAME || installed.version !== source.version) return false
      const [installedDirectory, sourceDirectory] = await Promise.all([
        realpath(path.dirname(packageJson)),
        realpath(this.feishuPluginPath()),
      ])
      // A pnpm link to the controller's source tree cannot resolve peer dependencies
      // from an isolated team profile. A packaged dependency is installed in that profile.
      return installedDirectory !== sourceDirectory
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  },

  async packFeishuPlugin() {
    const source = this.feishuPluginPath()
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
    if (manifest.name !== FEISHU_PLUGIN_NAME || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw new Error('ds-headbot-feishu package metadata is invalid')
    }
    const digest = await hashPackageDirectory(source)
    const packagesDirectory = path.join(this.root, 'packages')
    await mkdir(packagesDirectory, { recursive: true, mode: 0o700 })
    const archive = path.join(packagesDirectory, `${manifest.name}-${manifest.version}-${digest.slice(0, 16)}.tgz`)
    try {
      await access(archive)
      return archive
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'headbot-feishu-pack-'))
    try {
      const bundledNpm = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      let command = 'npm'
      let args = ['pack', source, '--pack-destination', temporaryDirectory, '--ignore-scripts', '--silent']
      try {
        await access(bundledNpm)
        command = process.execPath
        args = [bundledNpm, ...args]
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await runPack(command, args, source)
      const packedArchive = path.join(temporaryDirectory, `${manifest.name}-${manifest.version}.tgz`)
      await access(packedArchive)
      await rename(packedArchive, archive)
      await chmod(archive, 0o600)
      return archive
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },

  watchControllerFeishuTarget() {
    clearInterval(this.controllerRuntime.feishuMonitor)
    this.controllerRuntime.feishuMonitor = undefined
    if (!this.controller.feishu.enabled) return
    this.controllerRuntime.feishuMonitor = setInterval(async () => {
      if (this.closing || !this.controller.feishu.enabled || this.controllerRuntime.restartScheduled || this.controllerRuntime.updating || ['provisioning', 'updating', 'restarting'].includes(this.controllerRuntime.phase)) return
      try {
        const agentId = await this.resolveFeishuTargetSession(this.controllerRecord())
        if (agentId === this.controller.feishuAgentId) return
        this.controller.feishuAgentId = agentId
        await this.writeControllerFeishuPatch(this.controller.feishu, agentId)
        await this.saveControllerSettings()
        this.controllerRuntime.feishuStatus = 'connecting'
        await this.scheduleControllerRestart('默认 Bot 会话已变化，正在刷新飞书绑定')
      } catch (error) {
        this.warn(`check default Feishu binding: ${safeError(error)}`)
      }
    }, 30_000)
    this.controllerRuntime.feishuMonitor.unref?.()
  },

  async isTeamFeishuInstalled(team) {
    return this.isPackagedFeishuPluginInstalled(path.join(this.root, 'teams', team.id, 'home'))
  },

  async writeControllerFeishuPatch(settings, agentId) {
    const directory = path.join(this.parentHome, 'profiles', 'web')
    const file = path.join(directory, 'cordis.patch.yml')
    let patches = []
    try {
      patches = parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!Array.isArray(patches)) throw new Error('parent Web profile patch must be an array')
    const matches = patches.map((entry, index) => entry && entry.id === FEISHU_PLUGIN_NAME ? index : -1).filter(index => index >= 0)
    if (matches.length > 1) throw new Error(`the parent Web profile patch contains multiple ${FEISHU_PLUGIN_NAME} entries; preserve it and resolve them before configuring Feishu`)
    const index = matches[0] ?? -1
    const pluginInstalled = await this.isControllerFeishuInstalled()
    if (!settings.enabled && !pluginInstalled && index < 0) {
      if (await this.isLegacyFeishuInstalled(directory)) upsertDisabledPatch(patches, 'feishu-bot', '@zyfgood/dsh-feishu-bot')
      else return
    }
    const patch = index >= 0 ? patches[index] : { id: FEISHU_PLUGIN_NAME, name: FEISHU_PLUGIN_NAME }
    if (settings.enabled) {
      patch.name = FEISHU_PLUGIN_NAME
      patch.disabled = false
      patch.config = {
        ...(patch.config && typeof patch.config === 'object' ? patch.config : {}),
        appId: 'env:HEADBOT_DEFAULT_FEISHU_APP_ID',
        appSecret: 'env:HEADBOT_DEFAULT_FEISHU_APP_SECRET',
        domain: 'feishu', mode: 'agent', agentId, replyToSource: true,
        dmMode: 'open', requireMention: true, commands: true, tools: true,
      }
    } else {
      patch.disabled = true
    }
    if (pluginInstalled || settings.enabled || index >= 0) {
      if (index < 0) patches.push(patch)
    }
    if (await this.isLegacyFeishuInstalled(directory)) {
      upsertDisabledPatch(patches, 'feishu-bot', '@zyfgood/dsh-feishu-bot')
    }
    if (!pluginInstalled && !settings.enabled && index < 0 && patches.length === 0) return
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writePrivateFile(file, stringify(patches))
  },

  async isLegacyFeishuInstalled(profileHome) {
    try {
      await access(path.join(profileHome, 'node_modules', '@zyfgood', 'dsh-feishu-bot', 'package.json'))
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  },

  async writeControllerFeishuEnvironment(settings, secret) {
    const file = path.join(this.parentHome, '.env')
    const start = '# BEGIN DS-Headbot default Feishu settings'
    const end = '# END DS-Headbot default Feishu settings'
    let content = ''
    try { content = await readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const lines = content.split(/\r?\n/)
    const begin = lines.indexOf(start)
    const finish = lines.indexOf(end)
    if ((begin < 0) !== (finish < 0) || (begin >= 0 && finish < begin)) throw new Error('the DSH .env file has an incomplete Headbot Feishu block; preserve it and inspect before editing')
    if (begin >= 0) lines.splice(begin, finish - begin + 1)
    let next = lines.join('\n').replace(/\n*$/, '')
    if (settings.enabled) {
      const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
      const block = [start,
        `HEADBOT_DEFAULT_FEISHU_APP_ID=${quote(settings.appId)}`,
        `HEADBOT_DEFAULT_FEISHU_APP_SECRET=${quote(secret)}`,
        end].join('\n')
      next = `${next ? `${next}\n` : ''}${block}\n`
    } else if (next) next += '\n'
    await writePrivateFile(file, next)
  },

  async getTeamBots(id) {
    await this.initialize()
    if (id === 'default') return this.readBots(path.join(this.parentHome, 'bot', 'state.json'))
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    const stateFile = path.join(this.root, 'teams', id, 'home', 'bot', 'state.json')
    return this.readBots(stateFile)
  },

  async readBots(stateFile) {
    let state
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error('unable to read this team’s DS Bot list')
    }
    const bots = state?.bots && typeof state.bots === 'object' && !Array.isArray(state.bots) ? state.bots : {}
    return Object.entries(bots)
      .filter(([id, bot]) => typeof id === 'string' && bot && typeof bot.name === 'string')
      .map(([botId, bot]) => ({ id: botId, name: bot.name, role: typeof bot.role === 'string' ? bot.role : '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  },

  async resolveFeishuTargetSession(team) {
    const stateFile = team.id === 'default'
      ? path.join(this.parentHome, 'bot', 'state.json')
      : path.join(this.root, 'teams', team.id, 'home', 'bot', 'state.json')
    let state
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(409, 'open the team once in DSH so its DS Bot list is initialized')
      throw new Error('unable to read the selected DS Bot state')
    }
    const bot = state?.bots?.[team.feishu.botId]
    if (!bot) throw httpError(409, 'the selected DS Bot no longer exists; choose another Bot in team settings')
    const sessionId = typeof bot.sessionId === 'string' && bot.sessionId ? bot.sessionId : team.feishu.botId
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) throw new Error('the selected DS Bot has an invalid DSH session ID')
    return sessionId
  },

  watchFeishuTarget(team, runtime) {
    clearInterval(runtime.feishuMonitor)
    runtime.feishuMonitor = undefined
    runtime.feishuRebinding = false
    if (!team.feishu.enabled || !runtime.feishuAgentId) return
    runtime.feishuMonitor = setInterval(async () => {
      if (!runtime.child || runtime.phase !== 'running' || runtime.feishuRebinding) return
      try {
        const currentSession = await this.resolveFeishuTargetSession(team)
        if (currentSession === runtime.feishuAgentId) return
        runtime.feishuRebinding = true
        runtime.message = 'DS Bot 会话已切换，正在刷新飞书绑定…'
        void this.restartTeam(team.id)
          .catch(error => this.warn(`refresh Feishu binding ${team.id}: ${safeError(error)}`))
          .finally(() => { runtime.feishuRebinding = false })
      } catch (error) {
        this.warn(`check Feishu binding ${team.id}: ${safeError(error)}`)
      }
    }, 30_000)
    runtime.feishuMonitor.unref?.()
  },
}
