import { createRequire } from 'node:module'
import { openDatabase, markDirty, type DatabaseHandle } from '@/data/db'
import { memoryStorage } from './memoryStorage'

// Node 下 wasm 是 node_modules 里的真实文件，交给 sql.js 直接读
const wasmUrl = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm')

export interface TestDb {
  handle: DatabaseHandle
  /** 每次写操作后调这个，模拟真实运行时的去抖落盘 */
  flush: () => void
}

/** 建一个全新的内存库，跑完所有迁移 */
export async function createTestDb(): Promise<TestDb> {
  const handle = await openDatabase({
    storage: memoryStorage(),
    wasmUrl,
    saveDebounceMs: 0,
  })
  return { handle, flush: () => markDirty(handle) }
}

/** 建一个带初始数据的库 */
export async function createSeededDb(): Promise<TestDb> {
  return createTestDb()
}

export const TEST_USER = 'user-test-1'
export const TEST_DEVICE = 'device-test-1'
