import type { StorageAdapter } from '@/data/db'
import { SQLJS_WASM_URL } from '@/data/wasm'

export { SQLJS_WASM_URL }

/**
 * 存储后端选择。
 *
 * 应用运行在 Tauri 里 → 走 Rust command 读写 exe 同级的 data/ 目录（绿色版）。
 * 直接用浏览器打开（npm run dev）→ 退回 localStorage，方便本地试用。
 *
 * 生产环境不应该走 localStorage 分支 —— 它有 5MB 上限，而且 SQLite 的
 * 整库导出每次都全量写进去，很快就会顶到限制。
 */

const DB_KEY = 'memodeck.db.v1'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function tauriStorage(): Promise<StorageAdapter> {
  const { invoke } = await import('@tauri-apps/api/core')
  return {
    async read() {
      const bytes = await invoke<number[] | null>('load_db')
      return bytes ? new Uint8Array(bytes) : null
    },
    async write(data) {
      // 一次传输几 MB 的 Uint8Array，serde 默认走 JSON 会慢且占内存，
      // 所以 Rust 侧接收的是数组形式并在那边转回二进制
      await invoke('save_db', { bytes: Array.from(data) })
    },
    describeLocation() {
      return 'exe 同级 data/ 目录（绿色版）'
    },
  }
}

function browserStorage(): StorageAdapter {
  return {
    async read() {
      const raw = localStorage.getItem(DB_KEY)
      if (!raw) return null
      try {
        const binary = atob(raw)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        return bytes
      } catch {
        // 数据损坏时当作空库，让用户能继续用，而不是启动即崩
        localStorage.removeItem(DB_KEY)
        return null
      }
    },
    async write(data) {
      let binary = ''
      const chunk = 0x8000 // 避免 apply 参数过多爆栈
      for (let i = 0; i < data.length; i += chunk) {
        binary += String.fromCharCode(...data.subarray(i, i + chunk))
      }
      localStorage.setItem(DB_KEY, btoa(binary))
    },
    describeLocation() {
      return '浏览器 localStorage（仅开发试用）'
    },
  }
}

export async function createStorage(): Promise<StorageAdapter> {
  if (isTauri()) {
    try {
      return await tauriStorage()
    } catch (err) {
      console.error('[storage] Tauri 存储不可用，退回浏览器实现', err)
    }
  }
  return browserStorage()
}
