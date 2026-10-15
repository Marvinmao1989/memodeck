/**
 * 领域模型定义。
 *
 * 设计约束（见 docs/PRD.md §2.1）：待办 / 备忘录 / 日历事件共用同一个 Note，
 * 通过 noteType 区分，靠可空字段表达差异。分表会让"日历混合视图""全局搜索"
 * "统一排序"退化成跨表查询。
 *
 * 时间一律用 Unix 毫秒（UTC）存储，展示层再转本地时区。
 */

/** 待办等级：4 档 */
export const PRIORITY = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
} as const

export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY]

export const NOTE_TYPES = ['todo', 'memo', 'event'] as const
export type NoteType = (typeof NOTE_TYPES)[number]

export const NOTE_STATUSES = ['open', 'doing', 'done', 'archived'] as const
export type NoteStatus = (typeof NOTE_STATUSES)[number]

/** 可参与同步的用户可见字段，也是冲突合并的裁决单元 */
export const SYNCED_FIELDS = [
  'noteType',
  'title',
  'content',
  'status',
  'priority',
  'listId',
  'startAt',
  'endAt',
  'dueAt',
  'allDay',
  'repeatRule',
  'remindAt',
  'remindRepeat',
  'color',
  'parentId',
  'sortOrder',
  'deletedAt',
] as const

export type SyncedField = (typeof SYNCED_FIELDS)[number]

export interface Note {
  /** ULID，客户端生成，字典序近似时间序 */
  id: string
  userId: string
  noteType: NoteType
  title: string
  /** 正文，Markdown */
  content: string
  status: NoteStatus | null
  priority: Priority
  listId: string | null
  /** 事件开始时间 */
  startAt: number | null
  /** 事件结束时间 */
  endAt: number | null
  /** 待办截止时间 */
  dueAt: number | null
  allDay: boolean
  /** iCalendar RRULE 字符串，如 FREQ=WEEKLY;BYDAY=MO,WE */
  repeatRule: string | null
  remindAt: number | null
  remindRepeat: string | null
  color: string | null
  /** 子任务父级 */
  parentId: string | null
  sortOrder: string | null
  createdAt: number
  updatedAt: number
  /** 软删除时间戳，进入回收站 */
  deletedAt: number | null
  /** 版本号，单调递增；为将来引入 CRDT 预留 */
  rev: number
  deviceId: string
  /**
   * 每个用户可见字段最后一次被修改的时间戳。
   * 这是"字段级 Last-Write-Wins"能成立的前提 —— 只有记录级 updatedAt
   * 的话无法区分"A 改了标题、B 改了正文"这种应该合并的情况。
   */
  fieldTimestamps: Partial<Record<SyncedField, number>>
}

export interface TodoList {
  id: string
  userId: string
  name: string
  color: string | null
  sortOrder: string | null
}

export interface Tag {
  id: string
  userId: string
  name: string
  color: string | null
}

export type OpType = 'upsert' | 'delete'

/** 操作日志中的一条记录，同步引擎的最小传输单元 */
export interface Op {
  /** 客户端生成的幂等键 */
  opId: string
  entity: 'notes' | 'lists' | 'tags'
  entityId: string
  opType: OpType
  /** 本次操作实际改动的字段列表 */
  fields: SyncedField[]
  /** 完整实体快照（upsert 时） */
  payload: Note | TodoList | Tag | null
  ts: number
}

/** 冲突副本：LWW 覆盖时保留被淘汰的一方，供用户查看 */
export interface FieldConflict {
  id: string
  entity: string
  entityId: string
  field: SyncedField
  localValue: unknown
  remoteValue: unknown
  createdAt: number
  resolved: boolean
}

/** 新建待办时的输入，其余字段给默认值 */
export interface NewNoteInput {
  userId: string
  deviceId: string
  noteType?: NoteType
  title?: string
  content?: string
  priority?: Priority
  status?: NoteStatus
  dueAt?: number | null
  startAt?: number | null
  endAt?: number | null
  allDay?: boolean
  listId?: string | null
  remindAt?: number | null
  repeatRule?: string | null
  color?: string | null
}
