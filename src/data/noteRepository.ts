import type { Database } from 'sql.js'
import type { NewNoteInput, Note, NoteStatus, NoteType, Op, Priority, SyncedField, TodoList } from '@/domain/types'
import { SYNCED_FIELDS } from '@/domain/types'
import { ulid } from '@/domain/ulid'
import type { NoteFilter } from '@/domain/filters'
import { indexNote, removeFromIndex, searchNoteIds } from './search'

/**
 * 笔记仓库。
 *
 * 一条铁律：**业务表的写入和 oplog 的写入必须在同一个事务里**。
 * 分开写就会出现"数据改了但没记进日志"，同步时这台设备的变更永远传不上去，
 * 而且这种不一致本地完全看不出来 —— 只在用户换设备后才发现数据丢了。
 */

const COLUMN_BY_FIELD: Record<SyncedField, string> = {
  noteType: 'note_type',
  title: 'title',
  content: 'content',
  status: 'status',
  priority: 'priority',
  listId: 'list_id',
  startAt: 'start_at',
  endAt: 'end_at',
  dueAt: 'due_at',
  allDay: 'all_day',
  repeatRule: 'repeat_rule',
  remindAt: 'remind_at',
  remindRepeat: 'remind_repeat',
  color: 'color',
  parentId: 'parent_id',
  sortOrder: 'sort_order',
  deletedAt: 'deleted_at',
}

interface NoteRow {
  id: string
  user_id: string
  note_type: string
  title: string
  content: string
  status: string | null
  priority: number
  list_id: string | null
  start_at: number | null
  end_at: number | null
  due_at: number | null
  all_day: number
  repeat_rule: string | null
  remind_at: number | null
  remind_repeat: string | null
  color: string | null
  parent_id: string | null
  sort_order: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  rev: number
  device_id: string
  field_timestamps: string
}

function rowToNote(row: NoteRow): Note {
  let fieldTimestamps: Partial<Record<SyncedField, number>> = {}
  try {
    fieldTimestamps = JSON.parse(row.field_timestamps || '{}') as typeof fieldTimestamps
  } catch {
    // 历史数据或手改过的库可能有脏值，退回空对象而不是让整条记录读不出来
    fieldTimestamps = {}
  }

  return {
    id: row.id,
    userId: row.user_id,
    noteType: row.note_type as NoteType,
    title: row.title,
    content: row.content,
    status: row.status as NoteStatus | null,
    priority: row.priority as Priority,
    listId: row.list_id,
    startAt: row.start_at,
    endAt: row.end_at,
    dueAt: row.due_at,
    allDay: row.all_day === 1,
    repeatRule: row.repeat_rule,
    remindAt: row.remind_at,
    remindRepeat: row.remind_repeat,
    color: row.color,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    rev: row.rev,
    deviceId: row.device_id,
    fieldTimestamps,
  }
}

function queryRows<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const result = db.exec(sql, params as never)
  const first = result[0]
  if (!first?.values) return []
  return first.values.map((values) => {
    const obj: Record<string, unknown> = {}
    first.columns.forEach((col, i) => {
      obj[col] = values[i]
    })
    return obj as T
  })
}

function recordOp(
  db: Database,
  entity: Op['entity'],
  entityId: string,
  opType: Op['opType'],
  fields: SyncedField[],
  payload: Note | TodoList | null,
  ts: number,
): Op {
  const op: Op = {
    opId: ulid(ts),
    entity,
    entityId,
    opType,
    fields,
    payload,
    ts,
  }
  db.run(
    'INSERT INTO oplog (op_id, entity, entity_id, op_type, fields, payload, ts, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
    [op.opId, entity, entityId, opType, JSON.stringify(fields), payload ? JSON.stringify(payload) : null, ts],
  )
  return op
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export function getNote(db: Database, id: string): Note | null {
  const rows = queryRows<NoteRow>(db, 'SELECT * FROM notes WHERE id = ?', [id])
  const row = rows[0]
  return row ? rowToNote(row) : null
}

export function listNotes(db: Database, filter: NoteFilter = {}, userId?: string): Note[] {
  const where: string[] = []
  const params: unknown[] = []

  if (userId) {
    where.push('user_id = ?')
    params.push(userId)
  }
  if (!filter.includeDeleted) where.push('deleted_at IS NULL')
  if (!filter.includeArchived) where.push("(status IS NULL OR status != 'archived')")

  if (filter.noteType !== undefined) {
    const types = Array.isArray(filter.noteType) ? filter.noteType : [filter.noteType]
    if (types.length > 0) {
      where.push(`note_type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
  }

  if (filter.status !== undefined && filter.status.length > 0) {
    where.push(`status IN (${filter.status.map(() => '?').join(',')})`)
    params.push(...filter.status)
  }

  if (filter.priority !== undefined && filter.priority.length > 0) {
    where.push(`priority IN (${filter.priority.map(() => '?').join(',')})`)
    params.push(...filter.priority)
  }

  if (filter.listId !== undefined) {
    if (filter.listId === null) {
      where.push('list_id IS NULL')
    } else {
      where.push('list_id = ?')
      params.push(filter.listId)
    }
  }

  if (filter.dueFrom !== undefined) {
    where.push('due_at IS NOT NULL AND due_at >= ?')
    params.push(filter.dueFrom)
  }
  if (filter.dueTo !== undefined) {
    where.push('due_at IS NOT NULL AND due_at < ?')
    params.push(filter.dueTo)
  }

  if (filter.tagIds !== undefined && filter.tagIds.length > 0) {
    const placeholders = filter.tagIds.map(() => '?').join(',')
    where.push(`id IN (SELECT note_id FROM note_tags WHERE tag_id IN (${placeholders}))`)
    params.push(...filter.tagIds)
  }

  const sql = `SELECT * FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`
  return queryRows<NoteRow>(db, sql, params).map(rowToNote)
}

export function countNotes(db: Database, userId?: string): number {
  const rows = queryRows<{ c: number }>(
    db,
    'SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL' + (userId ? ' AND user_id = ?' : ''),
    userId ? [userId] : [],
  )
  return Number(rows[0]?.c ?? 0)
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export function createNote(db: Database, input: NewNoteInput): Note {
  const now = Date.now()
  const id = ulid(now)
  const noteType = input.noteType ?? 'todo'
  const fieldTimestamps: Partial<Record<SyncedField, number>> = {}

  // 新建的记录，所有字段的时间戳都等于创建时间
  for (const field of SYNCED_FIELDS) fieldTimestamps[field] = now

  const note: Note = {
    id,
    userId: input.userId,
    noteType,
    title: input.title ?? '',
    content: input.content ?? '',
    status: input.status ?? (noteType === 'todo' ? 'open' : null),
    priority: input.priority ?? 0,
    listId: input.listId ?? null,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    dueAt: input.dueAt ?? null,
    allDay: input.allDay ?? false,
    repeatRule: input.repeatRule ?? null,
    remindAt: input.remindAt ?? null,
    remindRepeat: null,
    color: input.color ?? null,
    parentId: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    deviceId: input.deviceId,
    fieldTimestamps,
  }

  db.run('BEGIN')
  try {
    db.run(
      `INSERT INTO notes (
         id, user_id, note_type, title, content, status, priority, list_id,
         start_at, end_at, due_at, all_day, repeat_rule, remind_at, remind_repeat,
         color, parent_id, sort_order, created_at, updated_at, deleted_at,
         rev, device_id, field_timestamps
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        note.id, note.userId, note.noteType, note.title, note.content, note.status, note.priority,
        note.listId, note.startAt, note.endAt, note.dueAt, note.allDay ? 1 : 0, note.repeatRule,
        note.remindAt, note.remindRepeat, note.color, note.parentId, note.sortOrder,
        note.createdAt, note.updatedAt, note.deletedAt, note.rev, note.deviceId,
        JSON.stringify(fieldTimestamps),
      ],
    )
    recordOp(db, 'notes', id, 'upsert', [...SYNCED_FIELDS], note, now)
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }

  indexNote(db, id, note.title, note.content)
  return note
}

export type NotePatch = Partial<Omit<Note, 'id' | 'userId' | 'createdAt' | 'rev' | 'deviceId' | 'fieldTimestamps'>>

/**
 * 局部更新。
 *
 * 关键在于只给**真正改动的字段**打上新的时间戳 —— 字段级 LWW 完全依赖这一点。
 * 如果每次更新都刷新所有字段的时间戳，那么"手机上改了标题"就会让
 * "电脑上改的正文"时间戳一起变新，合并时两个字段都会被同一台设备的时间戳裁决，
 * 退化成记录级 LWW。
 */
export function updateNote(db: Database, id: string, patch: NotePatch, deviceId: string): Note | null {
  const current = getNote(db, id)
  if (!current) return null

  const now = Date.now()
  const changed: SyncedField[] = []
  const fieldTimestamps: Partial<Record<SyncedField, number>> = { ...current.fieldTimestamps }

  for (const [key, value] of Object.entries(patch)) {
    if (!(SYNCED_FIELDS as readonly string[]).includes(key)) continue
    const field = key as SyncedField
    if (Object.is(current[field], value)) continue

    changed.push(field)
    fieldTimestamps[field] = now
  }

  if (changed.length === 0) return current

  const setClauses = changed.map((field) => `${COLUMN_BY_FIELD[field]} = ?`)
  const params: unknown[] = changed.map((field) => {
    const v = patch[field]
    return field === 'allDay' ? (v ? 1 : 0) : v
  })

  setClauses.push('updated_at = ?', 'rev = rev + 1', 'device_id = ?', 'field_timestamps = ?')
  params.push(now, deviceId, JSON.stringify(fieldTimestamps), id)

  db.run('BEGIN')
  try {
    db.run(`UPDATE notes SET ${setClauses.join(', ')} WHERE id = ?`, params as never)
    const updated = getNote(db, id)
    if (updated) recordOp(db, 'notes', id, 'upsert', changed, updated, now)
    db.run('COMMIT')

    if (updated && (changed.includes('title') || changed.includes('content'))) {
      indexNote(db, id, updated.title, updated.content)
    }
    return updated
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }
}

/** 软删除：进回收站，保留 30 天（PRD F3.1） */
export function softDeleteNote(db: Database, id: string): boolean {
  const current = getNote(db, id)
  if (!current) return false

  const now = Date.now()
  db.run('BEGIN')
  try {
    db.run(
      `UPDATE notes SET deleted_at = ?, updated_at = ?, rev = rev + 1, field_timestamps = ? WHERE id = ?`,
      [
        now,
        now,
        JSON.stringify({ ...current.fieldTimestamps, deletedAt: now }),
        id,
      ],
    )
    removeFromIndex(db, id)
    recordOp(db, 'notes', id, 'delete', ['deletedAt'], null, now)
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }
  return true
}

/** 恢复：从回收站还原 */
export function restoreNote(db: Database, id: string): Note | null {
  const updated = updateNote(db, id, { deletedAt: null }, 'system')
  if (updated) indexNote(db, id, updated.title, updated.content)
  return updated
}

/** 彻底删除，同时清掉索引和待同步记录 */
export function purgeNote(db: Database, id: string): boolean {
  db.run('BEGIN')
  try {
    db.run('DELETE FROM notes WHERE id = ?', [id])
    removeFromIndex(db, id)
    db.run('DELETE FROM note_tags WHERE note_id = ?', [id])
    db.run('DELETE FROM oplog WHERE entity = ? AND entity_id = ?', ['notes', id])
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }
  return true
}

/** 清空回收站（超过保留期的） */
export function purgeDeletedBefore(db: Database, cutoff: number): number {
  const rows = queryRows<{ id: string }>(db, 'SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?', [
    cutoff,
  ])
  rows.forEach((row) => purgeNote(db, row.id))
  return rows.length
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/**
 * 全文搜索。返回完整 Note，不是 ID。
 *
 * 检索结果再过一遍 NoteFilter，这样"搜索 + 筛选等级"能组合使用
 * （悬浮窗里搜到结果后仍然只看高优先级）。
 */
export function searchNotes(db: Database, query: string, filter: NoteFilter = {}, userId?: string): Note[] {
  const ids = searchNoteIds(db, query)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const rows = queryRows<NoteRow>(
    db,
    `SELECT * FROM notes WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
    ids,
  )

  const notes = rows.map(rowToNote)

  return notes
    .filter((n) => (userId ? n.userId === userId : true))
    .filter((n) => applyFilter(n, filter))
}

function applyFilter(note: Note, filter: NoteFilter): boolean {
  if (!filter.includeDeleted && note.deletedAt !== null) return false
  if (!filter.includeArchived && note.status === 'archived') return false
  if (filter.noteType !== undefined) {
    const types = Array.isArray(filter.noteType) ? filter.noteType : [filter.noteType]
    if (!types.includes(note.noteType)) return false
  }
  if (filter.priority !== undefined && filter.priority.length > 0 && !filter.priority.includes(note.priority)) {
    return false
  }
  return true
}
