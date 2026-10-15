import type { Database } from 'sql.js'
import type { Op } from '@/domain/types'

/**
 * 同步通道抽象。
 *
 * 本地优先的核心保证：**同步失败绝不能影响本地使用**（PRD §2.2）。
 * 所以接口设计上，任何远端错误都只会体现在 SyncStatus 里，
 * 永远不会冒泡到调用方让界面崩掉。
 *
 * 当前实现：LocalProvider（不联网）。
 * 下一步：SupabaseProvider，对接 supabase/migrations/0001_init.sql 里的
 * push_ops / pull_changes / pull_full 三个 RPC。
 */

export interface SyncStatus {
  state: 'local-only' | 'idle' | 'syncing' | 'offline' | 'error'
  /** 还没推送出去的操作条数 */
  pending: number
  lastSyncedAt: number | null
  error: string | null
}

export interface SyncProvider {
  readonly name: string
  /** 未推送的操作数，用于托盘角标和状态栏 */
  pendingCount(): number
  push(): Promise<number>
  pull(): Promise<Op[]>
  status(): SyncStatus
  subscribe(listener: (status: SyncStatus) => void): () => void
}

/** 不联网的实现。没登录、或用户主动选了"仅本机"时用它。 */
export function createLocalProvider(db: Database): SyncProvider {
  const listeners = new Set<(s: SyncStatus) => void>()

  return {
    name: 'local',
    pendingCount(): number {
      const rows = db.exec('SELECT COUNT(*) AS c FROM oplog WHERE synced = 0')
      return Number(rows[0]?.values[0]?.[0] ?? 0)
    },
    async push() {
      return 0
    },
    async pull() {
      return []
    },
    status() {
      return { state: 'local-only', pending: this.pendingCount(), lastSyncedAt: null, error: null }
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(this.status())
      return () => listeners.delete(listener)
    },
  }
}

/** 查询待推送的操作。同步引擎读它。 */
export function loadPendingOps(db: Database, limit = 500): Op[] {
  const result = db.exec(
    `SELECT op_id, entity, entity_id, op_type, fields, payload, ts
       FROM oplog WHERE synced = 0 ORDER BY ts ASC LIMIT ?`,
    [limit],
  )
  const first = result[0]
  if (!first?.values) return []

  return first.values.map((row) => {
    const [opId, entity, entityId, opType, fields, payload, ts] = row as [
      string,
      string,
      string,
      string,
      string,
      string | null,
      number,
    ]
    return {
      opId,
      entity: entity as Op['entity'],
      entityId,
      opType: opType as Op['opType'],
      fields: JSON.parse(fields) as Op['fields'],
      payload: payload ? JSON.parse(payload) : null,
      ts,
    }
  })
}

/** 标记已推送。必须在服务端确认收到之后才调用，否则丢数据。 */
export function markOpsSynced(db: Database, opIds: string[]): number {
  if (opIds.length === 0) return 0
  const placeholders = opIds.map(() => '?').join(',')
  db.run(`UPDATE oplog SET synced = 1 WHERE op_id IN (${placeholders})`, opIds as never)
  return opIds.length
}

/** 清理已推送且超过保留期的日志，避免 oplog 无限增长 */
export function pruneSyncedOps(db: Database, keepMs = 7 * 86_400_000): number {
  const cutoff = Date.now() - keepMs
  db.run('DELETE FROM oplog WHERE synced = 1 AND ts < ?', [cutoff])
  return Number(db.exec('SELECT changes() AS c')[0]?.values[0]?.[0] ?? 0)
}
