import { Context } from '@teoclub/cordis'
import InvariantRegistry from '@teoclub/harness-invariants'
import * as AgentLoopInvariant from '@teoclub/harness-agent-loop/invariant'

const ctx = new Context()
await ctx.plugin(InvariantRegistry)
await ctx.plugin(AgentLoopInvariant)

const hooks = (ctx as any).events?._hooks
console.log('hook names:', hooks ? [...hooks.keys()] : 'none')
const ls = hooks?.get('llm/stream')
console.log('llm/stream:', ls ? [...ls].map((l: any) => String(l?.prepend) + '/' + String(l?.disposed)).join(',') : 'none', 'count:', ls?.size)
