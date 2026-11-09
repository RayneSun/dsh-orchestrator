import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulePane } from '../src/client/schedule-pane.tsx'
import { ScheduleList } from '../src/client/schedule-list.tsx'
import type { ScheduleSnapshot } from '../src/types.ts'

// 无 DOM 的组件交互桩：保留 state 与 memo 依赖，直接触发真实 JSX 回调后重新渲染。
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0 }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState(initial: any) {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
      return [hooks.slots[index], (next: any) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next
      }]
    },
    useMemo(factory: () => unknown, deps: unknown[]) {
      const index = hooks.cursor++
      const previous = hooks.slots[index]
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        hooks.slots[index] = { deps, value: factory() }
      }
      return hooks.slots[index].value
    },
  }
})

function nodes(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => React.isValidElement<any>(child)
    ? [child, ...nodes(child.props.children)] : [])
}

function text(node: React.ReactNode): string {
  return React.Children.toArray(node).map(child => React.isValidElement<any>(child)
    ? text(child.props.children) : String(child)).join('')
}

function schedule(patch: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    id: 'sch_1', parentSessionId: 'parent', conversationId: 'conv', conversationTitle: '会话',
    title: '日程', allDay: true, startAt: '2026-01-01', endAt: '2026-12-31',
    priority: 'P3', status: 'pending', links: [], attachments: [], contacts: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
  }
}

const callbacks = { onToggle() {}, onOpenAttachment() {}, showToast() {} }
function pane(schedules: ScheduleSnapshot[]) {
  hooks.cursor = 0
  return nodes(SchedulePane({ schedules, ...callbacks }))
}
function timeLabel(item: ScheduleSnapshot): string {
  hooks.cursor = 0
  const row = nodes(ScheduleList({ schedules: [item], ...callbacks }))
  return text(row.find(node => node.props.className?.startsWith('dsho-todoTime '))!.props.children)
}

beforeEach(() => {
  hooks.slots = []
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 9, 12))
})
afterEach(() => vi.useRealTimers())

describe('日历日期与长日程', () => {
  it('全年日程在第 62 天之后仍覆盖整月，并随切月重新索引', () => {
    const schedules = [schedule()]
    let tree = pane(schedules)
    expect(tree.filter(node => node.props.className === 'dsho-dayDot')).toHaveLength(30)
    expect(tree.find(node => node.type === ScheduleList)!.props.schedules).toEqual(schedules)

    tree.find(node => node.props['aria-label'] === '下个月')!.props.onClick()
    tree = pane(schedules)
    expect(tree.filter(node => node.props.className === 'dsho-dayDot')).toHaveLength(31)
    expect(tree.find(node => node.type === ScheduleList)!.props.schedules).toEqual(schedules)
  })

  it('跨月日程包含尾日，之后不再显示；作废或无开始时间的日程不进日历', () => {
    const schedules = [
      schedule({ endAt: '2026-11-09' }),
      schedule({ id: 'cancelled', status: 'cancelled' }),
      schedule({ id: 'no-start', startAt: undefined }),
    ]
    let tree = pane(schedules)
    expect(tree.filter(node => node.props.className === 'dsho-dayDot')).toHaveLength(9)
    expect(tree.find(node => node.type === ScheduleList)!.props.schedules).toEqual([schedules[0]])
    tree.find(node => node.props.className?.split(' ').includes('dsho-day') && node.props.children[0] === 10)!.props.onClick()
    tree = pane(schedules)
    expect(tree.some(node => node.type === ScheduleList)).toBe(false)
  })

  it.each([
    [2026, 0, 31, '2026-02-01', '2026 年 2 月', '2 月 1 日 周日'],
    [2026, 11, 31, '2027-01-01', '2027 年 1 月', '1 月 1 日 周五'],
  ])('切月后标题、选中日期与日列表一致（%s/%s/%s）', (year, month, day, next, heading, selected) => {
    vi.setSystemTime(new Date(year, month, day, 12))
    const schedules = [schedule({ startAt: next, endAt: next })]
    let tree = pane(schedules)
    tree.find(node => node.props['aria-label'] === '下个月')!.props.onClick()
    tree = pane(schedules)
    expect(text(tree.find(node => node.props.className === 'dsho-calTitle')!.props.children)).toBe(heading)
    expect(text(tree.find(node => node.props.className === 'dsho-dayTitle')!.props.children)).toBe(`${selected}· 1 条`)
    expect(tree.find(node => node.type === ScheduleList)!.props.schedules).toEqual(schedules)
  })
})

describe('日程时间胶囊', () => {
  it('普通日程保留午夜与 23:59，全天日程仍只显示日期', () => {
    expect(timeLabel(schedule({ allDay: false, startAt: '2026-11-09T00:00:00', endAt: '2026-11-09T23:59:00' })))
      .toBe('11-09 00:00 → 23:59')
    expect(timeLabel(schedule({ startAt: '2026-11-09', endAt: '2026-11-09' }))).toBe('11-09')
  })

  it.each(['00:00', '23:59'])('只有结束时间且已过期时仍显示 %s', time => {
    expect(timeLabel(schedule({ allDay: false, startAt: undefined, endAt: `2026-11-08T${time}:00` })))
      .toBe(`已过期 11-08 ${time}`)
  })
})
