// Check whether the same module identity is shared between direct import and
// an import reached through a harness package.
import * as direct from '@teoclub/harness-llm'
const inv = await import('@teoclub/harness-agent-loop/invariant')
// both should reference the same markAgentLoopRequest function object
const anyDirect = direct as any
console.log('same fn:', anyDirect.markAgentLoopRequest === undefined)
