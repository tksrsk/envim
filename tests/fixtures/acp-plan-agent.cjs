// Run as a custom Envim ACP agent to preview plans and session references.
const { randomUUID } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { agent, methods, ndJsonStream } = require('@agentclientprotocol/sdk');

const checklist = status => [{
  content: 'Verify that the plan appears above the prompt',
  priority: 'high',
  status
}];

agent({ name: 'Envim Plan Demo' })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    authMethods: []
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: randomUUID() }))
  .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
    const { sessionId } = params;
    if (params.prompt.some(block => block.type === 'text' && /session names/i.test(block.text))) {
      const reviewer = `review-${randomUUID()}`;
      const unnamed = `worker-${randomUUID().slice(0, 8)}`;
      const update = (id, payload) => client.notify(methods.client.session.update, { sessionId: id, update: payload });
      await update(sessionId, { sessionUpdate: 'subagent_update', sessionId: reviewer, title: 'Plan reviewer',
        state: { state: 'idle', stopReason: 'end_turn' } });
      await update(sessionId, { sessionUpdate: 'subagent_update', sessionId: unnamed });
      await update(sessionId, { sessionUpdate: 'tool_call', toolCallId: randomUUID(), title: 'Delegate review', status: 'completed',
        content: [{ type: 'session', sessionId: reviewer }, { type: 'session', sessionId: unnamed }] });
      await update(sessionId, { sessionUpdate: 'session_message', messageId: randomUUID(), senderSessionId: reviewer,
        recipientSessionId: unnamed, content: [{ type: 'text', text: 'The checklist is ready to review.' }] });
      return { stopReason: 'end_turn' };
    }
    await client.notify(methods.client.session.update, {
      sessionId, update: { sessionUpdate: 'plan', entries: checklist('completed') }
    });
    await client.notify(methods.client.session.update, {
      sessionId, update: {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'markdown',
          planId: 'display-demo',
          content: '### Plan display demo\n\n- [x] Show the legacy checklist\n- [x] Show an identified Markdown plan'
        }
      }
    });
    await client.notify(methods.client.session.update, {
      sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Both plan formats were sent. Open Session plans above the prompt.' }
      }
    });
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
