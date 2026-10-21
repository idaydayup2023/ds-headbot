# ds-headbot-feishu

Headbot's first-party Feishu bridge plugin for managed DSH instances. It is packaged inside the `ds-headbot` project and installed into each DSH Web profile that enables Feishu.

## Behavior

- Reuses the selected DS Bot's native DSH session (`agentId`), preserving its identity, model, tools, memory, and team configuration.
- Shows each inbound message in Chat as readable text prefixed by `飞书消息 · 发送人`.
- Sends the `DS-HEADBOT-FEISHU/1` routing envelope as a separate producer-owned DSH context message. DSH keeps that context in model history but filters it from ordinary Chat rows, so the model can use the source chat, message ID, sender ID/name, and reply route without exposing raw JSON in the transcript.
- Associates the hidden route context with the adjacent readable Feishu user message; the body is not duplicated inside the JSON envelope.
- Serializes all Feishu chats that target the same Bot session, so concurrent group messages cannot replace the active reply route.
- Sends the Bot's normal response as a Feishu reply to the source message. The envelope also gives `feishu_reply_message`, `feishu_send_message`, and card tools the exact chat/message IDs when a separate tool-driven response is needed.
- Does not fall back to an unthreaded message when Feishu rejects the source reply; this avoids sending an answer where it could be mistaken for a response to another person.
- Preserves the upstream Feishu WebSocket connection, commands, model selection, question cards, outbound tools, and session persistence.

Feishu messages appear in the same DS Bot session as local messages. The transcript shows the original text with a short Feishu/sender label, while the routing envelope remains a hidden context message. This is intentional: the existing DS Bot session is the single communication model for both channels. Bot replies retain the sender/message association through Feishu's reply-to relationship.

## Headbot configuration

Headbot provisions this plugin and supplies the selected Bot's `agentId`, `appId`, and `appSecret` through the managed DSH profile patch. Credentials are read from environment references; they are not stored in project files. The plugin package is installed from the `plugins/ds-headbot-feishu` directory embedded in the installed `ds-headbot` package. Headbot resumes the selected Bot session at startup and refreshes the binding if DS Bot changes its session ID.

For standalone development, the relevant settings are:

```yaml
- id: ds-headbot-feishu
  name: ds-headbot-feishu
  config:
    appId: 'env:FEISHU_APP_ID'
    appSecret: 'env:FEISHU_APP_SECRET'
    mode: agent
    agentId: selected-ds-bot-session-id
    replyToSource: true
```

The visible user message is readable text such as `【飞书消息 · Alice】\nPlease follow up`. The adjacent model-only context carries routing information like this:

```json
{
  "schema": "ds-headbot-feishu/1",
  "source": "feishu",
  "chat": { "id": "oc_...", "type": "group" },
  "message": { "id": "om_..." },
  "sender": { "id": "ou_...", "name": "Alice" },
  "response_route": {
    "chat_id": "oc_...",
    "reply_to_message_id": "om_..."
  },
  "body_location": "The adjacent ordinary user message marked as a Feishu message is the original message body."
}
```

## Upstream and license

The Feishu transport and most bridge functionality are derived from [`@zyfgood/dsh-feishu-bot`](https://github.com/zyfgood/dsh-feishu-bot), version 0.9.0 at commit `26fca2c08e2c26cff020daee5e6bbfdf42a0c177`. Upstream code is MIT licensed; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE.md).
