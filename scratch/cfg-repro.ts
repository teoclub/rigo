import { Context } from '@teoclub/cordis'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@teoclub/harness-session'
import MemoryPersistence from '../tests/support/memory-persistence.ts'
import AgentLoop from '@teoclub/harness-agent-loop'

const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-repro-'))
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(MemoryPersistence, { root })
const failure = new Error('persistence index failed')
const sp = ctx.get('sessionPersistence') as any
const original = sp.list.bind(sp)
sp.list = async () => { console.log('[REPRO] list called (mock)'); throw failure }
const warns: string[] = []
const loggerWarn = (ctx as any).logger?.warn
;(ctx as any).logger = (ctx as any).logger ?? {}
;(ctx as any).logger.warn = (line: string) => { warns.push(line) }

console.log('[REPRO] loading AgentLoop')
await ctx.plugin(AgentLoop, {
  agents: [{ id: 'main', sessionId: SessionId('config-exact-failure'), model: 'mock' }],
})
console.log('[REPRO] plugin loaded; waiting for warn...')
for (let i = 0; i < 40 && warns.length === 0; i++) {
  await new Promise(r => setTimeout(r, 50))
}
console.log('[REPRO] warns:', JSON.stringify(warns))
await ctx.fiber.dispose()
