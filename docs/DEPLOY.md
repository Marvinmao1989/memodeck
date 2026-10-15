# 部署操作手册

沙箱环境访问不到你本机的浏览器会话，所以走 **API 凭证 + 直接协议**，不用点 GUI。

而且不用装任何 CLI：`gh` 和 `supabase` 的二进制在这个环境里下载不到
（GitHub Releases 直连超时），所以脚本用 `curl` + `git` + `pg` 自己实现，
依赖更少，出错信息也更直接。

---

## 需要你提供四个值

### 1. GitHub Token（Fine-grained，别用 Classic）

https://github.com/settings/personal-access-tokens/new

| 项 | 值 |
|---|---|
| Token name | `memodeck-deploy` |
| Expiration | 90 天 |
| Repository access | Only select repositories → 选目标仓库（还没有就先选 All，之后收紧） |
| **Contents** | **Read and write** |
| **Workflows** | **Read and write** |

> **Workflows 这项千万别漏。** 没有它，推 `.github/workflows/` 下的文件会被
> GitHub 直接拒绝，报错还特别含糊。

### 2. Supabase 数据库连接串

Supabase 控制台 → Project Settings → **Database** → Connection string →
URI → 点 **Direct connection**（不是 Session pooler，DDL 用直连更稳）

形如：

```
postgresql://postgres:你的密码@db.xxxxxxxxxxxx.supabase.co:5432/postgres
```

数据库密码在 Database 页可以首次设置。**设了就记好**，丢了只能重置。

### 3. 仓库名（可选）

不填就用 `memodeck`。

### 4. 公开性（可选）

`private`（默认）或 `public`。

---

## 执行

```bash
cd /workspace

export GH_TOKEN='ghp_xxxxxxxx'
export DATABASE_URL='postgresql://postgres:密码@db.xxx.supabase.co:5432/postgres'
export GH_REPO_NAME='memodeck'
export GH_VISIBILITY='private'

./scripts/deploy.sh
```

脚本会：本地校验（typecheck + 测试）→ 建仓 → 推代码 → 连库应用迁移 →
报告 RLS 策略条数。任何一步失败立刻停下并说明原因。

> 建议用平台的加密凭证功能保存 token，而不是明文写进 shell history。
> 平台里创建名为 `GH_TOKEN` 的 secret 后，我可以直接引用 `${GH_TOKEN}`。

---

## 部署后手动确认

### 1. 看 CI 结果（重要）

`https://github.com/<用户名>/memodeck/actions`

**这一步能替你验证 `src-tauri` 的 Rust 代码能不能编译** —— 那是本地缺
webkit2gtk 所以一行都没验证过的部分。编译失败把日志发我。

### 2. 关闭邮箱验证

Supabase → Authentication → Providers → Email → **关掉 Confirm email**

产品决策不做邮件找回密码（PRD F1）。开着的话用户注册后收不到确认邮件，
会卡在"注册成功但登不进去"。

### 3. 拿客户端配置

Project Settings → API → Project URL / anon key

**安全性不依赖 anon key 保密** —— 数据隔离完全由 RLS 保证，key 泄露别人
也读不到你的数据。

---

## 发第一个版本

CI 绿了之后：

```bash
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` 会构建单个 exe 传到 Releases。**不签名**，用户首次运行会看到
SmartScreen 提示，点"更多信息 → 仍要运行"即可。

---

## 故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| GitHub token 无效（API 401） | 过期，或复制时带了换行 | 重新生成，用单引号包住 |
| push 被拒，提到 workflow | token 缺 Workflows 权限 | 重新生成时勾上 |
| `getaddrinfo ENOTFOUND` | 连接串域名写错 | 从控制台重新复制 |
| `password authentication failed` | 数据库密码不对 | Database 页重置密码 |
| RLS 策略数为 0 | 迁移没完整执行 | 看控制台 SQL Editor 里的报错 |
| CI 在 Rust 编译那步红 | `src-tauri` 未经本地验证，大概率要改 | 日志发我 |

---

## 关于 Supabase 免费额度

免费额度项目**连续 7 天低活跃会被自动暂停**，同步随之中断，直到有人打开
控制台点恢复（有一年恢复窗口）。

你们几个朋友如果有一周没人碰，它就悄悄躺了。要么养成至少一个人每周开一次的
习惯，要么上 Pro（$25/月，一次解决）。

---

## 回滚

迁移一旦应用不会自动回退（`0001_init.sql` 里全是 `CREATE TABLE IF NOT EXISTS`）。
重来一遍的话：

```bash
node scripts/apply-migrations.mjs "$DATABASE_URL"   # 已应用过会自动跳过
```

**在有真实用户数据之前**都可以直接删库重来。开始有人用了之后，改 schema
必须走新增迁移的方式，不能重置。
