import { RRule } from 'rrule'

/**
 * 重复规则。
 *
 * 采用 iCalendar RRULE 标准（RFC 5545）而不是自定义格式：以后要接 CalDAV /
 * Google Calendar 时不需要转换层，`rrule` 库生成的结果与其它日历系统兼容。
 */

/** 界面上给用户选的重复类型 */
export type RecurrencePreset =
  | 'none'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'custom'

const PRESET_TO_RRULE: Record<Exclude<RecurrencePreset, 'none' | 'custom'>, string> = {
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY',
}

export function buildRRule(preset: RecurrencePreset, customRule?: string | null): string | null {
  if (preset === 'none') return null
  if (preset === 'custom') {
    const trimmed = customRule?.trim()
    if (!trimmed) return null
    // 容错：用户可能输入 "FREQ=DAILY"，也可能是完整 VEVENT 里粘出来的一长串
    const cleaned = trimmed.includes('RRULE:') ? trimmed.slice(trimmed.indexOf('RRULE:') + 6) : trimmed
    const normalized = cleaned.startsWith('FREQ=') ? cleaned : `FREQ=${cleaned}`
    try {
      // 立刻验证一次，非法规则不落库
      new RRule({ ...RRule.parseString(normalized), dtstart: new Date() })
      return normalized
    } catch {
      return null
    }
  }
  return PRESET_TO_RRULE[preset]
}

/** 反推预设类型，用于编辑时回填界面 */
export function detectPreset(rule: string | null): RecurrencePreset {
  if (!rule) return 'none'
  const normalized = rule.trim()
  for (const [preset, value] of Object.entries(PRESET_TO_RRULE)) {
    if (normalized === value) return preset as RecurrencePreset
  }
  return 'custom'
}

/**
 * 展开重复规则在时间窗口内的所有发生时间。
 *
 * 返回的是**已解算出的一次性事件**（occurrence），不是原始记录。
 * 月视图里画出来的是这些 occurrence，不是那条 note。
 *
 * dtstart 和 range 都按毫秒时间戳传入；RRule 内部按 UTC 处理，
 * 跨时区显示时由展示层再转换。
 */
export function expandRecurrence(
  rule: string | null,
  dtstart: number,
  rangeStart: number,
  rangeEnd: number,
  limit = 500,
): number[] {
  if (!rule || dtstart === 0) return []

  let parsed
  try {
    parsed = RRule.parseString(rule)
  } catch {
    // 库里存在非法规则（手改过的数据、导入的脏数据）时不能炸掉整个日历
    return []
  }

  // count 是规则自带的重复次数限制，before 是我们要的窗口上界。
  // 两者结合，保证"无限重复"不会被一次性展开到永远。
  const options: ConstructorParameters<typeof RRule>[0] = {
    ...parsed,
    dtstart: new Date(dtstart),
    until: parsed.until
      ? new Date(parsed.until.getTime())
      : new Date(rangeEnd),
  }

  let occurrences: Date[]
  try {
    occurrences = new RRule(options).all((_, i) => i < limit)
  } catch {
    return []
  }

  return occurrences
    .map((d) => d.getTime())
    .filter((t) => t >= rangeStart && t <= rangeEnd)
}

/** 中文描述，用于列表副标题 */
export function describeRecurrence(rule: string | null): string {
  switch (detectPreset(rule)) {
    case 'none':
      return ''
    case 'daily':
      return '每天'
    case 'weekdays':
      return '工作日'
    case 'weekly':
      return '每周'
    case 'monthly':
      return '每月'
    case 'yearly':
      return '每年'
    case 'custom':
      return '自定义重复'
  }
}

/**
 * 某条记录在给定时间点是否处于重复的"活跃期"。
 * 用于判断今天该不该显示它。
 */
export function isOccurrenceActive(dtstart: number, now: number): boolean {
  return now >= dtstart
}
