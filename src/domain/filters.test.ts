import { describe, expect, it } from 'vitest'
import {
  bucketNotes,
  compareNotes,
  endOfToday,
  filterNotes,
  isOverdue,
  overdueLabel,
  pendingCount,
  presets,
  sortNotes,
  startOfLocalDay,
} from './filters'
import { PRIORITY } from './types'
import { localNoon, makeNotes } from '@/test/factories'

describe('筛选与排序', () => {
  it('默认排除已删除和已归档', () => {
    const notes = makeNotes([
      { title: '正常' },
      { title: '已删', deletedAt: 1 },
      { title: '已归档', status: 'archived' },
    ])
    expect(filterNotes(notes, {}).map((n) => n.title)).toEqual(['正常'])
    expect(filterNotes(notes, { includeDeleted: true })).toHaveLength(2)
    expect(filterNotes(notes, { includeArchived: true })).toHaveLength(2)
  })

  it('按类型筛选支持单值和数组', () => {
    const notes = makeNotes([
      { title: 'a', noteType: 'todo' },
      { title: 'b', noteType: 'memo' },
      { title: 'c', noteType: 'event' },
    ])
    expect(filterNotes(notes, { noteType: 'memo' }).map((n) => n.title)).toEqual(['b'])
    expect(filterNotes(notes, { noteType: ['memo', 'event'] }).map((n) => n.title)).toEqual(['b', 'c'])
  })

  it('空状态集合等于不筛选，而不是筛出空结果', () => {
    const notes = makeNotes([{ title: 'a' }])
    expect(filterNotes(notes, { priority: [] })).toHaveLength(1)
  })

  it('截止时间区间是左闭右开', () => {
    const from = 1000
    const to = 2000
    const notes = makeNotes([
      { title: '正好在下界', dueAt: from },
      { title: '中间', dueAt: 1500 },
      { title: '正好在上界', dueAt: to },
      { title: '无时间', dueAt: null },
    ])
    expect(filterNotes(notes, { dueFrom: from, dueTo: to }).map((n) => n.title)).toEqual(['正好在下界', '中间'])
  })
})

describe('排序', () => {
  it('空值永远排在最后，不管升降序', () => {
    const notes = makeNotes([
      { title: '有截止', dueAt: 5000 },
      { title: '无截止', dueAt: null },
    ])
    expect(sortNotes(notes, 'dueAt', 'asc').map((n) => n.title)).toEqual(['有截止', '无截止'])
    expect(sortNotes(notes, 'dueAt', 'desc').map((n) => n.title)).toEqual(['有截止', '无截止'])
  })

  it('等级降序：高在前', () => {
    const notes = makeNotes([
      { title: '低', priority: PRIORITY.LOW },
      { title: '高', priority: PRIORITY.HIGH },
      { title: '中', priority: PRIORITY.MEDIUM },
    ])
    expect(sortNotes(notes, 'priority', 'desc').map((n) => n.title)).toEqual(['高', '中', '低'])
  })

  it('同键值时按 id 兜底，保证排序稳定', () => {
    const notes = makeNotes([
      { title: 'b', priority: PRIORITY.HIGH, id: 'B' },
      { title: 'a', priority: PRIORITY.HIGH, id: 'A' },
    ])
    const once = sortNotes(notes, 'priority', 'desc').map((n) => n.id)
    const twice = sortNotes([...notes].reverse(), 'priority', 'desc').map((n) => n.id)
    expect(once).toEqual(twice)
  })

  it('标题排序用中文语境', () => {
    const notes = makeNotes([{ title: '北京' }, { title: '上海' }, { title: '广州' }])
    expect(sortNotes(notes, 'title').map((n) => n.title)).toEqual(['北京', '广州', '上海'])
  })

  it('compareNotes 对完全相同的记录返回 0', () => {
    const a = makeNotes([{}])[0]!
    const b = makeNotes([{}])[0]!
    expect(compareNotes(a, b, 'dueAt')).toBe(0)
  })
})

describe('悬浮窗分组', () => {
  const now = localNoon(2026, 6, 15)
  const todayEnd = endOfToday(now)
  const tomorrow = localNoon(2026, 6, 16)

  it('已完成的进 done，不管有没有截止时间', () => {
    const notes = makeNotes([
      { title: '完成无期限', status: 'done', dueAt: null },
      { title: '完成有期限', status: 'done', dueAt: now - 1000 },
      { title: '归档', status: 'archived', dueAt: null },
    ])
    const b = bucketNotes(notes, now)
    expect(b.done).toHaveLength(3)
    // 用集合比较，别依赖 Array.sort 对中文的排序
    expect(new Set(b.done.map((n) => n.title))).toEqual(new Set(['完成无期限', '完成有期限', '归档']))
  })

  it('没有截止时间的未完成项进 someday', () => {
    const b = bucketNotes(makeNotes([{ title: '有空再想' }]), now)
    expect(b.someday.map((n) => n.title)).toEqual(['有空再想'])
  })

  it('过了截止时间进 overdue', () => {
    const b = bucketNotes(makeNotes([{ title: '昨天该做的', dueAt: now - 86_400_000 }]), now)
    expect(b.overdue.map((n) => n.title)).toEqual(['昨天该做的'])
  })

  it('今天到期进 today；今天 23:59:59 也算今天', () => {
    const b = bucketNotes(
      makeNotes([
        { title: '今天上午', dueAt: localNoon(2026, 6, 15) },
        { title: '今晚最后一秒', dueAt: todayEnd },
      ]),
      now,
    )
    expect(new Set(b.today.map((n) => n.title))).toEqual(new Set(['今晚最后一秒', '今天上午']))
    // 今天组内仍按"等级优先、截止时间次序"
    expect(b.today.map((n) => n.title)).toEqual(['今天上午', '今晚最后一秒'])
  })

  it('明天到期进 upcoming', () => {
    const b = bucketNotes(makeNotes([{ title: '明天', dueAt: tomorrow }]), now)
    expect(b.upcoming.map((n) => n.title)).toEqual(['明天'])
  })

  it('已删除的项不进任何分组', () => {
    const b = bucketNotes(makeNotes([{ title: '删了', deletedAt: 1, dueAt: now }]), now)
    expect(Object.values(b).flat()).toHaveLength(0)
  })

  it('逾期组内先按等级再按时间', () => {
    const notes = makeNotes([
      { title: '逾期但不重要', priority: PRIORITY.LOW, dueAt: now - 1000 },
      { title: '逾期且重要', priority: PRIORITY.HIGH, dueAt: now - 5000 },
    ])
    expect(bucketNotes(notes, now).overdue.map((n) => n.title)).toEqual(['逾期且重要', '逾期但不重要'])
  })

  it('pendingCount 只数未完成的', () => {
    const notes = makeNotes([
      { title: 'a', dueAt: now - 1000 },
      { title: 'b', dueAt: now + 1000 },
      { title: 'c' },
      { title: 'd', status: 'done', dueAt: now },
    ])
    expect(pendingCount(bucketNotes(notes, now))).toBe(3)
  })

  it('done 组最多保留 20 条最近的', () => {
    const notes = makeNotes(
      Array.from({ length: 30 }, (_, i) => ({
        title: `done-${i}`,
        status: 'done' as const,
        updatedAt: 1_000 + i,
      })),
    )
    const b = bucketNotes(notes, now)
    expect(b.done).toHaveLength(20)
    // 保留的是最近更新的那批
    expect(b.done[0]?.title).toBe('done-29')
  })
})

describe('逾期判断与文案', () => {
  const now = localNoon(2026, 6, 15)

  it('已完成的待办不算逾期', () => {
    expect(isOverdue(makeNotes([{ dueAt: now - 1000, status: 'done' }])[0]!, now)).toBe(false)
  })

  it('无截止时间不算逾期', () => {
    expect(isOverdue(makeNotes([{ dueAt: null }])[0]!, now)).toBe(false)
  })

  it('逾期文案按分钟/小时/天分级', () => {
    const cases: Array<[number, string]> = [
      [60_000, '逾期 1 分钟'],
      [30 * 60_000, '逾期 30 分钟'],
      [2 * 3_600_000, '逾期 2 小时'],
      [3 * 86_400_000, '逾期 3 天'],
    ]
    for (const [diff, expected] of cases) {
      const note = makeNotes([{ dueAt: now - diff }])[0]!
      expect(overdueLabel(note, now)).toBe(expected)
    }
  })

  it('没逾期时返回空串', () => {
    expect(overdueLabel(makeNotes([{ dueAt: now + 1000 }])[0]!, now)).toBe('')
  })
})

describe('预设筛选', () => {
  it('today 覆盖本地当天', () => {
    const now = localNoon(2026, 6, 15)
    const f = presets.today(now)
    expect(f.dueFrom).toBe(startOfLocalDay(now))
    expect(f.dueTo).toBeGreaterThan(f.dueFrom!)

    const notes = makeNotes([
      { title: '今天', dueAt: now },
      { title: '昨天', dueAt: now - 86_400_000 },
      { title: '明天', dueAt: now + 86_400_000 },
    ])
    expect(filterNotes(notes, f).map((n) => n.title)).toEqual(['今天'])
  })

  it('每次调用都重新取当前时间，不受模块加载时刻影响', async () => {
    const early = presets.today(1_000_000_000_000)
    await new Promise((r) => setTimeout(r, 1100))
    const late = presets.today(Date.now())
    expect(late.dueFrom).toBeGreaterThan(early.dueFrom!)
  })
})
