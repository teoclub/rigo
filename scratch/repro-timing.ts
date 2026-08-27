import { Context } from '@teoclub/cordis'
import InvariantRegistry from '@teoclub/harness-invariants'
import * as AgentLoopInvariant from '@teoclub/harness-agent-loop/invariant'

const ctx = new Context()
await ctx.plugin(InvariantRegistry)
console.log('before apply')
const fiber = ctx.plugin(AgentLoopInvariant)
console.log('after sync call, is thenable:', typeof (fiber as any)?.then)
await fiber
console.log('after await')
let fired = 0
ctx.on('llm/stream', () => { fired++ }, { prepend: true })
ctx.waterfall('llm/stream', {} as never, (() => (async function* () {})()) as never)
console.log('probe fired:', fired)
await new Promise(r => setTimeout(r, 50))
ctx.waterfall('llm/stream', {} as never, (() => (async function* () {})()) as never)
console.log('probe fired after 50ms:', fired)
