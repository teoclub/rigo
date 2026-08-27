import { markAgentLoopRequest, isAgentLoopRequest } from '@teoclub/harness-llm'
const opts: any = {}
markAgentLoopRequest(opts)
console.log('marker visible (self-import):', isAgentLoopRequest(opts))
const { isAgentLoopRequest: check2 } = await import('@teoclub/harness-llm')
console.log('marker visible (dynamic same specifier):', check2(opts))
