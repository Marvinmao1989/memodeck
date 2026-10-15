import type { Database } from 'sql.js'

/**
 * 版本化数据库迁移。
 *
 * 每个迁移只做"加东西"（加表、加列、加索引），不做破坏性变更 ——
 * 破坏性变更需要在下一版写数据搬迁脚本，并在搬迁完成前保持新旧列共存。
 *
 * 永远不要修改已发布的迁移，只能追加新的。已发出去的 exe 里跑的是旧版本，
 * 改了旧迁移会导致不同用户本地库结构不一致。
 */

export interface Migration {
  version: number
  name: string
  up: (db: Database) => void
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        -- 单表承载全部笔记类型（待办 / 备忘 / 事件），见 PRD §2.1
        CREATE TABLE notes (
          id             TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL,
          note_type      TEXT NOT NULL CHECK (note_type IN ('todo','memo','event')),
          title          TEXT NOT NULL DEFAULT '',
          content        TEXT NOT NULL DEFAULT '',
          status         TEXT CHECK (status IN ('open','doing','done','archived')),
          priority       INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
          list_id        TEXT,
          start_at       INTEGER,
          end_at         INTEGER,
          due_at         INTEGER,
          all_day        INTEGER NOT NULL DEFAULT 0,
          repeat_rule    TEXT,
          remind_at      INTEGER,
          remind_repeat  TEXT,
          color          TEXT,
          parent_id      TEXT,
          sort_order     TEXT,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          deleted_at     INTEGER,
          rev            INTEGER NOT NULL DEFAULT 1,
          device_id      TEXT NOT NULL,
          -- 每个用户可见字段的最后修改时间戳，字段级 LWW 的前提（PRD §2.3）
          field_timestamps TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX idx_notes_type     ON notes(user_id, note_type, deleted_at);
        CREATE INDEX idx_notes_due      ON notes(user_id, due_at);
        CREATE INDEX idx_notes_start    ON notes(user_id, start_at);
        CREATE INDEX idx_notes_parent   ON notes(parent_id);
        CREATE INDEX idx_notes_updated  ON notes(updated_at);

        CREATE TABLE lists (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL,
          name       TEXT NOT NULL,
          color      TEXT,
          sort_order TEXT
        );
        CREATE INDEX idx_lists_user ON lists(user_id, sort_order);

        CREATE TABLE tags (
          id      TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name    TEXT NOT NULL,
          color   TEXT,
          UNIQUE (user_id, name)
        );

        CREATE TABLE note_tags (
          note_id TEXT NOT NULL,
          tag_id  TEXT NOT NULL,
          PRIMARY KEY (note_id, tag_id)
        );
        CREATE INDEX idx_note_tags_tag ON note_tags(tag_id);

        -- 同步引擎：本地操作日志。ops 表的写入与业务表写入在同一事务内完成，
        -- 保证"改了数据但没记日志"这种不一致不可能发生。
        CREATE TABLE oplog (
          op_id     TEXT PRIMARY KEY,
          entity    TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          op_type   TEXT NOT NULL CHECK (op_type IN ('upsert','delete')),
          fields    TEXT NOT NULL DEFAULT '[]',
          payload   TEXT,
          ts        INTEGER NOT NULL,
          synced    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_oplog_pending ON oplog(synced, ts);

        -- LWW 覆盖时保留被淘汰的一方，供用户在设置里查看
        CREATE TABLE conflict_copies (
          id           TEXT PRIMARY KEY,
          entity       TEXT NOT NULL,
          entity_id    TEXT NOT NULL,
          field        TEXT NOT NULL,
          local_value  TEXT,
          remote_value TEXT,
          created_at   INTEGER NOT NULL,
          resolved     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_conflict_unresolved ON conflict_copies(resolved, created_at);

        -- 单实例锁：防止用户把 exe 复制多份后同时打开同一个库文件
        CREATE TABLE instance_lock (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          pid        INTEGER NOT NULL,
          started_at INTEGER NOT NULL
        );

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    },
  },

  {
    version: 2,
    name: 'search_bigram_index',
    up: (db) => {
      // 为什么不用 FTS5：
      //   原本计划用 FTS5 + trigram 分词器做中文全文检索，但实测 sql.js
      //   官方发行版**没有编译 FTS5**（SQLite 3.54.0，报 "no such module: fts5"）。
      //   换用带 FTS5 的第三方 WASM 构建等于把核心功能押在一个小众依赖的
      //   维护意愿上。
      //
      // 改用倒排二元组索引（inverted bigram index）：把标题和正文切成
      // 相邻两字的组合存进索引表，查询时把搜索词同样切成二元组，
      // 取交集。这是 FTS5 n-gram 分词的等价实现，且：
      //   - 任何 SQLite 构建都能跑，不依赖特定发行版
      //   - 查询走 B-tree 索引，不是全表扫
      //   - 将来换 rusqlite 时这段逻辑可以原样搬过去
      //
      // 代价：没有 bm25 相关度排序（结果按 id 稳定排序），
      // 存储占用比 FTS5 大约多 30%。对备忘录场景可以接受。
      db.exec(`
        CREATE TABLE note_search (
          gram    TEXT NOT NULL,
          note_id TEXT NOT NULL,
          PRIMARY KEY (gram, note_id)
        ) WITHOUT ROWID;

        CREATE INDEX idx_note_search_note ON note_search (note_id);
      `)

      // 索引由应用层维护（src/data/search.ts）。
      // 不用触发器：生成二元组需要业务逻辑（去重、截断），
      // 塞进 SQL 的自定义函数既慢又难维护。
      db.exec(`
        CREATE TABLE search_meta (
          note_id TEXT PRIMARY KEY,
          grams   INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        );
      `)
    },
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

/**
 * 执行尚未应用的迁移。
 * @returns 迁移完成后的 schema 版本号
 */
export function migrate(db: Database, log?: (msg: string) => void): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const applied = new Set(
    db
      .exec('SELECT version FROM schema_migrations')
      .flatMap((row) => row.values)
      .map(([v]) => Number(v)),
  )

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version)

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue

    // 迁移与版本记录包在一个事务里：失败不会留下"迁移了一半"的库
    db.run('BEGIN')
    try {
      migration.up(db)
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now(),
      ])
      db.run('COMMIT')
      log?.(`已应用迁移 v${migration.version} ${migration.name}`)
    } catch (err) {
      db.run('ROLLBACK')
      throw new Error(`迁移 v${migration.version} (${migration.name}) 失败: ${String(err)}`)
    }
  }

  return currentVersion(db)
}

export function currentVersion(db: Database): number {
  try {
    const result = db.exec('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    return Number(result[0]?.values[0]?.[0] ?? 0)
  } catch {
    // 表还没建（首次 migrate 之前）时视作 0
    return 0
  }
}

/**
 * 检查运行期依赖的 SQLite 能力。
 *
 * 曾经这里检查 FTS5，实测 sql.js 官方发行版不带 FTS5，
 * 现在的搜索走自建的二元组索引，只依赖最基础的 SQL。
 * 这里保留一个最轻的探针，确保数据库本身是可用的。
 */
export function assertCapabilities(db: Database): void {
  let version = ''
  try {
    version = String(db.exec('SELECT sqlite_version()')[0]?.values[0]?.[0] ?? '')
  } catch (err) {
    throw new Error(`SQLite 不可用：${String(err)}`)
  }

  // WITHOUT ROWID 是索引表的基础语法，缺了说明这不是一个正常的 SQLite 构建
  try {
    db.exec('CREATE TABLE temp.__probe (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID')
    db.exec('DROP TABLE temp.__probe')
  } catch (err) {
    throw new Error(`当前 SQLite 构建异常（版本 ${version}），索引表无法创建：${String(err)}`)
  }
}
