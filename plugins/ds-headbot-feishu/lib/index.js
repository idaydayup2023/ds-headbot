/**
 * ds-headbot-feishu — DS Headbot's managed Feishu bridge for DeepSeek Harness.
 *
 * 功能：
 * - 绑定：配置飞书自建应用的 appId/appSecret，通过官方 SDK 的 WebSocket
 *   长连接接入（免公网回调地址），SDK 内置自动重连；
 * - 互动（入站）：用户给机器人发消息 → 按 mode 处理
 *   （echo 回显 / llm 用 ctx.llm 自动回复 / agent 转交给 DSH agent 回复）；
 * - 互动（出站）：注册 feishu_* 模型工具，让 DSH agent 主动发消息、
 *   回复、查会话、查消息、查连接状态、发交互卡片、发起确认问答；
 * - 确认问答：agent 调用 ask_user_question 时问题以「按钮卡片 + 编号提示」
 *   发到飞书（点按钮/回编号/回复选项文字/超时兜底），不再只在 Web 界面挂起；
 * - 会话延续：chat→会话映射落盘，dsh web 重启后自动 resume 原 DSH 会话；
 * - Headbot 模式下复用所选 DS Bot 的原生 DSH 会话，在入站消息中附带
 *   飞书来源、会话、消息和发言人元数据，并将本轮回答引用到原消息。
 *
 * 加载方式（profile 的 cordis.patch.yml）：
 * ```yaml
 * - id: ds-headbot-feishu
 *   name: ds-headbot-feishu
 *   config:
 *     appId: 'env:FEISHU_APP_ID'
 *     appSecret: 'env:FEISHU_APP_SECRET'
 *     mode: llm
 *     provider: deepseek-official
 *     model: deepseek-v4-flash
 * ```
 *
 * @module ds-headbot-feishu
 */
import z from '@deepseek-ai/schemastery';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FeishuService } from "./service.js";
import { attachInbound } from "./inbound.js";
import { registerFeishuTools } from "./tools.js";
import { PendingQuestionState } from "./questions.js";
import { ChatSessionStore, ModelOverrideStore } from "./persistence.js";
import { HeadbotFeishuStatus, mapFeishuConnectionState } from "./status.js";
export const name = 'ds-headbot-feishu';
export const inject = ['agents', 'sessionPersistence'];
export const Config = z.object({
    appId: z.string().required().description('飞书自建应用的 App ID（cli_xxx），支持 env:VAR 从环境变量读取'),
    appSecret: z.string().required().description('飞书自建应用的 App Secret，支持 env:VAR 从环境变量读取'),
    domain: z.union(['feishu', 'lark']).default('feishu'),
    loggerLevel: z.union(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    dmMode: z.union(['open', 'allowlist', 'pair', 'disabled']).default('open'),
    dmAllowlist: z.array(z.string()).default([]),
    groupAllowlist: z.array(z.string()).default([]),
    requireMention: z.boolean().default(true),
    respondToMentionAll: z.boolean().default(false),
    mode: z.union(['echo', 'llm', 'agent']).default('llm'),
    /** 回复消息的排版格式：markdown 富文本渲染（代码块/表格/列表）或纯文本。 */
    replyFormat: z.union(['markdown', 'text']).default('markdown'),
    questionTimeoutMs: z.number().min(1000).default(600_000),
    persistSessions: z.boolean().default(true),
    segmentChars: z.number().min(1000).max(30000).default(8000),
    eagerPlaceholder: z.boolean().default(true),
    streamPlaceholder: z.string().default('收到，正在处理…'),
    systemPrompt: z.string().default('你是部署在飞书上的智能助手。请用简洁、友好的中文回答用户的问题；'
        + '涉及代码时直接给出可运行的代码块。'),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    maxHistory: z.number().min(0).default(20),
    agentId: z.string(),
    replyToSource: z.boolean().default(false),
    agentPreset: z.string(),
    workspace: z.string(),
    commands: z.boolean().default(true),
    resetCommands: z.array(z.string()).default(['/new', '/reset']),
    attachHistory: z.number().min(0).default(5),
    pushChatId: z.string(),
    tools: z.boolean().default(true),
});
/** 把 `env:VAR` 形式的配置值解析为环境变量值。 */
export function resolveSecret(raw) {
    if (raw.startsWith('env:')) {
        const name = raw.slice(4);
        const value = process.env[name];
        if (value === undefined) {
            throw new Error(`feishu-bot: 环境变量 ${name} 未设置（配置项使用了 env: 引用）`);
        }
        return value;
    }
    return raw;
}
export function apply(ctx, config) {
    const headbotStatus = new HeadbotFeishuStatus(ctx);
    let restoreInFlight;
    let retryAt = 0;
    let retryDelay = 1000;
    const ensureConfiguredAgent = async () => {
        if (!config.agentId) {
            headbotStatus.setAgentStatus('offline');
            return undefined;
        }
        const agents = ctx.get('agents');
        if (!agents) {
            headbotStatus.setAgentStatus('failed');
            return undefined;
        }
        const sessionId = SessionId(config.agentId);
        const live = agents.get(sessionId);
        if (live) {
            headbotStatus.setAgentStatus('online');
            retryAt = 0;
            retryDelay = 1000;
            return live;
        }
        if (restoreInFlight)
            return restoreInFlight;
        if (Date.now() < retryAt) {
            headbotStatus.setAgentStatus('failed');
            return undefined;
        }
        headbotStatus.setAgentStatus('restoring');
        restoreInFlight = (async () => {
            try {
                await agents.resume({ resumeSessionId: sessionId });
                const restored = agents.get(sessionId);
                if (!restored)
                    throw new Error('the selected DS Bot session was not registered after resume');
                headbotStatus.setAgentStatus('online');
                retryAt = 0;
                retryDelay = 1000;
                return restored;
            }
            catch (error) {
                headbotStatus.setAgentStatus('failed');
                retryAt = Date.now() + retryDelay;
                retryDelay = Math.min(60_000, retryDelay * 2);
                ctx.logger.warn('headbot: the selected DS Bot session could not be restored; will retry', error);
                return undefined;
            }
            finally {
                restoreInFlight = undefined;
            }
        })();
        return restoreInFlight;
    };
    const sessionMonitor = config.agentId
        ? setInterval(() => { void ensureConfiguredAgent(); }, 3000)
        : undefined;
    sessionMonitor?.unref?.();
    if (sessionMonitor)
        ctx.effect(() => () => clearInterval(sessionMonitor), 'Headbot DS Bot session restoration');
    if (config.agentId)
        void ensureConfiguredAgent();
    else
        headbotStatus.setAgentStatus('offline');
    const service = new FeishuService(ctx, {
        appId: resolveSecret(config.appId),
        appSecret: resolveSecret(config.appSecret),
        domain: config.domain,
        loggerLevel: config.loggerLevel,
        policy: {
            dmMode: config.dmMode,
            dmAllowlist: config.dmAllowlist,
            groupAllowlist: config.groupAllowlist,
            requireMention: config.requireMention,
            respondToMentionAll: config.respondToMentionAll,
        },
        // 流式卡片分段：超过 segmentChars 自动 rollover 成多张卡片（按代码围栏/标题切）。
        // streamInitialText：占位卡片文案（v0.6.7 回合开始即上屏，工具期不再静默）。
        outbound: {
            streamMaxElementChars: config.segmentChars ?? 8000,
            streamInitialText: config.streamPlaceholder ?? '收到，正在处理…',
        },
    });
    const updateConnectionStatus = () => {
        process.env.HEADBOT_FEISHU_STATUS = mapFeishuConnectionState(service.getConnectionStatus()?.state);
    };
    updateConnectionStatus();
    const connectionMonitor = setInterval(updateConnectionStatus, 1000);
    connectionMonitor.unref?.();
    ctx.effect(() => () => clearInterval(connectionMonitor), 'Headbot Feishu connection status');
    // 插件卸载时断开长连接。
    ctx.effect(() => {
        return () => {
            void service.disconnect().catch((error) => {
                ctx.logger.warn('feishu: 断开长连接失败', error);
            });
        };
    });
    // 建立长连接（SDK 自动重连；初始失败只记录日志，不阻断插件加载）。
    process.env.HEADBOT_FEISHU_STATUS = 'connecting';
    void service.connect()
        .then(() => {
        updateConnectionStatus();
        const identity = service.getBotIdentity();
        ctx.logger.info(`feishu: 长连接已就绪（机器人：${identity?.name ?? identity?.openId ?? 'unknown'}）`);
    })
        .catch((error) => {
        process.env.HEADBOT_FEISHU_STATUS = 'retrying';
        ctx.logger.error('feishu: 连接长连接失败，请检查 appId/appSecret 与网络（SDK 将自动重试）', error);
    });
    // 入站互动：飞书消息 → 机器人回复。
    // 共享状态：会话绑定 / 流式转发 / 飞书侧确认问答 / 持久化映射。
    const questions = new PendingQuestionState(ctx, service, config.questionTimeoutMs ?? 600_000);
    const store = config.persistSessions === false ? undefined : ChatSessionStore.load();
    // /model 覆盖独立于会话映射持久化（不受 persistSessions 开关影响）。
    const shared = {
        stateByChat: new Map(),
        relays: new Map(),
        chatByAgent: new Map(),
        questions,
        store,
        modelStore: ModelOverrideStore.load(),
        ensureConfiguredAgent,
    };
    attachInbound(ctx, service, config, shared);
    // 出站互动：模型可调用 feishu_* 工具。
    if (config.tools !== false) {
        registerFeishuTools(ctx, service, config.pushChatId, questions);
    }
}
