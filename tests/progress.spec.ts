import { describe, expect, it } from 'vitest'
import { MAX_PROGRESS_STEPS, normalizeProgressSteps } from '../src/progress.ts'

describe('todo_write 到 TaskRun 步骤进度的桥接', () => {
  it('规范化合法 todo 列表', () => {
    expect(normalizeProgressSteps([
      { content: '  创建文件 ', status: 'completed' },
      { content: '实现碰撞', status: 'in_progress' },
      { content: '浏览器验收', status: 'pending' },
    ])).toEqual([
      { content: '创建文件', status: 'completed' },
      { content: '实现碰撞', status: 'in_progress' },
      { content: '浏览器验收', status: 'pending' },
    ])
  })

  it('忽略脏数据、非法状态和空内容', () => {
    expect(normalizeProgressSteps([
      null,
      {},
      { content: ' ', status: 'completed' },
      { content: 'x', status: 'unknown' },
      { content: 'y', status: 'pending' },
    ])).toEqual([{ content: 'y', status: 'pending' }])
  })

  it('最多保留 50 条并裁剪过长内容', () => {
    const steps = Array.from({ length: 60 }, (_, index) => ({
      content: `步骤 ${index}`, status: 'pending' as const,
    }))
    const normalized = normalizeProgressSteps(steps)
    expect(normalized).toHaveLength(MAX_PROGRESS_STEPS)
    const long = normalizeProgressSteps([{ content: 'a'.repeat(400), status: 'pending' }])
    expect(long[0]!.content).toHaveLength(300)
  })
})
