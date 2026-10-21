import { Service, type Context } from '@deepseek-ai/cordis';
export type HeadbotAgentStatus = 'restoring' | 'online' | 'offline' | 'failed';
export type HeadbotFeishuConnectionStatus = 'unknown' | 'connecting' | 'connected' | 'retrying' | 'offline' | 'failed';
export declare function mapFeishuConnectionState(state?: string): HeadbotFeishuConnectionStatus;
export declare class HeadbotFeishuStatus extends Service {
    private agentStatus;
    constructor(ctx: Context);
    setAgentStatus(status: HeadbotAgentStatus): void;
    getAgentStatus(): HeadbotAgentStatus;
}
