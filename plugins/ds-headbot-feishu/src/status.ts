import { Service, type Context } from '@deepseek-ai/cordis'

export type HeadbotAgentStatus = 'restoring' | 'online' | 'offline' | 'failed'

export type HeadbotFeishuConnectionStatus = 'unknown' | 'connecting' | 'connected' | 'retrying' | 'offline' | 'failed'

export function mapFeishuConnectionState(state?: string): HeadbotFeishuConnectionStatus {
  switch (state) {
    case 'idle': return 'offline'
    case 'connecting': return 'connecting'
    case 'connected': return 'connected'
    case 'reconnecting': return 'retrying'
    case 'failed': return 'failed'
    default: return 'unknown'
  }
}

export const HEADBOT_FEISHU_STATUS_ENV = 'HEADBOT_FEISHU_STATUS'
export const HEADBOT_FEISHU_STATUS_AT_ENV = 'HEADBOT_FEISHU_STATUS_AT'
export const HEADBOT_FEISHU_AGENT_STATUS_ENV = 'HEADBOT_FEISHU_AGENT_STATUS'

// FEISHU-STATUS-001: a managed team instance pushes these same values to the controller over
// /comms/v1/status; the default instance hosts the plugin in-process, so the controller reflects
// them from the environment instead. The heartbeat stamp lets the controller tell a live plugin
// from one that unloaded while its last-known status still sat in the environment.
export function writeConnectionStatusEnv(connection: HeadbotFeishuConnectionStatus, agent: HeadbotAgentStatus): void {
  process.env[HEADBOT_FEISHU_STATUS_ENV] = connection
  process.env[HEADBOT_FEISHU_AGENT_STATUS_ENV] = agent
  process.env[HEADBOT_FEISHU_STATUS_AT_ENV] = String(Date.now())
}

export class HeadbotFeishuStatus extends Service {
  private agentStatus: HeadbotAgentStatus = 'restoring'

  constructor(ctx: Context) {
    super(ctx, 'headbotFeishu')
  }

  setAgentStatus(status: HeadbotAgentStatus): void {
    this.agentStatus = status
  }

  getAgentStatus(): HeadbotAgentStatus {
    return this.agentStatus
  }
}
