import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, TEST_DEVICE, TEST_USER } from '@/test/harness'
import {
  countNotes,
  createNote,
  getNote,
  listNotes,
  purgeNote,
  restoreNote,
  searchNotes,
  softDeleteNote,
  updateNote,
} from './noteRepository'
import { rebuildSearchIndex, searchIndexStats } from './search'
import { PRIORITY } from '@/domain/types'

describe('笔记仓库', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    db = await createTestDb()
  })

  describe('createNote', () => {
    it('创建后字段完整、默认值正确', () => {
      const note = createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '交房租',
      })

      expect(note.title).toBe('交房租')
      expect(note.noteType).toBe('todo')
      expect(note.status).toBe('open')
      expect(note.priority).toBe(PRIORITY.NONE)
      expect(note.rev).toBe(1)
      expect(note.deletedAt).toBeNull()
      expect(note.deviceId).toBe(TEST_DEVICE)
    })

    it('每个可同步字段都有创建时间戳', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: 'x' })
      expect(note.fieldTimestamps.title).toBe(note.createdAt)
      expect(note.fieldTimestamps.priority).toBe(note.createdAt)
      expect(note.fieldTimestamps.content).toBe(note.createdAt)
    })

    it('能按 id 原样读回', () => {
      const created = createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '回邮件',
        priority: PRIORITY.HIGH,
        dueAt: 1_700_000_000_000,
      })

      const loaded = getNote(db.handle.db, created.id)
      expect(loaded).toEqual(created)
    })
  })

  describe('操作日志', () => {
    it('创建会写入一条待同步的 oplog', () => {
      createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '买菜' })

      const rows = db.handle.db.exec('SELECT entity, op_type, synced FROM oplog')
      expect(rows[0]?.values.length).toBe(1)
      expect(rows[0]?.values[0]).toEqual(['notes', 'upsert', 0])
    })

    it('数据写入和日志写入在同一事务 —— 业务失败时都不留痕', () => {
      // 构造一个必然失败的场景：先插入一条违反约束的数据
      db.handle.db.run("INSERT INTO notes (id, user_id, note_type, created_at, updated_at, device_id) VALUES ('dup','u','todo',1,1,'d')")

      const before = db.handle.db.exec('SELECT COUNT(*) FROM oplog')[0]?.values[0]?.[0]

      expect(() =>
        createNote(db.handle.db, {
          userId: TEST_USER,
          deviceId: TEST_DEVICE,
          noteType: '不存在的类型' as never,
        }),
      ).toThrow()

      const after = db.handle.db.exec('SELECT COUNT(*) FROM oplog')[0]?.values[0]?.[0]
      // 事务回滚后日志条数必须不变，否则会出现"记了日志但数据没写"
      expect(after).toBe(before)
    })
  })

  describe('updateNote', () => {
    it('只给真正改动的字段打新时间戳', async () => {
      const note = createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '交房租',
        content: '正文',
      })

      await new Promise((r) => setTimeout(r, 5))
      const updated = updateNote(db.handle.db, note.id, { title: '交房租（含物业）' }, TEST_DEVICE)

      expect(updated?.title).toBe('交房租（含物业）')
      // title 是新时间，content 必须保持创建时的时间 ——
      // 这正是字段级 LWW 成立的前提
      expect(updated?.fieldTimestamps.title).toBeGreaterThan(note.fieldTimestamps.title!)
      expect(updated?.fieldTimestamps.content).toBe(note.fieldTimestamps.content)
    })

    it('值没变时不更新时间戳，也不写日志', () => {
      const note = createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '原标题',
      })

      const logsBefore = db.handle.db.exec('SELECT COUNT(*) FROM oplog')[0]?.values[0]?.[0]
      const same = updateNote(db.handle.db, note.id, { title: '原标题' }, TEST_DEVICE)
      const logsAfter = db.handle.db.exec('SELECT COUNT(*) FROM oplog')[0]?.values[0]?.[0]

      expect(same?.fieldTimestamps.title).toBe(note.fieldTimestamps.title)
      expect(logsAfter).toBe(logsBefore)
    })

    it('rev 每次更新递增', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: 'a' })
      const u1 = updateNote(db.handle.db, note.id, { title: 'b' }, TEST_DEVICE)
      const u2 = updateNote(db.handle.db, note.id, { title: 'c' }, TEST_DEVICE)

      expect(u1?.rev).toBe(2)
      expect(u2?.rev).toBe(3)
    })

    it('更新的 oplog 只记录改动的字段', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: 'a' })
      updateNote(db.handle.db, note.id, { title: 'b', priority: PRIORITY.HIGH }, TEST_DEVICE)

      const rows = db.handle.db.exec("SELECT fields FROM oplog WHERE op_type='upsert' ORDER BY rowid DESC")
      const fields = JSON.parse(String(rows[0]?.values[0]?.[0])) as string[]
      expect(fields.sort()).toEqual(['priority', 'title'])
    })

    it('更新不存在的记录返回 null', () => {
      expect(updateNote(db.handle.db, 'nope', { title: 'x' }, TEST_DEVICE)).toBeNull()
    })

    it('拒绝写入非白名单字段', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: 'a' })
      const hacked = updateNote(
        db.handle.db,
        note.id,
        { userId: 'someone-else', deviceId: 'attacker' } as never,
        TEST_DEVICE,
      )
      // userId / deviceId 不在 SYNCED_FIELDS 里，必须被忽略
      expect(hacked?.userId).toBe(TEST_USER)
      expect(hacked?.deviceId).toBe(TEST_DEVICE)
    })
  })

  describe('删除与回收站', () => {
    it('软删除后不出现在默认列表里', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '要删的' })
      softDeleteNote(db.handle.db, note.id)

      expect(listNotes(db.handle.db, {}, TEST_USER)).toHaveLength(0)
      expect(listNotes(db.handle.db, { includeDeleted: true }, TEST_USER)).toHaveLength(1)
      expect(getNote(db.handle.db, note.id)?.deletedAt).toBeGreaterThan(0)
    })

    it('可以恢复', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '要删的' })
      softDeleteNote(db.handle.db, note.id)
      const restored = restoreNote(db.handle.db, note.id)

      expect(restored?.deletedAt).toBeNull()
      expect(listNotes(db.handle.db, {}, TEST_USER)).toHaveLength(1)
    })

    it('彻底删除会清掉索引和日志', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '消失的' })
      purgeNote(db.handle.db, note.id)

      expect(getNote(db.handle.db, note.id)).toBeNull()
      expect(searchIndexStats(db.handle.db).notes).toBe(0)
      expect(db.handle.db.exec('SELECT COUNT(*) FROM oplog')[0]?.values[0]?.[0]).toBe(0)
    })
  })

  describe('listNotes 筛选', () => {
    beforeEach(() => {
      createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '高优先级', priority: PRIORITY.HIGH })
      createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '低优先级', priority: PRIORITY.LOW })
      createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        noteType: 'memo',
        title: '一条备忘',
      })
    })

    it('按类型筛选', () => {
      const memos = listNotes(db.handle.db, { noteType: 'memo' }, TEST_USER)
      expect(memos).toHaveLength(1)
      expect(memos[0]?.title).toBe('一条备忘')
    })

    it('按等级筛选', () => {
      const high = listNotes(db.handle.db, { priority: [PRIORITY.HIGH] }, TEST_USER)
      expect(high).toHaveLength(1)
      expect(high[0]?.title).toBe('高优先级')
    })

    it('始终排除其他用户的数据', () => {
      createNote(db.handle.db, { userId: 'other-user', deviceId: 'd', title: '别人的' })
      expect(listNotes(db.handle.db, {}, TEST_USER)).toHaveLength(3)
      expect(countNotes(db.handle.db, TEST_USER)).toBe(3)
      expect(countNotes(db.handle.db)).toBe(4)
    })
  })

  describe('中文搜索', () => {
    beforeEach(() => {
      createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '交房租',
        content: '记得交这个月房租和水电费',
      })
      createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '回邮件',
        content: '给张三回复上周的邮件',
      })
      createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: 'Buy milk',
        content: 'shopping list: milk, eggs',
      })
    })

    it('搜中文词命中标题和正文', () => {
      expect(searchNotes(db.handle.db, '房租', {}, TEST_USER).map((n) => n.title)).toEqual(['交房租'])
      expect(searchNotes(db.handle.db, '水电费', {}, TEST_USER).map((n) => n.title)).toEqual(['交房租'])
      expect(searchNotes(db.handle.db, '张三', {}, TEST_USER).map((n) => n.title)).toEqual(['回邮件'])
    })

    it('跨标题与正文组合命中', () => {
      const hits = searchNotes(db.handle.db, '交房租', {}, TEST_USER)
      expect(hits).toHaveLength(1)
    })

    it('搜英文大小写不敏感', () => {
      expect(searchNotes(db.handle.db, 'milk', {}, TEST_USER).map((n) => n.title)).toEqual(['Buy milk'])
      expect(searchNotes(db.handle.db, 'MILK', {}, TEST_USER)).toHaveLength(1)
    })

    it('单字查询退回 LIKE 扫描', () => {
      expect(searchNotes(db.handle.db, '房', {}, TEST_USER).map((n) => n.title)).toEqual(['交房租'])
    })

    it('搜不到时返回空数组而不是报错', () => {
      expect(searchNotes(db.handle.db, '完全不存在的内容', {}, TEST_USER)).toEqual([])
      expect(searchNotes(db.handle.db, '', {}, TEST_USER)).toEqual([])
    })

    it('内容更新后索引跟着更新', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '临时' })
      expect(searchNotes(db.handle.db, '报销', {}, TEST_USER)).toHaveLength(0)

      updateNote(db.handle.db, note.id, { title: '报销单据' }, TEST_DEVICE)

      expect(searchNotes(db.handle.db, '报销', {}, TEST_USER).map((n) => n.id)).toEqual([note.id])
      expect(searchNotes(db.handle.db, '临时', {}, TEST_USER)).toHaveLength(0)
    })

    it('软删除后搜不到', () => {
      const note = createNote(db.handle.db, { userId: TEST_USER, deviceId: TEST_DEVICE, title: '一次性' })
      softDeleteNote(db.handle.db, note.id)
      expect(searchNotes(db.handle.db, '一次性', {}, TEST_USER)).toHaveLength(0)
    })

    it('重建索引后结果不变', () => {
      const before = searchNotes(db.handle.db, '房租', {}, TEST_USER).map((n) => n.id)
      const count = rebuildSearchIndex(db.handle.db)
      const after = searchNotes(db.handle.db, '房租', {}, TEST_USER).map((n) => n.id)

      expect(after).toEqual(before)
      expect(count).toBe(3)
    })

    it('搜索结果遵守等级筛选', () => {
      const note = createNote(db.handle.db, {
        userId: TEST_USER,
        deviceId: TEST_DEVICE,
        title: '紧急报销',
        priority: PRIORITY.HIGH,
      })
      expect(searchNotes(db.handle.db, '报销', { priority: [PRIORITY.HIGH] }, TEST_USER).map((n) => n.id)).toEqual([
        note.id,
      ])
      expect(searchNotes(db.handle.db, '报销', { priority: [PRIORITY.LOW] }, TEST_USER)).toHaveLength(0)
    })
  })
})
