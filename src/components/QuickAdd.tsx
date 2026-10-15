import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { parseQuickInput, useAppStore } from '@/state/useAppStore'

/**
 * 悬浮窗顶部的快速输入。
 *
 * 支持轻量语法（PRD F2.2）：
 *   "交房租"          → 普通待办
 *   "交房租!"         → 低
 *   "交房租!!"        → 中
 *   "交房租!!!"       → 高
 *   "明天 交房租!!"   → 明天 18:00 截止，中等级
 *
 * 语法只为省两次点击，不做完整解析；看不懂的输入会原样当标题。
 */
export function QuickAdd({ autoFocus = false }: { autoFocus?: boolean }) {
  const [value, setValue] = useState('')
  const create = useAppStore((s) => s.create)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    const raw = value.trim()
    if (!raw) return
    const parsed = parseQuickInput(raw)
    create({ noteType: 'todo', title: parsed.title, priority: parsed.priority, dueAt: parsed.dueAt })
    setValue('')
    // 连续记录时焦点留在输入框，用户可以一路敲下去
    inputRef.current?.focus()
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2" data-tauri-drag-region>
      <div className="relative flex-1">
        <Plus className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 opacity-40" />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          className="field pl-8"
          placeholder="记一笔…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              setValue('')
              e.currentTarget.blur()
            }
          }}
        />
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={submit}
        disabled={!value.trim()}
        aria-label="添加"
        title="添加（回车）"
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}
