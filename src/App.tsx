import { useEffect, useState } from 'react'
import { FloatingWindow } from './components/FloatingWindow'
import { MainWindow } from './components/MainWindow'
import { useAppStore } from './state/useAppStore'
import { createStorage, isTauri, SQLJS_WASM_URL } from './lib/storage'

/**
 * 应用入口。
 *
 * 同一个 index.html 同时服务两个窗口（悬浮窗 / 主窗口），
 * 用 Tauri 的窗口 label 区分 —— 见 tauri.conf.json 里两个 window 的 label。
 * 浏览器里跑（npm run dev）时用 ?window=main 切换，默认悬浮窗。
 */
function resolveMode(): 'floating' | 'main' {
  const search = new URLSearchParams(window.location.search)
  const query = search.get('window')

  if (query === 'main' || query === 'floating') return query

  if (isTauri()) {
    // Tauri 启动参数不带 query，直接看当前窗口的 label
    const label = readTauriWindowLabel()
    return label === 'main' ? 'main' : 'floating'
  }

  return 'floating'
}

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } }
}

function readTauriWindowLabel(): string | null {
  const internals = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  return internals?.metadata?.currentWindow?.label ?? null
}

export default function App() {
  const init = useAppStore((s) => s.init)
  const [mode] = useState(resolveMode)

  useEffect(() => {
    let cancelled = false
    void createStorage().then((storage) => {
      if (!cancelled) void init(storage, SQLJS_WASM_URL)
    })
    return () => {
      cancelled = true
    }
  }, [init])

  // 关闭窗口前把内存库刷盘，否则最后几秒的编辑会丢
  useEffect(() => {
    const flush = () => {
      const handle = useAppStore.getState().handle
      if (handle) void handle.save()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  return mode === 'main' ? <MainWindow /> : <FloatingWindow />
}
