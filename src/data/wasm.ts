/**
 * sql-wasm.wasm 在浏览器里的位置。
 *
 * 单独成文件是为了让 Vite 的 `?url` 转换只发生在这里，
 * 数据层因此不依赖 node:module，浏览器构建不会把它 externalize。
 */
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

export const SQLJS_WASM_URL = wasmUrl
