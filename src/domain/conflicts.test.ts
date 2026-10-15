import { describe, expect, it } from 'vitest'
import { mergeNotes, mergeWithPendingOps } from './conflicts'
import { isUlid, newDeviceId, ulid } from './ulid'
import { makeNote } from '@/test/factories'

// 两个可区分的时间戳：谁更新就归谁
const T1 = 1_000
const T2 = 2_000

describe('字段级 LWW 合并', () => {

  it('不同字段的并发修改都保留下来', () => {
    // 手机 10:00 改标题
    const local = makeNote({
      title: '交房租（含物业）',
      content: '原来的正文',
      fieldTimestamps: { title: T2, content: T1 },
      updatedAt: T2,
    })
    // 电脑 10:05 改正文，但标题还是旧的
    const remote = makeNote({
      title: '交房租',
      content: '账号是 12345',
      fieldTimestamps: { title: T1, content: T2 },
      updatedAt: T2,
    })

    const { note, overwritten } = mergeNotes(local, remote)

    expect(note.title).toBe('交房租（含物业）') // 本地较新，保留
    expect(note.content).toBe('账号是 12345') // 远端较新，采纳
    // 标题被本地保住，正文被远端覆盖 —— 只有 content 进了 overwritten 列表
    expect(overwritten.map((c) => c.field)).toEqual(['content'])
  })

  it('同一字段的并发修改以较新者为准，并记录冲突', () => {
    const local = makeNote({ title: '本地标题', fieldTimestamps: { title: T1 } })
    const remote = makeNote({ title: '远端标题', fieldTimestamps: { title: T2 } })

    const { note, overwritten } = mergeNotes(local, remote)

    expect(note.title).toBe('远端标题')
    expect(overwritten).toEqual([{ field: 'title', localValue: '本地标题', remoteValue: '远端标题' }])
  })

  it('时间戳打平时以远端为准（服务端是权威副本）', () => {
    const local = makeNote({ title: '本地', fieldTimestamps: { title: T1 } })
    const remote = makeNote({ title: '远端', fieldTimestamps: { title: T1 } })

    expect(mergeNotes(local, remote).note.title).toBe('远端')
  })

  it('缺少字段时间戳时退回记录创建时间', () => {
    const local = makeNote({ title: '本地', createdAt: 1_500, fieldTimestamps: {} })
    const remote = makeNote({ title: '远端', createdAt: 1_200, fieldTimestamps: {} })

    expect(mergeNotes(local, remote).note.title).toBe('本地')
  })

  it('值相同的字段不产生冲突，时间戳取较晚者', () => {
    const local = makeNote({ title: '一样', fieldTimestamps: { title: T1 } })
    const remote = makeNote({ title: '一样', fieldTimestamps: { title: T2 } })

    const { note, overwritten } = mergeNotes(local, remote)

    expect(overwritten).toEqual([])
    expect(note.fieldTimestamps.title).toBe(T2)
  })

  it('null 与有值算真实差异', () => {
    const local = makeNote({ color: '#FF0000', fieldTimestamps: { color: T1 } })
    const remote = makeNote({ color: null, fieldTimestamps: { color: T2 } })

    const { note, overwritten } = mergeNotes(local, remote)
    expect(note.color).toBeNull()
    expect(overwritten).toHaveLength(1)
  })

  it('合并后 rev 递增，updatedAt 取较晚', () => {
    const local = makeNote({ rev: 3, updatedAt: T1 })
    const remote = makeNote({ rev: 5, updatedAt: T2 })

    const { note } = mergeNotes(local, remote)
    expect(note.rev).toBe(6)
    expect(note.updatedAt).toBe(T2)
  })

  it('id 不一致直接报错', () => {
    expect(() => mergeNotes(makeNote({ id: 'A' }), makeNote({ id: 'B' }))).toThrow(/id 不一致/)
  })

  it('userId 不一致直接报错 —— 跨用户合并是数据隔离红线', () => {
    expect(() => mergeNotes(makeNote({ userId: 'u1' }), makeNote({ userId: 'u2' }))).toThrow(/userId 不一致/)
  })
})

describe('合并时考虑本地未同步的修改', () => {
  it('本地还有待推送修改的字段，远端不能覆盖它', () => {
    const local = makeNote({ title: '本地刚改的', fieldTimestamps: { title: T1 } })
    const remote = makeNote({ title: '远端旧的', fieldTimestamps: { title: 9_999 } })

    const pending = new Set(['title'] as const)
    const { note } = mergeWithPendingOps(local, remote, pending)

    expect(note.title).toBe('本地刚改的')
  })

  it('没有待推送修改的字段照常合并', () => {
    const local = makeNote({ title: '本地', fieldTimestamps: { title: 1 } })
    const remote = makeNote({ title: '远端', fieldTimestamps: { title: 9_999 } })

    expect(mergeWithPendingOps(local, remote, new Set()).note.title).toBe('远端')
  })
})

describe('ULID', () => {
  it('长度 26 且格式合法', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
  })

  it('不含 Crockford 基础32里易混淆的 I L O U', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(ulid()).not.toMatch(/[ILOU]/)
    }
  })

  it('同一毫秒内长度一致且唯一', () => {
    const fixed = 1_700_000_000_000
    const ids = new Set(Array.from({ length: 500 }, () => ulid(fixed)))
    expect(ids.size).toBe(500)
    // 时间戳部分相同
    expect(ulid(fixed).slice(0, 10)).toBe(ulid(fixed).slice(0, 10))
  })

  it('字典序跟随时间戳', () => {
    const earlier = ulid(1_700_000_000_000)
    const later = ulid(1_700_000_001_000)
    expect(earlier < later).toBe(true)
  })

  it('拒绝非法输入', () => {
    expect(isUlid('太短')).toBe(false)
    expect(isUlid('01M4YE76X2N5WSBMTVD6YPHV7I')).toBe(false) // I 不在字符表内
    expect(isUlid('')).toBe(false)
  })

  it('设备 id 带前缀', () => {
    expect(newDeviceId().startsWith('dev_')).toBe(true)
  })
})
