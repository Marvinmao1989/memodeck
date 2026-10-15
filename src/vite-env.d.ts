/// <reference types="vite/client" />

// sql.js 的 wasm 以 ?url 形式引入，交给 Vite 处理产物路径与哈希。
// TypeScript 不认识这个后缀，这里补一个模块声明。
declare module '*.wasm?url' {
  const url: string
  export default url
}
