import { Context } from '@teoclub/cordis'
import InvariantRegistry from '@teoclub/harness-invariants'
import * as AgentLoopInvariant from '@teoclub/harness-agent-loop/invariant'

const ctx = new Context()
await ctx.plugin(InvariantRegistry)
await ctx.plugin(AgentLoopInvariant)

const hooks = (ctx as any).events?._hooks
console.log('hooks ctor:', hooks?.constructor?.name)
for (const key of Object.keys(hooks ?? {})) {
  const v = hooks[key]
  console.log(' key', key, 'type', typeof v, v?.constructor?.name, 'len', v?.size ?? v?.length)
}
