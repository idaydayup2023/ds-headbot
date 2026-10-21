import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachInbound } from '../lib/inbound.js'
import { registerFeishuTools } from '../lib/tools.js'

test('tagged Feishu input reaches the selected agent and its normal reply quotes the source message', async () => {
  const listeners = new Map()
  let channelHandlers
  const receivedMessages = []
  const injectedContexts = []
  const dispatchOrder = []
  let resolveSent
  const sentPromise = new Promise((resolve) => { resolveSent = resolve })
  const sent = []

  const agent = {
    id: 'configured-bot-session',
    status: 'idle',
    session: { header: { cwd: process.cwd() }, snapshotEvents: () => [] },
    inject(message) {
      injectedContexts.push(message)
      dispatchOrder.push('context')
    },
    followup(message) {
      receivedMessages.push(message)
      dispatchOrder.push('message')
      const contextText = injectedContexts.at(-1)?.content.find((block) => block.type === 'text')?.text
      const envelopeJson = contextText.slice('【DS-HEADBOT-FEISHU/1】\n'.length, -'\n【/DS-HEADBOT-FEISHU】'.length)
      const envelope = JSON.parse(envelopeJson)
      listeners.get('agent/assistant-stream')?.({
        agent,
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: `回复给${envelope.sender.name}` } },
      })
    },
    async whenIdle() {},
  }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => id === agent.id ? agent : undefined }
      return undefined
    },
    on(name, callback) { listeners.set(name, callback); return this },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const service = {
    channel: { on(handlers) { channelHandlers = handlers } },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options })
      if (sent.length === 2) resolveSent()
      return { messageId: 'outbound-message' }
    },
  }
  const shared = {
    stateByChat: new Map(),
    relays: new Map(),
    chatByAgent: new Map(),
    questions: { consumeTextAnswer: () => false, hasPending: () => false },
  }

  attachInbound(ctx, service, {
    mode: 'agent',
    agentId: agent.id,
    replyToSource: true,
    replyFormat: 'text',
    eagerPlaceholder: false,
    commands: false,
  }, shared)

  channelHandlers.message({
    chatId: 'oc_project_team', chatType: 'group', messageId: 'om_alice',
    replyToMessageId: 'om_parent_message', senderId: 'ou_alice', senderName: 'Alice',
    content: '@Headbot 请跟进这个问题',
  })
  channelHandlers.message({
    chatId: 'oc_project_team', chatType: 'group', messageId: 'om_bob',
    senderId: 'ou_bob', senderName: 'Bob', content: '@Headbot 我也补充一个问题',
  })

  let timeout
  try {
    await Promise.race([
      sentPromise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('reply was not sent')), 3000) }),
    ])
  } finally {
    clearTimeout(timeout)
  }

  assert.equal(receivedMessages.length, 2, 'both group members should reach the selected agent')
  assert.equal(injectedContexts.length, 2, 'each inbound message should add hidden routing context')
  assert.deepEqual(dispatchOrder, ['context', 'message', 'context', 'message'])
  const body = receivedMessages[0].content.find((block) => block.type === 'text')?.text
  assert.equal(body, '【飞书消息 · Alice】\n@Headbot 请跟进这个问题')
  assert.equal(receivedMessages[0].source.kind, 'user', 'the readable Feishu body remains the ordinary visible user message')
  const context = injectedContexts[0]
  assert.equal(context.source.kind, 'ds-headbot-feishu')
  assert.equal(context.source.form, 'notice')
  const contextText = context.content.find((block) => block.type === 'text')?.text
  assert.ok(contextText?.startsWith('【DS-HEADBOT-FEISHU/1】\n'))
  assert.ok(contextText?.endsWith('\n【/DS-HEADBOT-FEISHU】'))
  const json = contextText.slice('【DS-HEADBOT-FEISHU/1】\n'.length, -'\n【/DS-HEADBOT-FEISHU】'.length)
  const envelope = JSON.parse(json)
  assert.equal(envelope.schema, 'ds-headbot-feishu/1')
  assert.equal(envelope.source, 'feishu')
  assert.deepEqual(envelope.chat, { id: 'oc_project_team', type: 'group' })
  assert.deepEqual(envelope.message, { id: 'om_alice', in_reply_to: 'om_parent_message' })
  assert.deepEqual(envelope.sender, { id: 'ou_alice', name: 'Alice' })
  assert.match(envelope.body_location, /adjacent ordinary user message/)
  assert.match(envelope.response_route.guidance, /automatically sent as a reply to this message/)
  const secondBody = receivedMessages[1].content.find((block) => block.type === 'text')?.text
  assert.equal(secondBody, '【飞书消息 · Bob】\n@Headbot 我也补充一个问题')
  const secondContextText = injectedContexts[1].content.find((block) => block.type === 'text')?.text
  const secondJson = secondContextText.slice('【DS-HEADBOT-FEISHU/1】\n'.length, -'\n【/DS-HEADBOT-FEISHU】'.length)
  const secondEnvelope = JSON.parse(secondJson)
  assert.equal(secondEnvelope.sender.name, 'Bob')
  assert.equal(secondEnvelope.body_location.includes('adjacent ordinary user message'), true)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].chatId, 'oc_project_team')
  assert.equal(sent[0].options.replyTo, 'om_alice')
  assert.equal(sent[0].content.text, '回复给Alice')
  assert.equal(sent[1].options.replyTo, 'om_bob')
  assert.equal(sent[1].content.text, '回复给Bob')
})

test('explicit Feishu sends preserve the reply_to message association', async () => {
  const definitions = []
  const calls = []
  const ctx = {
    get(name) { return name === 'tools' ? { register: (definition) => definitions.push(definition) } : undefined },
    effect(callback) { return callback() },
    logger: { warn() {}, error() {} },
  }
  const service = {
    async send(target, content, options) {
      calls.push({ target, content, options })
      return { messageId: 'tool-response' }
    },
  }

  registerFeishuTools(ctx, service)
  const sendTool = definitions.find((definition) => definition.name === 'feishu_send_message')
  assert.ok(sendTool, 'the Feishu send tool should be registered')
  const result = await sendTool.execute({
    target: 'oc_project_team',
    content: '按原提问回复',
    reply_to: 'om_source_message',
  })

  assert.equal(result.sent, true)
  assert.equal(calls[0].target, 'oc_project_team')
  assert.equal(calls[0].options.replyTo, 'om_source_message')
})
