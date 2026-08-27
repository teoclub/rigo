import { Context } from '@teoclub/cordis'
import SessionStore, { SessionId } from '@teoclub/harness-session'
import InvariantRegistry from '@teoclub/harness-invariants'
import * as AgentLoopInvariant from '@teoclub/harness-agent-loop/invariant'
import { markAgentLoopRequest, type GenerateOptions } from '@teoclub/harness-llm'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(InvariantRegistry)
await ctx.plugin(AgentLoopInvariant)

const session = ctx.sessions.create(SessionId('repro'))
session.append('turn/start', { turn: 1 })
const options: any = { model: 'm', messages: Object.freeze([]), sessionId: session.id }
markAgentLoopRequest(options as GenerateOptions)
Object.freeze(options)

try {
  ctx.waterfall('llm/stream', options as never, (() => (async function* () {})()) as never)
  console.log('NO THROW')
} catch (error) {
  console.log('THREW:', (error as Error).message)
}
