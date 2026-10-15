import type { StorageAdapter } from '@/data/db'

/**
 * 测试与开发用的内存持久化后端。
 *
 * 单独放在 src/test/ 而不是 src/data/，是为了让 Vite 在打包应用时
 * 完全看不到这个文件 —— 它不依赖 Tauri，也不该进浏览器产物。
 */
export function memoryStorage(initial: Uint8Array | null = null): StorageAdapter & { lastSaved: Uint8Array | null } {
  let stored: Uint8Array | null = initial
  return {
    get lastSaved() {
      return stored
    },
    async read() {
      return stored
    },
    async write(data) {
      stored = new Uint8Array(data)
    },
    describeLocation() {
      return '内存（测试）'
    },
  }
}
