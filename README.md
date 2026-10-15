# MemoDeck

Windows 桌面悬浮备忘录。待办、备忘、日历、提醒，多设备登录同步。

完整的产品与技术决策见 [docs/PRD.md](docs/PRD.md)。这份 README 只讲怎么跑起来。

---

## 当前进度

| 里程碑 | 状态 |
|---|---|
| M0 脚手架 / 单 exe / SQLite / 托盘 / 悬浮窗外壳 | 🟡 前端完成，Rust 侧未编译验证 |
| M1 待办 CRUD + 等级 + 状态 + 快速输入 | ✅ 完成，67 个测试 |
| M2 详情面板 / Markdown / 备忘录 / 搜索 / 回收站 | 🟡 搜索与回收站完成，Markdown 编辑器待做 |
| M3 日历 / 重复规则 | ⬜ 未开始 |
| M4 Windows 通知 | ⬜ 未开始 |
| M5 后端 + 用户管理 + 同步 | 🟡 schema 与 RPC 已写，客户端未接 |
| M6 免安装迁移闭环 | ⬜ 未开始 |
| M7 视觉打磨 | 🟡 基础规范已落地 |

---

## 快速开始

```bash
npm install
npm run dev          # 浏览器打开 http://localhost:1420
npm test             # 单元测试
npm run typecheck    # 类型检查
```

浏览器里跑会自动退回 localStorage 存储，**数据不会丢**，可以当本地小工具直接用。

跑桌面版需要 Rust 工具链：

```bash
npm install
npm run tauri dev
```

---

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri 2（Rust）+ WebView2 |
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4 |
| 状态 | Zustand |
| 本地存储 | SQLite（sql.js / WASM） |
| 服务端 | Supabase（Postgres + Auth + RLS） |
| 搜索 | 自建倒排二元组索引 |
| 分发 | GitHub Releases（单 exe，免安装） |

**为什么不用 FTS5**：实测 sql.js 官方发行版（SQLite 3.54.0）没有编译 FTS5，
报 `no such module: fts5`。换第三方 WASM 构建等于把搜索押在别人的维护意愿上，
所以改成自己维护倒排索引表 —— 任何 SQLite 构建都能跑，将来换 rusqlite 也能原样搬过去。

---

## 目录结构

```
src/
  domain/      纯逻辑：类型、等级、筛选分组、ULID、RRULE、冲突合并
  data/        SQLite：迁移、Repository、操作日志、搜索索引
  sync/        同步通道抽象（当前只有本地实现）
  state/       Zustand store
  components/  悬浮窗与主窗口
  test/        测试工厂与内存存储
src-tauri/
  src/dbstore.rs   绿色版数据目录解析 + 原子写入
  src/window.rs    悬浮窗形态切换、贴靠、Mica
  src/tray.rs      托盘常驻与右键菜单
supabase/
  migrations/      服务端 schema + RLS + 同步 RPC
.github/workflows/ CI 与 Releases 构建
```

---

## 部署

### GitHub —— 源码与安装包

```bash
git init && git add . && git commit -m "init"
gh repo create memodeck --private --source=. --push
```

打 tag 触发绿色版构建：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI 会跑类型检查和单测，通过后把 `MemoDeck.exe` 上传到 Releases。
**不产出安装器，不签名** —— 用户点"更多信息 → 仍要运行"即可。

### Supabase —— 数据库与用户管理

```bash
npm install -g supabase
supabase login
supabase link --project-ref <你的 project-ref>
supabase db push          # 应用 supabase/migrations/
```

手动配置时：

1. Supabase 控制台 → SQL Editor → 执行 `supabase/migrations/0001_init.sql`
2. Authentication → Providers → Email → **关闭 Confirm email**
   （产品决策是不做邮件找回密码，见 PRD F1）
3. Project Settings → API → 拿到 URL 和 anon key

客户端只需要 anon key。**安全性完全由数据库的 RLS 策略保证**：
即使 anon key 泄露，别人也读不到你的数据。

> ⚠️ 免费额度项目连续 7 天低活跃会被自动暂停，届时同步会中断直到有人打开
> 控制台恢复。团队有稳定使用习惯的话，直接上 Pro（$25/月）可以避免。

### Vercel —— 可选，仅用于下载页

Vercel 在这个项目里**不是必需的**：

- 它不能存数据库 —— Supabase 才是数据库
- 它跑不了 Windows 桌面程序 —— GitHub Releases 才是分发渠道
- 在客户端和 Supabase 之间加一层 Serverless 中转没有收益：
  Supabase 自带 PostgREST 和 Auth，多一跳只增加延迟和故障点

它唯一合适的用途是**托管一个下载页**（介绍 + 指向 Releases 的下载按钮）。
如果你不需要，直接跳过。

注意：Vercel 免费版在中国大陆的访问状况需要你实际验证，如果打不开，
用 GitHub Pages 托管同一个静态站更稳。

---

## 数据存在哪

| 场景 | 位置 |
|---|---|
| 桌面版（绿色版） | exe 同级 `data/memodeck.db` |
| exe 放在只读目录 | 自动回退 `%APPDATA%\MemoDeck\data\` |
| 浏览器开发 | localStorage（仅开发用） |

设置界面会显示**当前实际路径** —— 因为拷了文件夹却发现数据没跟过去，
是最容易让人以为程序坏了的情况。

---

## 迁移到另一台电脑

**只拷 exe**：下载 → 放到任意目录 → 双击 → 登录 → 数据自动恢复。

**带离线数据**：整个文件夹一起拷 → 双击 → 登录时提示是否导入本机残留数据。

---

## License

MIT
