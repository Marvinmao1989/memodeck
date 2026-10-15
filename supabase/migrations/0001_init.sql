-- MemoDeck 服务端 schema（Supabase / PostgreSQL）
--
-- 与本地 SQLite（src/data/migrations.ts）保持结构一致，但有三点不同：
--   1. id 用 UUID 而不是 ULID —— 服务端是权威副本，ULID 的时间序优势用不上
--   2. 多一个 server_seq 单调递增列，作为增量拉取的游标
--   3. 每个表都开 RLS，隔离下沉到数据库（PRD §2.3）
--
-- 应用里只嵌入 Supabase 的 anon key。安全性完全由下面的 RLS 策略保证：
-- 即使 anon key 泄露，攻击者也读不到任何人的数据。

-- ---------------------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  note_type        text NOT NULL CHECK (note_type IN ('todo', 'memo', 'event')),
  title            text NOT NULL DEFAULT '',
  content          text NOT NULL DEFAULT '',
  status           text CHECK (status IN ('open', 'doing', 'done', 'archived')),
  priority         integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  list_id          uuid,
  start_at         timestamptz,
  end_at           timestamptz,
  due_at           timestamptz,
  all_day          boolean NOT NULL DEFAULT false,
  repeat_rule      text,
  remind_at        timestamptz,
  remind_repeat    text,
  color            text,
  parent_id        uuid,
  sort_order       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  rev              integer NOT NULL DEFAULT 1,
  device_id        text NOT NULL,
  field_timestamps jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 增量拉取游标，由下面的 trigger 从序列取值，不要手工写入
  server_seq       bigint
);

-- 单调递增游标。不能用 updated_at —— 两台设备的时间戳可能相同或存在时钟漂移
CREATE SEQUENCE IF NOT EXISTS public.notes_seq;

CREATE OR REPLACE FUNCTION public.notes_set_seq()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.server_seq := nextval('public.notes_seq');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_set_seq_trg ON public.notes;
CREATE TRIGGER notes_set_seq_trg
  BEFORE INSERT OR UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.notes_set_seq();

-- 必须在列存在之后建索引
CREATE INDEX IF NOT EXISTS idx_notes_user_seq ON public.notes (user_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_notes_due      ON public.notes (user_id, due_at);

-- lists / tags 结构与本地一致，同样开 RLS
CREATE TABLE IF NOT EXISTS public.lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text,
  sort_order text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tags (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name    text NOT NULL,
  color   text,
  UNIQUE (user_id, name)
);

-- 冲突副本：本地 LWW 覆盖时把被淘汰的一方报上来，供多设备查看
CREATE TABLE IF NOT EXISTS public.conflict_copies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  entity       text NOT NULL,
  entity_id    uuid NOT NULL,
  field        text NOT NULL,
  local_value  jsonb,
  remote_value jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved     boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- 操作日志（同步引擎的服务端一半）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_oplog (
  seq       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  entity    text NOT NULL,
  entity_id uuid NOT NULL,
  op_type   text NOT NULL CHECK (op_type IN ('upsert', 'delete')),
  fields    text[] NOT NULL DEFAULT '{}',
  payload   jsonb,
  ts        timestamptz NOT NULL DEFAULT now(),
  -- 客户端生成的幂等键
  op_id     text NOT NULL,
  -- 幂等的关键：同一个 op_id 重复推送不会产生副作用，
  -- 断网重试、用户手点两次"同步"都安全
  CONSTRAINT server_oplog_idempotency UNIQUE (user_id, op_id)
);

CREATE INDEX IF NOT EXISTS idx_oplog_user_seq ON public.server_oplog (user_id, seq);

-- ---------------------------------------------------------------------------
-- 行级安全
--
-- 统一策略：只看得到 auth.uid() 自己的数据。
-- 这不是应用层的"记得加 WHERE"——即使代码写漏了、或者有人拿 anon key
-- 直接调 PostgREST，也绕不过去。
-- ---------------------------------------------------------------------------

ALTER TABLE public.notes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lists            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conflict_copies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_oplog     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notes_own_only ON public.notes;
CREATE POLICY notes_own_only ON public.notes
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lists_own_only ON public.lists;
CREATE POLICY lists_own_only ON public.lists
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS tags_own_only ON public.tags;
CREATE POLICY tags_own_only ON public.tags
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS conflicts_own_only ON public.conflict_copies;
CREATE POLICY conflicts_own_only ON public.conflict_copies
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS oplog_own_only ON public.server_oplog;
CREATE POLICY oplog_own_only ON public.server_oplog
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 同步 RPC
--
-- 做成函数而不是让客户端直接写表有两个原因：
--   1. 幂等去重要在同一事务里完成，客户端循环重试才不会写脏
--   2. server_oplog 的写入与应用层保证原子，否则会丢变更
-- ---------------------------------------------------------------------------

-- 推送本地待同步的变更。
-- 返回值：本次成功入账的操作数（客户端据此清空本地 oplog）
CREATE OR REPLACE FUNCTION public.push_ops(p_ops jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  uid     uuid := auth.uid();
  op      jsonb;
  applied integer := 0;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  FOR op IN SELECT * FROM jsonb_array_elements(p_ops)
  LOOP
    -- ON CONFLICT DO NOTHING 就是幂等的实现：重复推送静默跳过
    INSERT INTO public.server_oplog (user_id, entity, entity_id, op_type, op_id, payload)
    VALUES (
      uid,
      op->>'entity',
      (op->>'entity_id')::uuid,
      op->>'op_type',
      op->>'op_id',
      op->'payload'
    )
    ON CONFLICT (user_id, op_id) DO NOTHING;

    IF FOUND THEN
      applied := applied + 1;

      IF op->>'op_type' = 'upsert' THEN
        INSERT INTO public.notes AS t (
          id, user_id, note_type, title, content, status, priority,
          list_id, start_at, end_at, due_at, all_day, repeat_rule,
          remind_at, remind_repeat, color, parent_id, sort_order,
          created_at, updated_at, deleted_at, rev, device_id, field_timestamps
        )
        SELECT
          (op->'payload'->>'id')::uuid,
          uid,
          op->'payload'->>'note_type',
          op->'payload'->>'title',
          op->'payload'->>'content',
          op->'payload'->>'status',
          (op->'payload'->>'priority')::integer,
          NULLIF(op->'payload'->>'list_id', '')::uuid,
          (op->'payload'->>'start_at')::timestamptz,
          (op->'payload'->>'end_at')::timestamptz,
          (op->'payload'->>'due_at')::timestamptz,
          (op->'payload'->>'all_day')::boolean,
          op->'payload'->>'repeat_rule',
          (op->'payload'->>'remind_at')::timestamptz,
          op->'payload'->>'remind_repeat',
          op->'payload'->>'color',
          NULLIF(op->'payload'->>'parent_id', '')::uuid,
          op->'payload'->>'sort_order',
          (op->'payload'->>'created_at')::timestamptz,
          (op->'payload'->>'updated_at')::timestamptz,
          (op->'payload'->>'deleted_at')::timestamptz,
          (op->'payload'->>'rev')::integer,
          op->'payload'->>'device_id',
          COALESCE((op->'payload'->'field_timestamps')::jsonb, '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          title            = EXCLUDED.title,
          content          = EXCLUDED.content,
          status           = EXCLUDED.status,
          priority         = EXCLUDED.priority,
          start_at         = EXCLUDED.start_at,
          end_at           = EXCLUDED.end_at,
          due_at           = EXCLUDED.due_at,
          all_day          = EXCLUDED.all_day,
          repeat_rule      = EXCLUDED.repeat_rule,
          remind_at        = EXCLUDED.remind_at,
          remind_repeat    = EXCLUDED.remind_repeat,
          color            = EXCLUDED.color,
          parent_id        = EXCLUDED.parent_id,
          sort_order       = EXCLUDED.sort_order,
          updated_at       = EXCLUDED.updated_at,
          deleted_at       = EXCLUDED.deleted_at,
          rev              = EXCLUDED.rev,
          device_id        = EXCLUDED.device_id,
          field_timestamps = EXCLUDED.field_timestamps,
          -- 关键的服务端裁决：只有时间戳更新的那次写入才算数。
          -- 这条 WHERE 让"旧设备上的过期数据"无法覆盖新值。
          server_seq       = nextval('public.notes_seq')
        WHERE EXCLUDED.updated_at > public.notes.updated_at;

      ELSIF op->>'op_type' = 'delete' THEN
        -- 软删除，保留 30 天供回收站使用
        UPDATE public.notes
           SET deleted_at = COALESCE(deleted_at, now()),
               updated_at = now(),
               server_seq = nextval('public.notes_seq')
         WHERE id = (op->>'entity_id')::uuid AND user_id = uid;
      END IF;
    END IF;
  END LOOP;

  RETURN applied;
END;
$$;

-- 拉取游标之后的变更。
-- 同时返回新的游标，客户端把它存下来，下次从这里继续。
CREATE OR REPLACE FUNCTION public.pull_changes(p_after bigint, p_limit integer DEFAULT 500)
RETURNS TABLE (seq bigint, entity text, entity_id uuid, op_type text, payload jsonb)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT o.seq, o.entity, o.entity_id, o.op_type, o.payload
    FROM public.server_oplog o
   WHERE o.user_id = auth.uid()
     AND o.seq > p_after
   ORDER BY o.seq ASC
   LIMIT LEAST(p_limit, 1000);
$$;

-- 首次登录的整包拉取
CREATE OR REPLACE FUNCTION public.pull_full()
RETURNS TABLE (
  id uuid, note_type text, title text, content text, status text,
  priority integer, list_id uuid, start_at timestamptz, end_at timestamptz,
  due_at timestamptz, all_day boolean, repeat_rule text, remind_at timestamptz,
  remind_repeat text, color text, parent_id uuid, sort_order text,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz,
  rev integer, device_id text, field_timestamps jsonb
)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT n.id, n.note_type, n.title, n.content, n.status, n.priority,
         n.list_id, n.start_at, n.end_at, n.due_at, n.all_day, n.repeat_rule,
         n.remind_at, n.remind_repeat, n.color, n.parent_id, n.sort_order,
         n.created_at, n.updated_at, n.deleted_at, n.rev, n.device_id,
         n.field_timestamps
    FROM public.notes n
   WHERE n.user_id = auth.uid();
$$;

-- 当前用户已推送到的最大游标，首次登录后用它初始化本地 sync_cursor
CREATE OR REPLACE FUNCTION public.current_cursor()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(MAX(o.seq), 0)
    FROM public.server_oplog o
   WHERE o.user_id = auth.uid();
$$;
