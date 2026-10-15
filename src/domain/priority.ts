import type { Priority } from './types'
import { PRIORITY } from './types'

/**
 * 待办等级。
 *
 * PRD F4.2 定义为 4 档：无 / 低 / 中 / 高。数值越大越重要，
 * 排序时降序即可得到"最重要的在前"。
 */

export interface PriorityMeta {
  value: Priority
  /** 中文标签 */
  label: string
  /** 单字符标记，悬浮窗窄栏里比图标更省空间 */
  mark: string
  /** 浅色主题下的强调色 */
  colorLight: string
  /** 深色主题下的强调色（需在深底上保证对比度） */
  colorDark: string
}

export const PRIORITY_META: Record<Priority, PriorityMeta> = {
  [PRIORITY.NONE]: {
    value: PRIORITY.NONE,
    label: '无',
    mark: '·',
    colorLight: '#8A8886',
    colorDark: '#9E9E9E',
  },
  [PRIORITY.LOW]: {
    value: PRIORITY.LOW,
    label: '低',
    mark: '○',
    colorLight: '#0F6CBD',
    colorDark: '#60CDFF',
  },
  [PRIORITY.MEDIUM]: {
    value: PRIORITY.MEDIUM,
    label: '中',
    mark: '◐',
    colorLight: '#C76E00',
    colorDark: '#FCE100',
  },
  [PRIORITY.HIGH]: {
    value: PRIORITY.HIGH,
    label: '高',
    mark: '●',
    colorLight: '#D13438',
    colorDark: '#FF99A4',
  },
}

export const PRIORITY_ORDER: Priority[] = [
  PRIORITY.HIGH,
  PRIORITY.MEDIUM,
  PRIORITY.LOW,
  PRIORITY.NONE,
]

export function priorityMeta(priority: Priority): PriorityMeta {
  return PRIORITY_META[priority]
}

/** 把任意输入夹到合法等级范围，非整数或越界一律落到 NONE */
export function normalizePriority(input: unknown): Priority {
  if (typeof input !== 'number' || !Number.isInteger(input)) return PRIORITY.NONE
  if (input < 0 || input > 3) return PRIORITY.NONE
  return input as Priority
}
