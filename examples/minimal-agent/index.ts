/**
 * 最小 AI 小机器人（给小朋友看的版本）。
 *
 * 小机器人有三样东西：
 *   🧠 脑子：会想事情的大模型。没有钥匙时用“假脑子”（mock），照着剧本回答。
 *   🧰 玩具箱：工具。这里只有一个“加法玩具”。
 *   📓 小本子：会话，记住说过的话。
 *
 * 大盒子 bootCore() 把这些装在一起。小机器人“想一想、玩玩具、看结果、再想”的
 * 循环，由 agent loop 自己完成，我们不用写。
 */
import { fileURLToPath } from 'node:url'
import { bootCore } from '@teoclub/harness-app-boot'
import { createUserMessage, type LlmAdapter } from '@teoclub/harness-llm'
import { MockAdapter, textResponse, toolCallResponse } from '@teoclub/harness-llm-mock'
import { OpenAICompatibleAdapter } from '@teoclub/harness-llm-openai-compatible'
import { SessionId } from '@teoclub/harness-session'
import type { ToolDefinition } from '@teoclub/harness-tools'

export interface ToyUse {
  name: string
  args: unknown
  result: unknown
}

export interface RobotAnswer {
  answer: string
  toolUses: ToyUse[]
}

export interface AskOptions {
  /** 不写就看有没有 RIGO_LLM_BASE_URL：有就用真脑子，没有就用假脑子。 */
  brain?: 'mock' | 'real'
}

/** 加法玩具：拿两个数，还你它们的和。每玩一次，就记到 uses 里。 */
function addToy(uses: ToyUse[]): ToolDefinition {
  return {
    name: 'add',
    description: '把两个数加起来，返回它们的和',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: async (args: unknown) => {
      const { a, b } = args as { a: number; b: number }
      const result = { sum: a + b }
      uses.push({ name: 'add', args, result })
      return result
    },
  }
}

/** 假脑子：剧本是先玩加法玩具，再说答案。不需要任何钥匙。 */
function mockBrain(): { provider: string; model: string; adapter: LlmAdapter } {
  return {
    provider: 'mock',
    model: 'mock',
    adapter: new MockAdapter([
      toolCallResponse('call-1', 'add', { a: 2, b: 3 }, '我用加法玩具算一算。'),
      textResponse('2 加 3 等于 5。'),
    ]),
  }
}

/** 真脑子：任何 OpenAI 兼容的接口（比如 DeepSeek）。钥匙从环境变量里读。 */
function realBrain(): { provider: string; model: string; adapter: LlmAdapter } {
  const baseUrl = process.env.RIGO_LLM_BASE_URL
  if (!baseUrl) throw new Error('要用真脑子，请先设置 RIGO_LLM_BASE_URL')
  return {
    provider: process.env.RIGO_LLM_PROVIDER ?? 'openai',
    model: process.env.RIGO_LLM_MODEL ?? 'deepseek-chat',
    adapter: new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: { kind: 'env', name: process.env.RIGO_LLM_API_KEY_ENV ?? 'RIGO_LLM_API_KEY' },
    }),
  }
}

export async function askRobot(question: string, options: AskOptions = {}): Promise<RobotAnswer> {
  const useReal = options.brain === 'real' || (options.brain === undefined && process.env.RIGO_LLM_BASE_URL !== undefined)
  const brain = useReal ? realBrain() : mockBrain()
  const toolUses: ToyUse[] = []

  // 1. 打开大盒子，把脑子装进去
  const handle = await bootCore({ adapters: { [brain.provider]: brain.adapter } })
  try {
    // 2. 放进玩具箱
    handle.ctx.tools.register(addToy(toolUses))
    // 3. 给机器人一个小本子（会话），然后让它开始想
    const agent = await handle.ctx.agentLoop.create(SessionId('minimal-robot'), {
      provider: brain.provider,
      model: brain.model,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // 4. 读出最后一句回答
    const last = [...agent.session.snapshotEvents()].reverse().find((event) => event.type === 'assistant/message')
    const answer = last?.type === 'assistant/message'
      ? last.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
      : ''
    return { answer, toolUses }
  } finally {
    // 5. 合上大盒子
    await handle.dispose()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const question = process.argv.slice(2).join(' ') || '2 加 3 等于几？'
  const { answer, toolUses } = await askRobot(question)
  console.log(`🙋 小朋友问：${question}`)
  for (const use of toolUses) {
    console.log(`🧰 机器人玩了加法玩具：${JSON.stringify(use.args)} → ${JSON.stringify(use.result)}`)
  }
  console.log(`🗣️ 机器人说：${answer}`)
}
