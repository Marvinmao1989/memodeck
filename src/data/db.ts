import type { Database, SqlJsStatic } from 'sql.js'
import { assertCapabilities, currentVersion, migrate } from './migrations'

/**
 * 数据库连接与持久化。
 *
 * 为什么用 sql.js（WASM 版 SQLite）而不是 Rust 侧的 rusqlite：
 * 同一份 SQL 在单元测试和应用里跑的是同一套，测过的 SQL 就是发布的 SQL。
 * 代价是整个库常驻内存，适合这个量级（PRD §4 目标 < 10 万条）。
 *
 * 真要换 rusqlite，只需要替换 `openDatabase` 和 StorageAdapter 的实现，
 * 领域层与 Repository 一行都不用动 —— 这就是下面这个接口存在的意义。
 */

/** 持久化后端：应用里走 Tauri command，测试里走 node:fs */
export interface StorageAdapter {
  read(): Promise<Uint8Array | null>
  write(data: Uint8Array): Promise<void>
  /** 绿色版场景下需要提示用户数据到底存在哪 */
  describeLocation?(): string
}

export interface DatabaseHandle {
  db: Database
  /** 把内存库落盘 */
  save(): Promise<void>
  close(): void
  readonly version: number
  readonly location: string
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null

/**
 * wasm 路径由调用方给。
 *
 * 浏览器里是 Vite 打包后的带哈希 URL，Node（测试）里是 node_modules 里的
 * 实际文件路径 —— 两种解析方式差别太大，放在数据层只会到处写
 * `if (isBrowser)`，所以拆出来交给调用方。
 */
async function loadSqlJs(wasmUrl: string): Promise<SqlJsStatic> {
  sqlJsPromise ??= import('sql.js').then((sqlJs) => sqlJs.default({ locateFile: () => wasmUrl }))
  return sqlJsPromise
}

export interface OpenOptions {
  storage: StorageAdapter
  /** sql-wasm.wasm 的位置，浏览器与 Node 取值不同 */
  wasmUrl: string
  /** 每次写入后延迟落盘的毫秒数，避免连续输入时反复写文件 */
  saveDebounceMs?: number
  onMigration?: (message: string) => void
}

export async function openDatabase(options: OpenOptions): Promise<DatabaseHandle> {
  const { storage, wasmUrl, saveDebounceMs = 1500, onMigration } = options

  const SQL = await loadSqlJs(wasmUrl)
  const bytes = await storage.read()

  // 没有历史数据时用 null 建库；sql.js 接受 undefined 表示空库
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database()

  db.run('PRAGMA foreign_keys = ON')

  assertCapabilities(db)
  migrate(db, onMigration)

  const version = currentVersion(db)
  let closed = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saving: Promise<void> = Promise.resolve()

  const persist = async (): Promise<void> => {
    if (closed) return
    // db.export() 返回的是 Uint8Array 视图，写盘前必须复制一份，
    // 否则后续的 SQL 操作会改掉这个 buffer 的内容
    const snapshot = db.export()
    await storage.write(new Uint8Array(snapshot))
  }

  // 串行化：多个 save 同时触发时只跑最后一个，中间的直接跳过。
  // 防止频繁 autosave 时多个 export 同时操作同一个 Database 实例。
  const scheduleSave = (): void => {
    if (closed) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saving = persist().catch((err) => {
        console.error('[db] 保存失败', err)
      })
    }, saveDebounceMs)
  }

  const handle: DatabaseHandle = {
    db,
    version,
    location: storage.describeLocation?.() ?? '未知位置',
    save: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      await saving
      await persist()
    },
    close: () => {
      if (closed) return
      if (saveTimer) clearTimeout(saveTimer)
      closed = true
      db.close()
    },
  }

  // 暴露给业务层调用：任何写操作后调用一次即可，落盘是去抖的
  ;(handle as DatabaseHandle & { markDirty: () => void }).markDirty = scheduleSave

  return handle
}

/** 取 markDirty；类型上做成可选是为了不让它混进 DatabaseHandle 的公开契约 */
export function markDirty(handle: DatabaseHandle): void {
  const fn = (handle as DatabaseHandle & { markDirty?: () => void }).markDirty
  fn?.()
}
