import { Context } from '@teoclub/cordis'
import InvariantRegistry from '@teoclub/harness-invariants'
import * as AgentLoopInvariant from '@teoclub/harness-agent-loop/invariant'

const ctx = new Context()
await ctx.plugin(InvariantRegistry)
await ctx.plugin(AgentLoopInvariant)

const anyCtx = ctx as any
console.log('events keys:', Object.keys(anyCtx.events ?? {}))
const listeners = anyCtx.events?.['llm/stream']
console.log('llm/stream listeners:', listeners?.size ?? listeners?.length ?? 'none')

// plain event probe
let fired = 0
ctx.on('llm/stream', () => { fired++ })
ctx.waterfall('llm/stream', {} as never, (() => (async function* () {})()) as never)
console.log('probe fired:', fired)
