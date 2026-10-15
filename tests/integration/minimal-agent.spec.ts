import { describe, expect, it } from 'vitest'
import { askRobot } from '../../examples/minimal-agent/index.ts'

describe('minimal AI robot scaffold', () => {
  it('plays with the add toy, then answers from the toy result', async () => {
    const { answer, toolUses } = await askRobot('2 加 3 等于几？', { brain: 'mock' })
    expect(toolUses).toEqual([{ name: 'add', args: { a: 2, b: 3 }, result: { sum: 5 } }])
    expect(answer).toBe('2 加 3 等于 5。')
  })

  it('starts a fresh robot on every question', async () => {
    const first = await askRobot('2 加 3 等于几？', { brain: 'mock' })
    const second = await askRobot('2 加 3 等于几？', { brain: 'mock' })
    expect(second.toolUses).toHaveLength(1)
    expect(second.answer).toBe(first.answer)
  })
})
