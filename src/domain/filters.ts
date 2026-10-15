import type { Note, NoteStatus, NoteType, Priority } from './types'
import { PRIORITY } from './types'

/**
 * 筛选、排序与分组。
 *
 * 全部为纯函数：不碰数据库、不读全局状态，因此可以直接对任意 Note 数组测试。
 * 悬浮窗的"今天 / 稍后 / 逾期"分组逻辑就在这里。
 */

export type SortKey = 'priority' | 'dueAt' | 'createdAt' | 'updatedAt' | 'title' | 'sortOrder'
export type SortDirection = 'asc' | 'desc'

export interface NoteFilter {
  noteType?: NoteType | NoteType[]
  status?: NoteStatus[]
  /** 含此等级 */
  priority?: Priority[]
  listId?: string | null
  tagIds?: string[]
  /** 子串匹配，已在 SQL 层做过一次，这里不再重复过滤 */
  search?: string
  includeDeleted?: boolean
  /** 默认排除归档项 */
  includeArchived?: boolean
  /** 截止时间区间（左闭右开） */
  dueFrom?: number
  dueTo?: number
}

export function matchesFilter(note: Note, filter: NoteFilter): boolean {
  if (!filter.includeDeleted && note.deletedAt !== null) return false
  if (!filter.includeArchived && note.status === 'archived') return false

  if (filter.noteType !== undefined) {
    const types = Array.isArray(filter.noteType) ? filter.noteType : [filter.noteType]
    if (!types.includes(note.noteType)) return false
  }

  if (filter.status !== undefined && filter.status.length > 0) {
    if (note.status === null || !filter.status.includes(note.status)) return false
  }

  if (filter.priority !== undefined && filter.priority.length > 0) {
    if (!filter.priority.includes(note.priority)) return false
  }

  if (filter.listId !== undefined && note.listId !== filter.listId) return false

  if (filter.dueFrom !== undefined || filter.dueTo !== undefined) {
    if (note.dueAt === null) return false
    if (filter.dueFrom !== undefined && note.dueAt < filter.dueFrom) return false
    if (filter.dueTo !== undefined && note.dueAt >= filter.dueTo) return false
  }

  return true
}

const TITLE_COLLATOR = new Intl.Collator('zh-Hans-CN', {
  numeric: true,
  sensitivity: 'base',
})

/** 非空值的比较。空值的沉底处理在 sortNotes 里，这里只管值本身。 */
function compareNullable(a: number | string | null, b: number | string | null): number {
  if (a === b) return 0
  if (typeof a === 'string' || typeof b === 'string') {
    return TITLE_COLLATOR.compare(String(a), String(b))
  }
  return (a ?? 0) - (b ?? 0)
}

/**
 * 单字段比较。
 *
 * 约定：永远返回"自然升序"的结果，方向由 sortNotes 统一处理。
 * 这里如果自己带上方向，sortNotes 再乘一次符号就会反过来
 * （等级比较就踩过这个坑）。
 *
 * 空值也在这里处理，但**不参与方向翻转** —— 没有截止时间的待办
 * 不该因为用户点了"降序"就顶到列表最前面挡住真正的急事。
 */
export function compareNotes(a: Note, b: Note, key: SortKey): number {
  if (key === 'title') {
    return TITLE_COLLATOR.compare(a.title, b.title)
  }
  if (key === 'priority') {
    return a.priority - b.priority
  }
  return compareNullable(a[key], b[key])
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined
}

export function sortNotes(notes: Note[], key: SortKey, direction: SortDirection = 'asc'): Note[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...notes].sort((a, b) => {
    const aEmpty = isEmpty(a[key])
    const bEmpty = isEmpty(b[key])
    // 空值恒定沉底，方向怎么切都一样
    if (aEmpty && bEmpty) return a.id.localeCompare(b.id)
    if (aEmpty) return 1
    if (bEmpty) return -1

    const primary = compareNotes(a, b, key) * sign
    // 同键值时用 id 兜底，保证排序稳定（否则虚拟列表会抖动）
    return primary !== 0 ? primary : a.id.localeCompare(b.id)
  })
}

export function filterNotes(notes: Note[], filter: NoteFilter): Note[] {
  return notes.filter((note) => matchesFilter(note, filter))
}

/** 今天结束的最后一个毫秒（本地时区，闭区间） */
export function endOfToday(now: number = Date.now()): number {
  const d = new Date(now)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

export type NoteBucket = 'overdue' | 'today' | 'upcoming' | 'someday' | 'done'

export interface BucketedNotes {
  overdue: Note[]
  today: Note[]
  upcoming: Note[]
  someday: Note[]
  done: Note[]
}

/**
 * 悬浮窗用的分组。
 *
 * 判定顺序是有意的：
 *   1. 已完成 / 已归档 → done（不论有没有截止时间）
 *   2. 没有截止时间   → someday
 *   3. 已过期         → overdue
 *   4. 今天内到期     → today
 *   5. 其余           → upcoming
 *
 * "今天内"按用户本地时区计算：凌晨 1 点新建的"今天 9 点"算今天到期，
 * 而不是 UTC 意义上的昨天。
 */
export function bucketNotes(notes: Note[], now: number = Date.now()): BucketedNotes {
  const buckets: BucketedNotes = {
    overdue: [],
    today: [],
    upcoming: [],
    someday: [],
    done: [],
  }

  const todayEnd = endOfToday(now)

  for (const note of notes) {
    if (note.deletedAt !== null) continue

    if (note.status === 'done' || note.status === 'archived') {
      buckets.done.push(note)
      continue
    }

    if (note.dueAt === null) {
      buckets.someday.push(note)
      continue
    }

    if (note.dueAt < now) {
      buckets.overdue.push(note)
    } else if (note.dueAt <= todayEnd) {
      buckets.today.push(note)
    } else {
      buckets.upcoming.push(note)
    }
  }

  // 两级排序：先排"次序"，再用稳定排序排"主序"。
  // 顺序不能反 —— Array.sort 是稳定的，先排主序的话会被后一次排序
  // 降级成 tie-break，结果变成以截止时间为主、等级为辅，正好与意图相反。
  buckets.overdue = sortNotes(sortNotes(buckets.overdue, 'dueAt', 'asc'), 'priority', 'desc')
  buckets.today = sortNotes(sortNotes(buckets.today, 'dueAt', 'asc'), 'priority', 'desc')
  buckets.upcoming = sortNotes(buckets.upcoming, 'dueAt', 'asc')
  buckets.someday = sortNotes(sortNotes(buckets.someday, 'createdAt', 'desc'), 'priority', 'desc')

  // 已完成的倒序取最近操作的 N 条，避免清单一打开就铺满半屏完成项
  buckets.done = sortNotes(buckets.done, 'updatedAt', 'desc').slice(0, 20)

  return buckets
}

/** 悬浮窗标题栏要显示的计数：未完成的总数 */
export function pendingCount(buckets: BucketedNotes): number {
  return buckets.overdue.length + buckets.today.length + buckets.upcoming.length + buckets.someday.length
}

export function isOverdue(note: Note, now: number = Date.now()): boolean {
  return (
    note.deletedAt === null &&
    note.status !== 'done' &&
    note.status !== 'archived' &&
    note.dueAt !== null &&
    note.dueAt < now
  )
}

/** 人类可读的逾期天数/小时数 */
export function overdueLabel(note: Note, now: number = Date.now()): string {
  if (note.dueAt === null || note.dueAt >= now) return ''
  const diff = now - note.dueAt
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `逾期 ${Math.max(1, minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `逾期 ${hours} 小时`
  const days = Math.floor(hours / 24)
  return `逾期 ${days} 天`
}

/** 本地时区当天 00:00:00.000 的时间戳 */
export function startOfLocalDay(now: number = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 常用筛选预设。
 *
 * 刻意做成工厂函数而不是常量对象：涉及时间的预设如果写成模块级常量，
 * 会在 import 时就固定住 Date.now()，应用长时间不重启就会算错；
 * 用固定的毫秒偏移换算"今天"还会在夏令时切换当天出错（那天不是 24 小时）。
 */
export const presets = {
  openTodos: (): NoteFilter => ({ noteType: 'todo', status: ['open', 'doing'] }),

  today: (now: number = Date.now()): NoteFilter => {
    const from = startOfLocalDay(now)
    return { dueFrom: from, dueTo: from + 86_400_000 }
  },

  /** 本周内到期 */
  thisWeek: (now: number = Date.now()): NoteFilter => {
    const from = startOfLocalDay(now)
    const dow = new Date(from).getDay()
    // 周一为一周之首，与 date-fns 的 weekStartsOn 默认一致
    const weekStart = from - ((dow + 6) % 7) * 86_400_000
    return { dueFrom: weekStart, dueTo: weekStart + 7 * 86_400_000 }
  },

  highPriority: (): NoteFilter => ({ priority: [PRIORITY.HIGH] }),

  overdue: (now: number = Date.now()): NoteFilter => ({ dueTo: now, status: ['open', 'doing'] }),
}
