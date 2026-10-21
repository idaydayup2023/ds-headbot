import { Service } from '@deepseek-ai/cordis';
export function mapFeishuConnectionState(state) {
    switch (state) {
        case 'idle': return 'offline';
        case 'connecting': return 'connecting';
        case 'connected': return 'connected';
        case 'reconnecting': return 'retrying';
        case 'failed': return 'failed';
        default: return 'unknown';
    }
}
export class HeadbotFeishuStatus extends Service {
    agentStatus = 'restoring';
    constructor(ctx) {
        super(ctx, 'headbotFeishu');
    }
    setAgentStatus(status) {
        this.agentStatus = status;
    }
    getAgentStatus() {
        return this.agentStatus;
    }
}
