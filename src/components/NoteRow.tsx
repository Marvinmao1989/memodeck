import { memo } from 'react'
import { Check } from 'lucide-react'
import type { Note, Priority } from '@/domain/types'
import { PRIORITY } from '@/domain/types'
import { priorityMeta } from '@/domain/priority'
import { overdueLabel } from '@/domain/filters'
import { useAppStore } from '@/state/useAppStore'

const PRIORITY_CLASS: Record<Priority, string> = {
  [PRIORITY.NONE]: 'bg-[var(--color-prio-0)]',
  [PRIORITY.LOW]: 'bg-[var(--color-prio-1)]',
  [PRIORITY.MEDIUM]: 'bg-[var(--color-prio-2)]',
  [PRIORITY.HIGH]: 'bg-[var(--color-prio-3)]',
}

/** 今天/逾期组里显示截止时间，其余组不显示避免噪音 */
function DueLabel({ note, showTime }: { note: Note; showTime: boolean }) {
  if (note.dueAt === null) return null
  const now = Date.now()

  if (note.dueAt < now) {
    return <span className="text-[10px] text-[var(--color-prio-3)]">{overdueLabel(note, now)}</span>
  }
  if (!showTime) return null

  const d = new Date(note.dueAt)
  const isToday = d.toDateString() === new Date(now).toDateString()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return <span className="text-[10px] text-[var(--text-tertiary)]">{isToday ? time : formatShort(note.dueAt)}</span>
}

function formatShort(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

interface RowProps {
  note: Note
  showDue?: boolean
  onOpen?: (note: Note) => void
}

/**
 * 单条待办。
 *
 * 用 memo 包起来：悬浮窗滚动时父组件会因为其它待办的变化而重渲染，
 * 不 memo 的话整列表都会跟着重画（PRD §4 要求 10 万条 60 FPS）。
 */
export const NoteRow = memo(function NoteRow({ note, showDue = true, onOpen }: RowProps) {
  const toggleDone = useAppStore((s) => s.toggleDone)
  const patch = useAppStore((s) => s.patch)
  const done = note.status === 'done'
  const meta = priorityMeta(note.priority)
  const overdue = note.dueAt !== null && note.dueAt < Date.now() && !done

  const cyclePriority = () => {
    const next = ((note.priority + 1) % 4) as Priority
    patch(note.id, { priority: next })
  }

  return (
    <div
      className="group flex h-8 items-center gap-2 rounded-[6px] px-2 transition-colors duration-100 hover:bg-[var(--hover)]"
      onDoubleClick={() => onOpen?.(note)}
    >
      {/* 等级色条 */}
      <span
        className={`h-4 w-[3px] shrink-0 rounded-full ${done ? 'bg-transparent' : PRIORITY_CLASS[note.priority]}`}
        aria-hidden
      />

      <button
        type="button"
        onClick={() => toggleDone(note.id)}
        className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-100 ${
          done
            ? 'border-transparent bg-[var(--accent)] text-[var(--accent-text)]'
            : 'border-[var(--border)] hover:border-[var(--text-tertiary)]'
        }`}
        aria-label={done ? '标记为未完成' : '标记为完成'}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </button>

      <button
        type="button"
        onClick={cyclePriority}
        className="flex h-5 w-5 shrink-0 items-center justify-center text-[11px] transition-opacity duration-100 hover:opacity-100"
        style={{ color: `var(--color-prio-${note.priority})`, opacity: note.priority === PRIORITY.NONE ? 0.35 : 0.9 }}
        aria-label={`等级：${meta.label}，点击切换`}
        title={`等级：${meta.label}`}
      >
        {meta.mark}
      </button>

      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${done ? 'text-[var(--text-tertiary)] line-through' : ''}`}
      >
        {note.title || '（无标题）'}
      </span>

      {overdue && (
        <span className="shrink-0 text-[10px] text-[var(--color-prio-3)]">{overdueLabel(note)}</span>
      )}
      {!overdue && <DueLabel note={note} showTime={showDue} />}
    </div>
  )
})
