import { useEffect, useMemo } from 'react'
import { Maximize2, RefreshCw } from 'lucide-react'
import { QuickAdd } from './QuickAdd'
import { NoteRow } from './NoteRow'
import { useAppStore } from '@/state/useAppStore'
import { windowApi } from '@/lib/window'
import type { Note } from '@/domain/types'
import { bucketNotes } from '@/domain/filters'

/**
 * 悬浮窗（PRD §8.1）。
 *
 * 结构：快速输入 → 分组列表 → 状态栏。
 * 展开态 320×480，收起态 320×56，由 Rust 侧按状态切换窗口尺寸。
 */
export function FloatingWindow() {
  const ready = useAppStore((s) => s.ready)
  const error = useAppStore((s) => s.error)
  const sync = useAppStore((s) => s.sync)
  const notes = useAppStore((s) => s.notes)

  // 直接从已订阅到的 notes 算，不在 useMemo 里偷读 store
  const buckets = useMemo(() => bucketNotes(notes), [notes])
  const pending = buckets.overdue.length + buckets.today.length + buckets.upcoming.length + buckets.someday.length

  // Mica 材质背景跟随系统深浅色
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => void windowApi.applyMica(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  if (error) {
    return (
      <div className="float-window surface-window h-full p-4 text-[13px]">
        <p className="font-medium">启动失败</p>
        <p className="mt-2 text-[11px] text-[var(--text-secondary)] selectable">{error}</p>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="float-window surface-window flex h-full items-center justify-center">
        <RefreshCw className="size-4 animate-spin opacity-50" />
      </div>
    )
  }

  return (
    <div className="float-window surface-window flex h-full flex-col">
      <div className="shrink-0 border-b border-[var(--border)]" data-tauri-drag-region>
        <QuickAdd />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <Group title="今天" count={buckets.today.length}>
          {buckets.today}
        </Group>

        <Group title="已逾期" count={buckets.overdue.length} tone="danger">
          {buckets.overdue}
        </Group>

        <Group title="稍后" count={buckets.upcoming.length} collapsed={buckets.upcoming.length > 4}>
          {buckets.upcoming.slice(0, 4)}
        </Group>

        <Group title="有空再想" count={buckets.someday.length} collapsed={buckets.someday.length > 4}>
          {buckets.someday.slice(0, 4)}
        </Group>

        {pending === 0 && buckets.done.length === 0 && (
          <p className="py-8 text-center text-[12px] text-[var(--text-tertiary)]">还没有待办</p>
        )}
      </div>

      <div
        className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--border)] px-3 text-[10px] text-[var(--text-tertiary)]"
        data-tauri-drag-region
      >
        <span>{sync.state === 'local-only' ? `本机 · ${pending} 项待办` : `已同步 · ${pending} 项待办`}</span>
        <button
          type="button"
          className="icon-button !size-5"
          title="展开主窗口"
          aria-label="展开主窗口"
          onClick={() => void windowApi.setSize(980, 640)}
        >
          <Maximize2 className="size-3" />
        </button>
      </div>
    </div>
  )
}

function Group({
  title,
  count,
  children,
  tone = 'normal',
  collapsed = false,
}: {
  title: string
  count: number
  children: Note[]
  tone?: 'normal' | 'danger'
  collapsed?: boolean
}) {
  if (count === 0) return null

  return (
    <section className="mb-1.5">
      <header className="flex items-baseline gap-1.5 px-2 pb-0.5 text-[11px] font-medium">
        <span className={tone === 'danger' ? 'text-[var(--color-prio-3)]' : 'text-[var(--text-secondary)]'}>
          {title}
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)]">{count}</span>
        {collapsed && count > 4 && (
          <span className="ml-auto text-[10px] text-[var(--text-tertiary)]">仅显示前 4 项</span>
        )}
      </header>
      {children.map((note) => (
        <NoteRow key={note.id} note={note} showDue={tone !== 'danger'} />
      ))}
    </section>
  )
}
