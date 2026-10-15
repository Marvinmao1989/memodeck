import type { Database } from 'sql.js'
import { create } from 'zustand'
import type { NewNoteInput, Note, NoteStatus, Priority } from '@/domain/types'
import { PRIORITY } from '@/domain/types'
import { bucketNotes, matchesFilter, sortNotes, type NoteFilter, type SortKey } from '@/domain/filters'
import {
  createNote,
  listNotes,
  restoreNote,
  softDeleteNote,
  updateNote,
  type NotePatch,
} from '@/data/noteRepository'
import { openDatabase, markDirty, type DatabaseHandle, type StorageAdapter } from '@/data/db'
import { newDeviceId } from '@/domain/ulid'
import { createLocalProvider, type SyncProvider, type SyncStatus } from '@/sync/syncProvider'

export type ViewId = 'today' | 'all' | 'memos' | 'trash'

export interface AppState {
  /** 完整句柄：除了 SQL 连接，还带着去抖落盘的能力 */
  handle: DatabaseHandle | null
  userId: string
  deviceId: string

  notes: Note[]
  trashCount: number
  ready: boolean
  error: string | null

  view: ViewId
  search: string
  sortKey: SortKey
  sortDirection: 'asc' | 'desc'

  sync: SyncStatus

  init: (storage: StorageAdapter, wasmUrl: string) => Promise<void>
  reload: () => void
  quickAdd: (title: string) => void
  create: (input: Omit<NewNoteInput, 'userId' | 'deviceId'>) => void
  patch: (id: string, changes: NotePatch) => void
  toggleDone: (id: string) => void
  remove: (id: string) => void
  restore: (id: string) => void

  setView: (view: ViewId) => void
  setSearch: (search: string) => void
  setSort: (key: SortKey, direction?: 'asc' | 'desc') => void
}

/**
 * 应用状态。
 *
 * 内存里持有全部未删除笔记 —— 这个量级（几千条）下比每次查询数据库
 * 简单得多，界面也不会有查询延迟。超过一万条时应该换成按需分页加载。
 */
export const useAppStore = create<AppState>((set, get) => ({
  handle: null,
  userId: 'local-user',
  deviceId: '',

  notes: [],
  trashCount: 0,
  ready: false,
  error: null,

  view: 'today',
  search: '',
  sortKey: 'updatedAt',
  sortDirection: 'desc',

  sync: { state: 'local-only', pending: 0, lastSyncedAt: null, error: null },

  async init(storage, wasmUrl) {
    try {
      const handle: DatabaseHandle = await openDatabase({
        storage,
        wasmUrl,
        onMigration: (msg) => console.info(`[db] ${msg}`),
      })
      const deviceId = ensureDeviceId(handle.db)
      const notes = loadVisibleNotes(handle.db)

      set({
        handle,
        deviceId,
        notes,
        trashCount: countTrash(handle.db),
        ready: true,
        error: null,
      })

      const provider: SyncProvider = createLocalProvider(handle.db)
      provider.subscribe((status) => set({ sync: status }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), ready: true })
    }
  },

  reload() {
    const db = get().handle?.db
    if (!db) return
    set({ notes: loadVisibleNotes(db), trashCount: countTrash(db) })
  },

  quickAdd(title) {
    const text = title.trim()
    if (!text) return
    const { handle, userId, deviceId } = get()
    if (!handle) return
    createNote(handle.db, { userId, deviceId, noteType: 'todo', title: text })
    get().reload()
    markDirty(handle)
  },

  create(input: Omit<NewNoteInput, 'userId' | 'deviceId'>) {
    const { handle, userId, deviceId } = get()
    if (!handle) return
    createNote(handle.db, { userId, deviceId, ...input })
    get().reload()
    markDirty(handle)
  },

  patch(id, changes) {
    const { handle, deviceId } = get()
    if (!handle) return
    updateNote(handle.db, id, changes, deviceId)
    get().reload()
    markDirty(handle)
  },

  toggleDone(id) {
    const note = get().notes.find((n) => n.id === id)
    if (!note) return
    const next: NoteStatus = note.status === 'done' ? 'open' : 'done'
    get().patch(id, { status: next })
  },

  remove(id) {
    const { handle } = get()
    if (!handle) return
    softDeleteNote(handle.db, id)
    get().reload()
    markDirty(handle)
  },

  restore(id) {
    const { handle } = get()
    if (!handle) return
    restoreNote(handle.db, id)
    get().reload()
    markDirty(handle)
  },

  setView(view) {
    set({ view, search: '' })
  },

  setSearch(search) {
    set({ search })
  },

  setSort(sortKey, direction) {
    set({ sortKey, sortDirection: direction ?? get().sortDirection })
  },
}))

// ---------------------------------------------------------------------------
// 派生数据
// ---------------------------------------------------------------------------

/** 当前视图 + 搜索 + 排序后的列表 */
export function selectVisibleNotes(state: AppState): Note[] {
  const { notes, view, search, sortKey, sortDirection } = state

  if (search.trim()) {
    return sortNotes(
      notes.filter((n) => matchesFilter(n, { noteType: view === 'memos' ? 'memo' : undefined })),
      sortKey,
      sortDirection,
    )
  }

  const filter: NoteFilter = {
    noteType: view === 'memos' ? 'memo' : undefined,
    status: view === 'today' ? ['open', 'doing'] : undefined,
  }

  return sortNotes(notes.filter((n) => matchesFilter(n, filter)), sortKey, sortDirection)
}

export function selectCounts(state: AppState): { pending: number; done: number; overdue: number } {
  const buckets = bucketNotes(state.notes)
  return {
    pending: buckets.overdue.length + buckets.today.length + buckets.upcoming.length + buckets.someday.length,
    done: buckets.done.length,
    overdue: buckets.overdue.length,
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 业务层只知道"我改了数据"，落盘时机由 db 层去抖 */
function loadVisibleNotes(db: Database): Note[] {
  return listNotes(db, {}, undefined)
}

function countTrash(db: Database): number {
  return listNotes(db, { includeDeleted: true }, undefined).filter((n) => n.deletedAt !== null).length
}

function ensureDeviceId(db: Database): string {
  const rows = db.exec("SELECT value FROM settings WHERE key = 'device_id'")
  const existing = rows[0]?.values[0]?.[0]
  if (typeof existing === 'string' && existing.length > 0) return existing

  const id = newDeviceId()
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['device_id', id])
  return id
}

/** 悬浮窗快速添加用：解析简单语法，如 "明天 交房租 !!" */
export function parseQuickInput(raw: string, now: number = Date.now()): {
  title: string
  priority: Priority
  dueAt: number | null
} {
  let text = raw.trim()
  let priority: Priority = PRIORITY.NONE

  // 结尾的感叹号数量 → 等级。放最后处理，免得吃掉正文里的感叹号
  const bangs = text.match(/!+$/)
  if (bangs) {
    const n = bangs[0].length
    priority = n >= 3 ? PRIORITY.HIGH : n === 2 ? PRIORITY.MEDIUM : PRIORITY.LOW
    text = text.slice(0, -n).trim()
  }

  let dueAt: number | null = null
  const d = new Date(now)

  if (/\b今天\b/.test(text)) {
    d.setHours(18, 0, 0, 0)
    dueAt = d.getTime()
    text = text.replace(/\b今天\b/, '').trim()
  } else if (/\b明天\b/.test(text)) {
    d.setDate(d.getDate() + 1)
    d.setHours(18, 0, 0, 0)
    dueAt = d.getTime()
    text = text.replace(/\b明天\b/, '').trim()
  }

  return { title: text, priority, dueAt }
}
