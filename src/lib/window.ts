/**
 * 窗口操作。
 *
 * 浏览器里（npm run dev 直接打开）所有调用都是安全的空操作，
 * 这样界面代码不需要到处写 if (isTauri())。
 */

import { isTauri } from './storage'

type TauriWindow = {
  setAlwaysOnTop: (v: boolean) => Promise<void>
  setIgnoreCursorEvents: (v: boolean) => Promise<void>
  setDecorations: (v: boolean) => Promise<void>
  hide: () => Promise<void>
  show: () => Promise<void>
  setFocus: () => Promise<void>
  setSize: (w: number, h: number) => Promise<void>
  setPosition: (x: number, y: number) => Promise<void>
  startDragging: () => Promise<void>
  setEffects: (effects: unknown) => Promise<void>
  close: () => Promise<void>
  setTitle: (t: string) => Promise<void>
}

let cached: TauriWindow | null = null

async function currentWindow(): Promise<TauriWindow | null> {
  if (!isTauri()) return null
  if (cached) return cached
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  cached = (await getCurrentWindow()) as unknown as TauriWindow
  return cached
}

export const windowApi = {
  async setAlwaysOnTop(value: boolean) {
    await (await currentWindow())?.setAlwaysOnTop(value)
  },

  /**
   * 鼠标穿透。
   *
   * 注意这是全局开关：打开后整个窗口都不再接收鼠标事件，
   * 只能通过托盘或快捷键关回来（PRD R11）。
   */
  async setClickThrough(value: boolean) {
    await (await currentWindow())?.setIgnoreCursorEvents(value)
  },

  async setDecorations(value: boolean) {
    await (await currentWindow())?.setDecorations(value)
  },

  async hide() {
    await (await currentWindow())?.hide()
  },

  async show() {
    await (await currentWindow())?.show()
  },

  async focus() {
    await (await currentWindow())?.setFocus()
  },

  async setSize(width: number, height: number) {
    await (await currentWindow())?.setSize(width, height)
  },

  async setPosition(x: number, y: number) {
    await (await currentWindow())?.setPosition(x, y)
  },

  async startDragging() {
    await (await currentWindow())?.startDragging()
  },

  async setTitle(title: string) {
    await (await currentWindow())?.setTitle(title)
  },

  async close() {
    await (await currentWindow())?.close()
  },

  /**
   * Windows 11 原生 Mica 材质背景。
   * 要求窗口 transparent: true，非 Windows 平台是空操作。
   */
  async applyMica(dark: boolean) {
    if (!isTauri()) return
    const win = await currentWindow()
    if (!win) return
    const { Effect, EffectState } = await import('@tauri-apps/api/window')
    await win.setEffects({
      effects: [Effect.Mica],
      state: dark ? EffectState.Active : EffectState.Inactive,
    })
  },
}
