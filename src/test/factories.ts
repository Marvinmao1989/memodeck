import type { Note, Priority } from '@/domain/types'
import { PRIORITY } from '@/domain/types'

/** 测试用的笔记构造器，默认填满所有必填字段 */
export function makeNote(overrides: Partial<Note> = {}): Note {
  const now = 1_700_000_000_000
  const base: Note = {
    id: 'N0TEST',
    userId: 'user-1',
    noteType: 'todo',
    title: '',
    content: '',
    status: 'open',
    priority: PRIORITY.NONE,
    listId: null,
    startAt: null,
    endAt: null,
    dueAt: null,
    allDay: false,
    repeatRule: null,
    remindAt: null,
    remindRepeat: null,
    color: null,
    parentId: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    deviceId: 'device-1',
    fieldTimestamps: {},
  }
  return { ...base, ...overrides }
}

export function makeNotes(specs: Array<Partial<Note>>): Note[] {
  return specs.map((s, i) => makeNote({ id: `N${String(i).padStart(5, '0')}`, ...s }))
}

/** 本地时间的某一天 12:00，避免测试落在午夜附近导致跨天 */
export function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime()
}

export const P = PRIORITY as { NONE: Priority; LOW: Priority; MEDIUM: Priority; HIGH: Priority }
