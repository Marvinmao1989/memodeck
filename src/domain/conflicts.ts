import type { FieldConflict, Note, SyncedField } from './types'
import { SYNCED_FIELDS } from './types'

/**
 * 字段级 Last-Write-Wins 合并。
 *
 * 为什么不能直接按记录级 updated_at 裁决：
 *
 *   10:00 手机上把"交房租"的标题改成"交房租（含物业）"
 *   10:05 电脑上把同一条的正文补上了账号信息
 *   10:10 两台设备同步
 *
 * 如果按记录级时间戳，10:05 的整条记录会覆盖 10:00 的，用户在手机上改的
 * 标题就被无声地冲掉了。而这两处修改根本冲突。
 *
 * 解决办法是给每个字段单独记时间戳（Note.fieldTimestamps），合并时逐字段
 * 比时间。代价是每条记录多一个 JSON 列，换来的是"不同字段的并发修改不会
 * 互相覆盖" —— 这是本地优先应用里最常见的场景。
 *
 * 平局时选远端：服务端是跨设备同步的权威副本，同一时间戳下以它为准。
 */

export interface MergeConflict {
  field: SyncedField
  localValue: unknown
  remoteValue: unknown
}

export interface MergeResult {
  note: Note
  /**
   * 本地值在竞速中被远端盖掉的字段。
   *
   * 注意这不是"两个设备改了同一个字段"的严格检测 —— 那需要共同祖先，
   * 本地优先架构里拿不到。这里的语义更朴素：**本地有值，最后不是它**。
   *
   * 用 mergeWithPendingOps 时，待推送的本地修改会被掩码成必胜，
   * 因此不会出现在这里 —— 也就是说这个列表里的每一项都是
   * "本地已经放弃了、但值得让用户知道一下"的情况。
   */
  overwritten: MergeConflict[]
}

function fieldTs(note: Note, field: SyncedField): number {
  return note.fieldTimestamps[field] ?? note.createdAt
}

/** 判断两个值在数据层面是否真的不同（避免 undefined / null 造成假冲突） */
function isDifferent(a: unknown, b: unknown): boolean {
  if (a === b) return false
  // 一方为空、另一方有值，算真实差异
  if (a === null || a === undefined) return true
  if (b === null || b === undefined) return true
  return a !== b
}

export function mergeNotes(local: Note, remote: Note): MergeResult {
  if (local.id !== remote.id) {
    throw new Error(`mergeNotes: id 不一致（local=${local.id}, remote=${remote.id}）`)
  }
  if (local.userId !== remote.userId) {
    // 不同用户的数据永远不能合并到同一条记录里，这是数据隔离的红线
    throw new Error(`mergeNotes: userId 不一致，拒绝合并（local=${local.userId}）`)
  }

  const merged: Note = { ...local }
  const mergedTimestamps: Partial<Record<SyncedField, number>> = { ...local.fieldTimestamps }
  const overwritten: MergeConflict[] = []

  for (const field of SYNCED_FIELDS) {
    const localValue = local[field]
    const remoteValue = remote[field]

    if (!isDifferent(localValue, remoteValue)) {
      // 值相同就不动它，时间戳取较晚者，保证后续合并不会回退
      mergedTimestamps[field] = Math.max(fieldTs(local, field), fieldTs(remote, field))
      continue
    }

    const localTs = fieldTs(local, field)
    const remoteTs = fieldTs(remote, field)

    if (remoteTs >= localTs) {
      // 远端较新（或打平）：覆盖本地
      ;(merged as unknown as Record<string, unknown>)[field] = remoteValue
      mergedTimestamps[field] = remoteTs
      overwritten.push({ field, localValue, remoteValue })
    } else {
      // 本地较新：保留本地值
      mergedTimestamps[field] = localTs
    }
  }

  merged.fieldTimestamps = mergedTimestamps
  merged.updatedAt = Math.max(local.updatedAt, remote.updatedAt)
  merged.rev = Math.max(local.rev, remote.rev) + 1

  return { note: merged, overwritten }
}

/**
 * 应用远端操作前的合并入口。
 *
 * 只在本地没有对该字段的未同步修改时才直接采纳远端值 —— oplog 里
 * 攒着待推送的本地修改时，说明本地版本还没被服务端确认过，
 * 不能被远端悄悄覆盖掉。
 */
export function mergeWithPendingOps(
  local: Note,
  remote: Note,
  pendingFields: ReadonlySet<SyncedField>,
): MergeResult {
  const maskedRemote: Note = { ...remote, fieldTimestamps: { ...remote.fieldTimestamps } }
  for (const field of pendingFields) {
    // 把远端该字段的时间戳压到 0，使其在合并中永远输给本地
    maskedRemote.fieldTimestamps[field] = 0
  }
  return mergeNotes(local, maskedRemote)
}

export function toFieldConflict(
  entityId: string,
  c: MergeConflict,
  createdAt: number,
  id: string,
): FieldConflict {
  return {
    id,
    entity: 'notes',
    entityId,
    field: c.field,
    localValue: c.localValue,
    remoteValue: c.remoteValue,
    createdAt,
    resolved: false,
  }
}
