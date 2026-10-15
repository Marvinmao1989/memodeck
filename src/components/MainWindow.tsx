import { useEffect, useMemo, useState } from 'react'
import { Calendar, CheckSquare, Inbox, Search, Trash2 } from 'lucide-react'
import { QuickAdd } from './QuickAdd'
import { NoteRow } from './NoteRow'
import { useAppStore, selectVisibleNotes, selectCounts, type ViewId } from '@/state/useAppStore'
import { windowApi } from '@/lib/window'
import type { Note } from '@/domain/types'

const NAV: Array<{ id: ViewId; label: string; icon: typeof Inbox }> = [
  { id: 'today', label: '今天', icon: CheckSquare },
  { id: 'all', label: '全部待办', icon: Inbox },
  { id: 'memos', label: '备忘录', icon: Inbox },
  { id: 'trash', label: '回收站', icon: Trash2 },
]

/** 主窗口（PRD §8.3）：左栏导航 + 中间列表 + 右侧详情 */
export function MainWindow() {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const notes = useAppStore((s) => s.notes)
  const [selected, setSelected] = useState<Note | null>(null)

  const visible = useMemo(() => selectVisibleNotes(useAppStore.getState()), [notes, view, search])
  const counts = useMemo(() => selectCounts(useAppStore.getState()), [notes])

  useEffect(() => {
    void windowApi.setTitle('MemoDeck')
  }, [])

  return (
    <div className="flex h-full">
      <nav className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-[var(--border)] p-2">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={`flex h-7 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] transition-colors duration-100 ${
              view === id
                ? 'bg-[var(--hover)] font-medium'
                : 'hover:bg-[var(--hover)] text-[var(--text-secondary)]'
            }`}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            {id === 'today' && counts.pending > 0 && (
              <span className="text-[10px] text-[var(--text-tertiary)]">{counts.pending}</span>
            )}
          </button>
        ))}

        <div className="mt-auto flex items-center justify-between px-2 pt-2 text-[11px] text-[var(--text-tertiary)]">
          <span>{counts.done} 项已完成</span>
          {counts.overdue > 0 && <span className="text-[var(--color-prio-3)]">{counts.overdue} 逾期</span>}
        </div>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--border)]">
          <QuickAdd />
          <div className="flex items-center gap-2 px-3 pb-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 opacity-40" />
              <input
                className="field h-7 pl-7 text-[12px]"
                placeholder="搜索标题和正文…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="py-16 text-center text-[12px] text-[var(--text-tertiary)]">
              {search ? '没有匹配的结果' : '这里还是空的'}
            </p>
          ) : (
            visible.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                onOpen={setSelected}
                showDue={view !== 'today'}
              />
            ))
          )}
        </div>
      </section>

      <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-[var(--border)] p-3">
        {selected ? <Detail note={selected} /> : <EmptyState />}
      </aside>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <Calendar className="size-6 opacity-25" />
      <p className="text-[12px] text-[var(--text-tertiary)]">双击左侧任意一条查看详情</p>
    </div>
  )
}

function Detail({ note }: { note: Note }) {
  const patch = useAppStore((s) => s.patch)
  const remove = useAppStore((s) => s.remove)

  return (
    <div className="flex flex-col gap-3">
      <input
        className="field text-[14px] font-medium"
        value={note.title}
        onChange={(e) => patch(note.id, { title: e.target.value })}
        placeholder="标题"
      />

      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <Field label="等级">
          <select
            className="field h-7"
            value={note.priority}
            onChange={(e) => patch(note.id, { priority: Number(e.target.value) as Note['priority'] })}
          >
            <option value={0}>无</option>
            <option value={1}>低</option>
            <option value={2}>中</option>
            <option value={3}>高</option>
          </select>
        </Field>

        <Field label="状态">
          <select
            className="field h-7"
            value={note.status ?? ''}
            onChange={(e) => patch(note.id, { status: (e.target.value || null) as Note['status'] })}
          >
            <option value="open">未开始</option>
            <option value="doing">进行中</option>
            <option value="done">已完成</option>
            <option value="archived">已归档</option>
          </select>
        </Field>
      </div>

      <Field label="正文">
        <textarea
          className="field min-h-[240px] resize-y text-[13px]"
          value={note.content}
          onChange={(e) => patch(note.id, { content: e.target.value })}
          placeholder="支持 Markdown…"
        />
      </Field>

      <p className="text-[10px] text-[var(--text-tertiary)]">
        创建于 {new Date(note.createdAt).toLocaleString('zh-CN')} · 第 {note.rev} 版
      </p>

      <button
        type="button"
        className="h-7 rounded-[6px] border border-[var(--border)] text-[12px] text-[var(--color-prio-3)] transition-colors duration-100 hover:bg-[var(--hover)]"
        onClick={() => remove(note.id)}
      >
        移到回收站
      </button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-[var(--text-tertiary)]">{label}</span>
      {children}
    </label>
  )
}
