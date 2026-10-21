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
