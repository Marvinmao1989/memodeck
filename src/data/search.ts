import type { Database } from 'sql.js'

/**
 * 全文检索：倒排二元组索引。
 *
 * 原理：把待搜索文本切成相邻两字的组合（"交房租" → 交租、房租），
 * 搜索词也做同样切分，取所有二元组的交集即为结果。
 *
 * 为什么不用 FTS5：实测 sql.js 官方发行版（SQLite 3.54.0）没有编译 FTS5，
 * 报 "no such module: fts5"。换一个带 FTS5 的第三方 WASM 构建，等于把
 * 搜索功能押在别人的维护意愿上。自己建索引表任何 SQLite 构建都能跑，
 * 查询走 B-tree 而不是全表扫，将来换 rusqlite 这段逻辑可以原样搬过去。
 *
 * 已知取舍：没有 bm25 相关度排序，命中结果按更新时间稳定排序。
 * 对"我记得写过但忘了标题"这个核心场景够用。
 */

/** 正文索引长度上限，防止超长笔记把索引撑爆 */
export const MAX_INDEXABLE_CONTENT = 2000

/** 单条笔记最多索引多少个二元组 */
export const MAX_GRAMS_PER_NOTE = 600

/**
 * 切分文本为二元组。
 *
 * 归一化：转小写、压缩空白。跨空格的组合跳过 —— 否则索引和查询对
 * "交 房租" 和 "交房租" 的切法会不一致，导致明明有却搜不到。
 */
export function bigrams(text: string, limit = MAX_GRAMS_PER_NOTE): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (normalized.length < 2) return []

  const seen = new Set<string>()
  const out: string[] = []
  const max = Math.min(normalized.length - 1, limit)

  for (let i = 0; i < max; i += 1) {
    const gram = normalized.slice(i, i + 2)
    if (gram.trim().length < 2) continue
    if (seen.has(gram)) continue
    seen.add(gram)
    out.push(gram)
  }
  return out
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * 为一条笔记重建索引。
 * 幂等：先删后插，重复调用不会产生重复行。
 */
export function indexNote(db: Database, noteId: string, title: string, content: string): number {
  removeFromIndex(db, noteId)

  const grams = bigrams(`${title}\n${content.slice(0, MAX_INDEXABLE_CONTENT)}`)
  if (grams.length === 0) return 0

  db.run('BEGIN')
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO note_search (gram, note_id) VALUES (?, ?)')
    try {
      for (const gram of grams) stmt.run([gram, noteId])
    } finally {
      stmt.free()
    }
    db.run('INSERT OR REPLACE INTO search_meta (note_id, grams, indexed_at) VALUES (?, ?, ?)', [
      noteId,
      grams.length,
      Date.now(),
    ])
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }

  return grams.length
}

export function removeFromIndex(db: Database, noteId: string): void {
  db.run('DELETE FROM note_search WHERE note_id = ?', [noteId])
  db.run('DELETE FROM search_meta WHERE note_id = ?', [noteId])
}

/**
 * 搜索笔记 ID。
 *
 * 词长 ≥ 2：走索引，取二元组交集。
 * 词长 = 1：二元组退化，退回 LIKE 扫描。单个字没有二元组可用，
 * 但扫一遍 10 万行也就几十毫秒，可以接受。
 */
export function searchNoteIds(db: Database, query: string, limit = 200): string[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const grams = bigrams(trimmed, 64)

  if (grams.length === 0) {
    const pattern = `%${escapeLike(trimmed.toLowerCase())}%`
    const rows = db.exec(
      `SELECT n.id
         FROM notes n
        WHERE n.deleted_at IS NULL
          AND (lower(n.title) LIKE ? ESCAPE '\\' OR lower(n.content) LIKE ? ESCAPE '\\')
        ORDER BY n.updated_at DESC
        LIMIT ?`,
      [pattern, pattern, limit],
    )
    return flattenIds(rows)
  }

  const placeholders = grams.map(() => '?').join(', ')
  const rows = db.exec(
    `SELECT s.note_id AS id
       FROM note_search s
       JOIN notes n ON n.id = s.note_id
      WHERE s.gram IN (${placeholders})
        AND n.deleted_at IS NULL
      GROUP BY s.note_id
      HAVING COUNT(DISTINCT s.gram) = ?
      ORDER BY n.updated_at DESC
      LIMIT ?`,
    [...grams, grams.length, limit],
  )

  return flattenIds(rows)
}

function flattenIds(rows: { values?: unknown[][] }[]): string[] {
  const first = rows[0]
  if (!first?.values) return []
  return first.values.map((row) => String(row[0]))
}

/**
 * 全量重建索引。
 * 迁移升级或怀疑索引与数据不一致时调用。
 */
export function rebuildSearchIndex(db: Database): number {
  db.run('DELETE FROM note_search')
  db.run('DELETE FROM search_meta')

  const rows = db.exec('SELECT id, title, content FROM notes')
  const first = rows[0]
  if (!first?.values) return 0

  let count = 0
  for (const row of first.values) {
    const id = String(row[0])
    const title = String(row[1] ?? '')
    const content = String(row[2] ?? '')
    if (indexNote(db, id, title, content) > 0) count += 1
  }
  return count
}

/** 索引规模，用于设置页展示与容量预警 */
export function searchIndexStats(db: Database): { notes: number; grams: number } {
  const notes = Number(db.exec('SELECT COUNT(DISTINCT note_id) AS c FROM note_search')[0]?.values[0]?.[0] ?? 0)
  const grams = Number(db.exec('SELECT COUNT(*) AS c FROM note_search')[0]?.values[0]?.[0] ?? 0)
  return { notes, grams }
}
