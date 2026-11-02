import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  validateFeishuSettings,
  validateName,
  writePrivateJson,
  modelRef,
  captureFiles,
  restoreFiles,
  httpError,
  safeError,
} from './shared.js'

const controllerModelTransitionWorker = String.raw`
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const payload = JSON.parse(Buffer.from(process.argv.at(-1), 'base64url').toString('utf8'));
const domain = 'gui/' + payload.uid;
const statusFile = payload.dataRoot + '/controller-model-transition.json';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function writeStatus(status, message) {
  const value = { status, modelRef: payload.modelRef, updatedAt: new Date().toISOString(), ...(message ? { message: String(message).slice(0, 1000) } : {}) };
  const temporary = statusFile + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, statusFile);
  await fs.chmod(statusFile, 0o600);
}
async function waitForLockRelease() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { await fs.access(payload.lockFile); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await delay(150);
  }
  throw new Error('DS Bot did not release bot/state.lock after the DSH LaunchAgent stopped');
}
async function bootstrap() {
  await run('/bin/launchctl', ['bootstrap', domain, payload.launchdPlist], { timeout: 30000 });
}
async function main() {
  let stopped = false;
  let original;
  let stateChanged = false;
  try {
    await delay(250);
    await run('/bin/launchctl', ['bootout', domain, payload.launchdPlist], { timeout: 30000 });
    stopped = true;
    await waitForLockRelease();
    try { original = await fs.readFile(payload.stateFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original !== undefined) {
      const state = JSON.parse(original.toString('utf8'));
      if (!state || state.version !== 1 || !state.bots || typeof state.bots !== 'object' || Array.isArray(state.bots)) {
        throw new Error('DS Bot state has an unsupported format; no model changes were written');
      }
      for (const bot of Object.values(state.bots)) {
        if (!bot || typeof bot !== 'object' || Array.isArray(bot)) continue;
        bot.model = payload.modelRef;
        delete bot.appliedModel;
        delete bot.appliedEffort;
        delete bot.effort;
      }
      const temporary = payload.stateFile + '.' + process.pid + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, payload.stateFile);
      await fs.chmod(payload.stateFile, 0o600);
      stateChanged = true;
    }
    await writeStatus('applied');
    await bootstrap();
    stopped = false;
    await writeStatus('complete');
  } catch (error) {
    if (stopped && stateChanged && original !== undefined) {
      try {
        const temporary = payload.stateFile + '.' + process.pid + '.rollback';
        await fs.writeFile(temporary, original, { mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, payload.stateFile);
        await fs.chmod(payload.stateFile, 0o600);
      } catch {}
    }
    await writeStatus('failed', error?.message || String(error)).catch(() => {});
    if (stopped) await bootstrap().catch(() => {});
  } finally {
    await run('/bin/launchctl', ['remove', payload.helperLabel], { timeout: 10000 }).catch(() => {});
  }
}
void main();
`

export const controllerMethods = {
  async updateController(input) {
    return this.withMutation(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'update must be an object')
      if (input.feishu !== undefined && (this.controllerRuntime.updating || this.controllerRuntime.phase === 'restarting')) throw httpError(409, 'wait for the default DSH operation to finish before changing Feishu settings')
      const modelChanged = input.modelId !== undefined && input.modelId !== this.controller.modelId
      if (modelChanged && (this.controllerRuntime.updating || this.controllerRuntime.phase === 'restarting')) throw httpError(409, 'wait for the default DSH operation to finish before changing its model')
      const selectedModel = modelChanged ? this.requireModel(input.modelId) : undefined
      if (modelChanged) await this.assertControllerModelTransitionReady()
      if (input.port !== undefined && Number(input.port) !== this.parentPort) throw httpError(409, 'the default DSH controller port is fixed')
      if (input.autoStart !== undefined && input.autoStart !== true) throw httpError(409, 'the default DSH controller always starts with DSH')

      const previous = this.controller
      const previousSecret = this.feishuSecrets.default
      const next = { ...previous, feishu: { ...previous.feishu } }
      if (modelChanged) next.modelId = selectedModel.id
      if (input.name !== undefined) next.name = validateName(input.name)
      let nextSecret = previousSecret
      let feishuChanged = false
      let installedDuringUpdate = false
      if (input.feishu !== undefined) {
        const submitted = validateFeishuSettings(input.feishu)
        const suppliedSecret = input.feishu.appSecret
        if (suppliedSecret !== undefined && suppliedSecret !== '' && suppliedSecret !== null) {
          if (typeof suppliedSecret !== 'string' || suppliedSecret.length > 512 || suppliedSecret.trim() !== suppliedSecret || /\s/.test(suppliedSecret)) {
            throw httpError(400, 'Feishu App Secret must be a non-empty string of at most 512 characters')
          }
          nextSecret = suppliedSecret
        }
        if (input.feishu.clearAppSecret !== undefined && typeof input.feishu.clearAppSecret !== 'boolean') {
          throw httpError(400, 'clearAppSecret must be a boolean')
        }
        if (input.feishu.clearAppSecret === true) nextSecret = undefined
        feishuChanged = submitted.enabled !== previous.feishu.enabled
          || submitted.appId !== previous.feishu.appId
          || submitted.botId !== previous.feishu.botId
          || nextSecret !== previousSecret
        if (submitted.enabled) {
          if (!nextSecret) throw httpError(400, 'enter the Feishu App Secret before enabling this integration')
          const duplicate = this.teams.find(team => team.feishu.enabled && team.feishu.appId === submitted.appId)
          if (duplicate) throw httpError(409, `Feishu App ID is already assigned to team "${duplicate.id}"`)
          const bots = await this.getTeamBots('default')
          if (!bots.some(bot => bot.id === submitted.botId)) throw httpError(400, 'choose a Bot that exists in the default DSH instance')
        }
        next.feishu = submitted
      }

      if (feishuChanged && next.feishu.enabled && !await this.isControllerFeishuInstalled()) {
        const record = this.controllerRecord(next)
        this.controllerRuntime.phase = 'provisioning'
        try {
          const archive = await this.packFeishuPlugin()
          await this.runDsh(['plugin', '--profile', 'web', 'add', archive], record, this.controllerRuntime)
          next.feishuInstalled = true
          installedDuringUpdate = true
        } catch (error) {
          this.controllerRuntime.phase = 'running'
          this.controllerRuntime.message = `飞书插件安装失败：${this.teamError(error, record)}`
          throw error
        }
      }

      const modelSnapshot = modelChanged ? await captureFiles(this.controllerModelFiles()) : undefined

      this.controller = next
      if (input.feishu !== undefined) {
        if (nextSecret === undefined) delete this.feishuSecrets.default
        else this.feishuSecrets.default = nextSecret
      }
      try {
        if (feishuChanged) {
          next.feishuAgentId = next.feishu.enabled
            ? await this.resolveFeishuTargetSession(this.controllerRecord(next))
            : undefined
          await this.writeControllerFeishuPatch(next.feishu, next.feishuAgentId)
          await this.writeControllerFeishuEnvironment(next.feishu, nextSecret)
        }
        if (modelChanged) {
          await this.applyControllerModelFiles(selectedModel)
          await this.writeControllerModelEnvironment(selectedModel)
          await this.writeControllerModelTransitionStatus({
            status: 'pending',
            modelRef: modelRef(selectedModel),
            updatedAt: new Date().toISOString(),
            message: '等待默认 DSH 停止后更新 Bot 模型并恢复服务',
          })
        }
        if (input.feishu !== undefined) await this.saveFeishuSecrets()
        await this.saveControllerSettings()
      } catch (error) {
        this.controller = installedDuringUpdate ? { ...previous, feishuInstalled: true } : previous
        if (previousSecret === undefined) delete this.feishuSecrets.default
        else this.feishuSecrets.default = previousSecret
        if (input.feishu !== undefined) await this.saveFeishuSecrets().catch(() => {})
        await this.saveControllerSettings().catch(() => {})
        if (modelChanged) {
          await restoreFiles(modelSnapshot).catch(rollbackError => this.warn(`restore default model files: ${safeError(rollbackError)}`))
          await this.saveControllerSettings().catch(rollbackError => this.warn(`restore default model assignment: ${safeError(rollbackError)}`))
        }
        if (feishuChanged) {
          try {
            previous.feishuAgentId = previous.feishu.enabled
              ? await this.resolveFeishuTargetSession(this.controllerRecord(previous))
              : undefined
            await this.writeControllerFeishuPatch(previous.feishu, previous.feishuAgentId)
            await this.writeControllerFeishuEnvironment(previous.feishu, previousSecret)
          } catch (rollbackError) {
            this.warn(`restore default Feishu settings: ${safeError(rollbackError)}`)
          }
        }
        this.controllerRuntime.phase = 'running'
        this.controllerRuntime.message = ''
        throw error
      }
      if (feishuChanged || modelChanged) {
        this.controllerRuntime.feishuStatus = next.feishu.enabled ? 'connecting' : 'disabled'
        await this.scheduleControllerRestart(
          modelChanged ? '模型设置已保存，正在安全重启主 DSH 并更新全部 Bot' : '飞书设置已保存，正在重启主 DSH 使其生效',
          modelChanged ? { botModelRef: modelRef(selectedModel) } : undefined,
        )
      }
      return this.presentController()
    })
  },

  controllerRecord(settings = this.controller) {
    return {
      id: 'default', instanceId: 'controller', name: settings.name, port: this.parentPort,
      autoStart: true, feishuInstalled: settings.feishuInstalled, feishu: settings.feishu,
    }
  },

  async scheduleControllerRestart(message = '正在重启主 DSH', options = undefined) {
    const runtime = this.controllerRuntime
    if (runtime.restartScheduled || runtime.phase === 'restarting') return
    runtime.phase = 'restarting'
    runtime.message = message
    runtime.restartScheduled = true
    const timer = setTimeout(() => {
      runtime.restartScheduled = false
      void this.performControllerRestart(options).catch(error => {
        runtime.phase = 'running'
        runtime.message = `DSH 自动重启失败：${safeError(error)}`
        this.warn(runtime.message)
      })
    }, 350)
    timer.unref?.()
  },

  async restartController() {
    await this.initialize()
    if (this.controllerRuntime.updating || this.controllerRuntime.phase === 'provisioning') throw httpError(409, 'wait for the current default-instance operation to finish')
    await this.scheduleControllerRestart('正在重启主 DSH；其他团队实例会随管理器自动恢复')
    return this.presentController()
  },

  async performControllerRestart(options = undefined) {
    if (options?.botModelRef) {
      await this.startControllerModelTransition(options.botModelRef)
      return
    }
    let command
    let args
    if (this.restartCommand !== undefined) {
      if (typeof this.restartCommand !== 'string' || !this.restartCommand.trim()) throw new Error('restartCommand must be a non-empty string')
      if (this.restartArgs !== undefined && (!Array.isArray(this.restartArgs) || this.restartArgs.some(arg => typeof arg !== 'string'))) throw new Error('restartArgs must be an array of strings')
      command = this.restartCommand
      args = this.restartArgs ?? []
    } else if (process.platform === 'darwin' && typeof process.getuid === 'function') {
      if (!/^[A-Za-z0-9.-]+$/.test(this.launchdLabel)) throw new Error('launchdLabel is invalid')
      command = '/bin/launchctl'
      args = ['kickstart', '-k', `gui/${process.getuid()}/${this.launchdLabel}`]
    } else {
      throw new Error('configure restartCommand to restart the default DSH instance')
    }
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore' })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`restart command exited with ${code ?? 'unknown'}`)))
    })
  },

  async updateControllerBot() {
    const runtime = this.controllerRuntime
    if (runtime.updating || runtime.restartScheduled || runtime.phase === 'restarting') throw httpError(409, 'wait for the current default-instance operation to finish')
    runtime.updating = true
    runtime.phase = 'updating'
    runtime.message = '正在更新主 DSH Web 配置中的 DS Bot'
    try {
      await this.initialize()
      const installedPackage = path.join(this.parentHome, 'profiles', 'web', 'node_modules', this.botPackage, 'package.json')
      let installed = true
      try { await access(installedPackage) } catch (error) { if (error.code === 'ENOENT') installed = false; else throw error }
      const args = installed
        ? ['plugin', '--profile', 'web', 'update', '--latest', this.botPackage]
        : ['plugin', '--profile', 'web', 'add', this.botPackage]
      await this.runDsh(args, this.controllerRecord(), runtime)
      runtime.updating = false
      await this.scheduleControllerRestart('DS Bot 已更新，正在重启主 DSH')
      return this.presentController()
    } catch (error) {
      runtime.updating = false
      runtime.phase = 'running'
      runtime.message = `DS Bot 更新失败：${this.teamError(error, this.controllerRecord())}`
      throw error
    }
  },

  async assertControllerModelTransitionReady() {
    if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || this.restartCommand !== undefined) {
      throw httpError(409, 'safely changing the default instance model requires its macOS LaunchAgent; configure a LaunchAgent-based controller before retrying')
    }
    if (!/^[A-Za-z0-9.-]+$/.test(this.launchdLabel)) throw httpError(500, 'launchdLabel is invalid')
    try { await access(this.launchdPlist) } catch (error) {
      if (error.code === 'ENOENT') throw httpError(409, `the default DSH LaunchAgent plist was not found at ${this.launchdPlist}`)
      throw error
    }
  },

  async writeControllerModelTransitionStatus(status) {
    await writePrivateJson(this.controllerModelTransitionFile, status)
  },

  async loadControllerModelTransitionStatus() {
    try {
      const status = JSON.parse(await readFile(this.controllerModelTransitionFile, 'utf8'))
      if (status?.status === 'failed') {
        this.controllerRuntime.message = `默认实例模型切换失败：${safeError(status.message || '未知错误')}`
      } else if (status?.status === 'pending') {
        this.controllerRuntime.message = '默认实例模型切换尚未完成；请检查 DSH 服务与模型切换日志后再重试'
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.warn(`read controller model transition status: ${safeError(error)}`)
    }
  },

  async startControllerModelTransition(ref) {
    await this.assertControllerModelTransitionReady()
    const helperLabel = `com.ds-headbot.model-transition.${randomUUID()}`
    const payload = Buffer.from(JSON.stringify({
      dataRoot: this.root,
      stateFile: path.join(this.parentHome, 'bot', 'state.json'),
      lockFile: path.join(this.parentHome, 'bot', 'state.lock'),
      modelRef: ref,
      launchdLabel: this.launchdLabel,
      launchdPlist: this.launchdPlist,
      uid: process.getuid(),
      helperLabel,
    })).toString('base64url')
    const worker = spawn('/bin/launchctl', [
      'submit', '-l', helperLabel, '--', process.execPath, '-e', controllerModelTransitionWorker, payload,
    ], { stdio: 'ignore' })
    await new Promise((resolve, reject) => {
      worker.once('spawn', resolve)
      worker.once('error', reject)
    })
    await new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('close', code => code === 0 ? resolve() : reject(new Error(`launchctl submit exited with ${code ?? 'unknown'}`)))
    })
  },
}
