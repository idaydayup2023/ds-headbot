import { Service, type Context } from '@deepseek-ai/cordis';
export type HeadbotAgentStatus = 'restoring' | 'online' | 'offline' | 'failed';
export type HeadbotFeishuConnectionStatus = 'unknown' | 'connecting' | 'connected' | 'retrying' | 'offline' | 'failed';
export declare function mapFeishuConnectionState(state?: string): HeadbotFeishuConnectionStatus;
export declare const HEADBOT_FEISHU_STATUS_ENV = "HEADBOT_FEISHU_STATUS";
export declare const HEADBOT_FEISHU_STATUS_AT_ENV = "HEADBOT_FEISHU_STATUS_AT";
export declare const HEADBOT_FEISHU_AGENT_STATUS_ENV = "HEADBOT_FEISHU_AGENT_STATUS";
export declare function writeConnectionStatusEnv(connection: HeadbotFeishuConnectionStatus, agent: HeadbotAgentStatus): void;
export declare class HeadbotFeishuStatus extends Service {
    private agentStatus;
    constructor(ctx: Context);
    setAgentStatus(status: HeadbotAgentStatus): void;
    getAgentStatus(): HeadbotAgentStatus;
}
