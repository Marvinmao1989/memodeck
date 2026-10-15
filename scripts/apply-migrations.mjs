/**
 * 应用 supabase/migrations/ 下的迁移。
 *
 * 不用 supabase CLI 是因为沙箱下载不到它的二进制，而 Postgres 协议本身是通的。
 * 这里自己维护迁移记录表，格式与 supabase CLI 的 schema_migrations 对齐，
 * 以后切回官方 CLI 也不会冲突。
 *
 * 用法：node scripts/apply-migrations.mjs "$DATABASE_URL"
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')

const url = process.argv[2]
if (!url) {
  console.error('用法：node scripts/apply-migrations.mjs "$DATABASE_URL"')
  process.exit(1)
}

// 连接串里常带密码，直接打日志会泄漏
function mask(raw) {
  return raw.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')
}

const client = new pg.Client({
  connectionString: url,
  // Supabase 的连接池走 TLS，证书链里有自签 CA 时会失败
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})

try {
  console.log(`连接 ${mask(url)} …`)
  await client.connect()

  // 与 supabase CLI 保持同名同结构，方便以后无缝切回去
  // supabase CLI 会自动创建 supabase_migrations schema，这里手动补上，
  // 否则全新项目首次运行会报 schema does not exist
  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations')
  await client.query(`
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      statements text[],
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await client.query('SELECT version FROM supabase_migrations.schema_migrations')
  const applied = new Set(rows.map((r) => r.version))
  console.log(`已应用迁移：${applied.size ? [...applied].join(', ') : '（无）'}`)

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  let count = 0

  for (const file of files) {
    const version = file.split('_')[0]
    if (applied.has(version)) {
      console.log(`  跳过 ${file}（已应用）`)
      continue
    }

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')

    // 整个迁移放在一个事务里：失败不会留下"应用了一半"的库
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)',
        [version, file],
      )
      await client.query('COMMIT')
      console.log(`  ✓ 已应用 ${file}`)
      count += 1
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`  ✗ ${file} 失败：${err.message}`)
      throw err
    }
  }

  if (count === 0) console.log('没有需要应用的迁移')
  else console.log(`完成，新增 ${count} 个迁移`)

  // 顺手报一下 RLS 是否真的生效 —— 这是数据隔离的底线，值得每次都确认
  const { rows: rls } = await client.query(`
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
     ORDER BY tablename
  `)
  console.log(`\n已启用的 RLS 策略（${rls.length} 条）：`)
  for (const p of rls) console.log(`  ${p.tablename} → ${p.policyname}`)

  if (rls.length === 0) {
    console.error('\n警告：一条 RLS 策略都没有，数据隔离没有生效，请检查迁移是否完整执行')
    process.exit(1)
  }
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
