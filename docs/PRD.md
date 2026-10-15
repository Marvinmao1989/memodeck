# 桌面悬浮备忘录 · 产品需求文档（PRD）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.3 |
| 日期 | 2026-10-15 |
| 状态 | 草稿 |
| 产品代号 | MemoDeck（暂定） |
| 目标用户 | 作者本人 + 少量朋友（< 20 人） |

---

## 0. 变更记录

### v0.2 → v0.3（实现阶段发现）

| # | 变更 | 原因 |
|---|---|---|
| 1 | **放弃 FTS5，改用自建倒排二元组索引** | 实测 sql.js 官方发行版（SQLite 3.54.0）**未编译 FTS5**，报 `no such module: fts5`。换第三方 WASM 构建等于把核心功能押在别人的维护意愿上 |
| 2 | **`field_timestamps` 列加入数据模型** | v0.2 声称"字段级 LWW"，但只有记录级 `updated_at` 时无法区分"改标题"与"改正文"——必须逐字段记时间戳才成立 |
| 3 | **冲突语义从 `conflicts` 改为 `overwritten`** | 原语义下两台设备各改各的字段就会疯狂误报"冲突"。新语义是"本地有值，最后不是它"，且待推送的本地修改被掩码后不会出现在列表里 |
| 4 | **基础设施定为 GitHub + Supabase，Vercel 可选** | 见 §5.6 |

### v0.1 → v0.2

| # | 变更 | 影响 |
|---|---|---|
| 1 | **仅支持 Windows 桌面**，移除 Android / iOS / Web 版 | 大幅缩小范围。Tauri 的移动端优势消失，但"单 exe 体积"优势成为免安装方案的决定性因素 |
| 2 | **改为悬浮窗形态** | 新增整章交互设计（F2）。窗口行为、置顶、穿透、贴靠、全局快捷键成为核心需求 |
| 3 | **真实多用户**：注册/登录，服务端按用户隔离数据 | 数据层从"本地优先匿名"改为"本地缓存 + 服务端权威"。需要部署后端 |
| 4 | **免安装绿色版**：复制 exe → 登录 → 数据自动恢复 | 分发方式从安装包改为单 exe。签名成本问题消失（见 §10） |
| 5 | **界面简洁美观**为显性需求 | 新增设计规范章（F9） |
| 6 | 提醒方案**不变**：本地通知调度（§2.4） | 仍然成立且更重要了 |

---

## 1. 产品定位

一个常驻 Windows 桌面**悬浮窗**的个人备忘录工具：以「待办事项」为核心，融合备忘录与日历，支持多台 Windows 设备登录同一账号自动同步。

**一句话**：它不是一个要你打开的 App，而是一个一直挂在桌面角落、随手记一笔就走的东西。

### 1.1 设计原则

| 原则 | 含义 |
|---|---|
| 常驻不打扰 | 悬浮窗默认可穿透、可自动隐藏，绝不挡住正在做的事 |
| 零安装 | 单个 exe 双击即用，拷走文件夹就是完整迁移 |
| 离线优先 | 所有功能在断网下完整可用，网络只负责同步 |
| 干净 | 界面留白充足、动效克制、信息层级清晰 |

---

## 2. 关键设计决策

### 2.1 统一数据模型：待办 / 备忘 / 日历事件是同一张表

**决策**：单一 `notes` 表，通过 `note_type` 区分（`todo` / `memo` / `event`），而非三张表。

**理由**：用户在日历上看到"15:00 约牙医"，在待办列表里看到它，搜索也能搜到——在用户心智中这就是同一条记录。分表设计会让"日历+待办混合视图""全局搜索""统一排序"这三个高频功能全部退化成跨表 UNION 查询，复杂度会持续放大大所有后续功能。

差异化通过可空字段表达：`start_at` / `end_at` 有值即为事件；`priority` / `status` 对纯备忘无意义。

### 2.2 本地 SQLite 缓存 + 服务端权威

**决策**：所有读操作打本地 SQLite，所有写操作「先写本地 + 记操作日志 → 再异步推送」。服务端是跨设备同步的**权威副本**，但**不是运行前提**。

```
写入路径：
  1. 同一事务内写 notes 表 + oplog 表          ← 立即生效，UI 同步刷新
  2. 触发后台同步任务（去抖 2s）
  3. 推送 oplog 中未确认的 op 到服务端           ← 失败不影响使用，入队重试
  4. 拉取服务端游标之后的变更并应用
```

**理由**：断网时功能 100% 可用；网络抖动时不会卡住用户；冲突解决有完整的本地依据。

### 2.3 数据隔离：Postgres 行级安全（RLS）

**决策**：用户数据隔离在**数据库层**用 RLS 策略强制执行，不依赖应用层记得传 `user_id`。

```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY notes_own_only ON notes
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

**理由**：在应用层过滤意味着"某天有人写漏了一个 WHERE"就会造成越权——这是数据泄漏事故最常见的成因。把隔离下沉到数据库，任何路径（包括手工调 API、未来的新客户端）都绕不过去。用户量虽小，但这是唯一必须用对的地方。

### 2.4 提醒采用本地通知调度，而非服务端推送

**决策**：提醒在本机调度 Windows 本地通知，服务端只存 `remind_at` 时间戳。

**理由**：
- 备忘录的提醒语义是"到点弹窗看一眼"，本机调度绰绰有余
- 省掉整套推送基础设施（证书、SDK、服务端密钥）
- 断网状态下提醒依然有效
- Tauri 的通知插件在 Windows 上覆盖完整

**代价**：机器关机/休眠时提醒会延迟到下次唤醒——这是所有本地调度方案的共同特性，非本项目独有。需求中不承诺在关机状态下触发。

### 2.5 免安装：单 exe 绿色版

**决策**：分发物是**单个 `.exe` 文件**，不含安装器、不需管理员权限、不写注册表。

**理由**：直接服务于需求 #4「复制-登录-即用」。同时它顺带解决了签名成本——**未签名的 exe 一样能运行**，只是 Windows 会弹一次"未知发布者"，用户点"更多信息 → 仍要运行"即可。v0.1 里需要花钱的代码签名证书，在这个分发方式下不再是必需品。

**数据存放位置**：优先存 exe 同级的 `./data/`（这样拷走文件夹即带走数据），若该目录不可写（放在 `Program Files` 下等场景）自动回退到 `%APPDATA%\MemoDeck\`，并在设置中明示当前实际路径。

---

## 3. 功能需求

### F1 账号与用户管理

| ID | 需求 | 优先级 |
|---|---|---|
| F1.1 | 注册：邮箱 + 密码（≥8 位），密码以 Argon2id 哈希存储 | P0 |
| F1.2 | 登录 / 登出，会话 token 持久化（默认记住 30 天） | P0 |
| F1.3 | **数据严格隔离**：任一用户只能读写自己的 notes / tags，服务端由 RLS 强制 | P0 |
| F1.4 | 首次登录触发全量拉取，恢复该账号在所有设备上的数据 | P0 |
| F1.5 | 修改密码、退出登录、注销账号（级联删除服务端数据） | P1 |
| F1.6 | 应用锁：本地密码 / Windows Hello 生物识别 | P1 |
| F1.7 | 邀请朋友注册（可选分享链接，不做复杂组织架构） | P2 |

> **不需要的**：找回密码邮件、企业 SSO、组织/团队空间、多角色权限。规模不支持这些投入。

### F2 悬浮窗与窗口交互（核心）

| ID | 需求 | 优先级 |
|---|---|---|
| F2.1 | **两种形态**：展开态（320×480 左右，含列表）与收起态（仅一条输入栏，约 320×56） | P0 |
| F2.2 | 顶部常驻快速输入框，回车即创建待办（默认等级「无」，当前时间） | P0 |
| F2.3 | 收起态：点击或全局快捷键唤起；`Esc` 或失焦收起 | P0 |
| F2.4 | **全局快捷键**唤起/隐藏（默认 `Ctrl+Shift+Space`，可自定义） | P0 |
| F2.5 | 无边框窗口 + 圆角 + 阴影 + 亚克力毛玻璃背景 | P0 |
| F2.6 | 可拖动，位置持久化；拖至屏幕边缘**自动贴靠吸附**（左侧/右侧） | P1 |
| F2.7 | **置顶开关**（快捷键 / 托盘菜单切换） | P0 |
| F2.8 | **鼠标穿透开关**：开启后窗口不拦截点击，用于"摆在那儿只看不碰"。**开启时必须给出可撤销提示**（见 R11） | P1 |
| F2.9 | **失焦自动隐藏**（可选，延迟 3–30s 可配）；检测到全屏应用时自动隐藏 | P1 |
| F2.10 | 不透明度调节（100% / 85% / 60%），鼠标悬停时临时恢复 100% | P2 |
| F2.11 | 双击展开为**完整主窗口**（左栏导航 + 中间列表 + 右侧详情） | P0 |
| F2.12 | 系统托盘常驻：图标、今日未完成数徽标、右键菜单（显示/隐藏、快速新建、同步状态、退出） | P0 |
| F2.13 | 开机自启（可选开启） | P2 |
| F2.14 | 多显示器支持：记忆所在屏幕，屏幕拔出后自动回退到主屏可见区域 | P1 |
| F2.15 | **单实例运行**：重复启动 exe 时唤起已有窗口而非新开一个 | P0 |

> F2.9 的全屏检测需要 Windows `SetWinEventHook` 钩子或轮询前台窗口句柄——悬浮窗类应用的标准做法，但需要在实现阶段验证对游戏全屏模式的有效性。

### F3 备忘录

| ID | 需求 | 优先级 |
|---|---|---|
| F3.1 | 新建 / 编辑 / 删除（软删除，回收站保留 30 天） | P0 |
| F3.2 | 正文支持 Markdown，编辑与预览双模式 | P0 |
| F3.3 | 标题 + 正文 + 可选标签 + 自定义颜色 | P0 |
| F3.4 | 全文检索（标题 + 正文），中文可用 | P0 |
| F3.5 | 附件（图片 / 文件），内嵌存储于数据库 | P2 |

### F4 待办事项

| ID | 需求 | 优先级 |
|---|---|---|
| F4.1 | 字段：标题、描述、截止时间、等级、状态、标签、所属清单 | P0 |
| F4.2 | **等级体系**：4 档 —— 无 / 低 / 中 / 高，颜色 灰 / 蓝 / 橙 / 红 | P0 |
| F4.3 | 等级在悬浮窗列表中以色条 + 图标直观呈现 | P0 |
| F4.4 | 状态流转：未开始 → 进行中 → 已完成；支持归档 | P0 |
| F4.5 | 排序与筛选：按等级 / 截止时间 / 创建时间；按清单 / 标签筛选 | P0 |
| F4.6 | 逾期项显著标注（红色 + "逾期 N 天"） | P0 |
| F4.7 | 清单（List）分组，如"工作 / 生活 / 学习" | P1 |
| F4.8 | 子任务（嵌套待办，至少一层） | P2 |

### F5 日历

| ID | 需求 | 优先级 |
|---|---|---|
| F5.1 | 三种视图：月（网格）/ 周（时间轴）/ 日（时间轴） | P0 |
| F5.2 | 整日事件 与 带时段的定时事件 | P0 |
| F5.3 | 日历中**混合展示**待办与事件，按等级/类型着色 | P0 |
| F5.4 | 拖拽调整时间、空白处拖拽快速创建 | P1 |
| F5.5 | 重复规则：每日 / 每周 / 每月 / 自定义（iCalendar RRULE 标准） | P1 |
| F5.6 | 悬浮窗迷你日历（点击日期展开当日列表） | P1 |

### F6 提醒与通知

| ID | 需求 | 优先级 |
|---|---|---|
| F6.1 | 单条待办可设提醒时间，支持重复（一次性 / 每日 / 自定义） | P0 |
| F6.2 | 到点弹出 Windows 原生通知；通知点击后唤起悬浮窗并定位到该条 | P0 |
| F6.3 | 全局默认提醒：提前 N 分钟 / 到点 / 延后 N 分钟 | P0 |
| F6.4 | 免打扰时段 | P1 |
| F6.5 | 提醒在应用完全退出后失效，需在界面明确告知（避免误解） | P0 |

### F7 同步

| ID | 需求 | 优先级 |
|---|---|---|
| F7.1 | 登录后自动同步；登录前本地数据可用但不跨设备 | P0 |
| F7.2 | **增量同步**：基于操作日志（oplog）+ 服务端单调游标，仅传变更 | P0 |
| F7.3 | 幂等：操作按 `op_id` 去重，重复推送无副作用 | P0 |
| F7.4 | 断网自动重试，网络恢复后续传 | P0 |
| F7.5 | 同步状态可视：待同步条数、上次同步时间、手动触发按钮、错误提示 | P0 |
| F7.6 | 冲突处理：字段级 Last-Write-Wins；冲突字段的本地版本**保留副本**并提示用户 | P0 |
| F7.7 | 首次登录全量拉取与本地残留数据的合并策略见 §7.3 | P0 |

### F8 数据迁移与备份（免安装核心）

| ID | 需求 | 优先级 |
|---|---|---|
| F8.1 | **绿色版分发**：单 `.exe`，无安装器、无管理员权限、不写注册表 | P0 |
| F8.2 | 迁移路径 A（**仅 exe**）：新设备下载 exe → 双击 → 登录 → 全量数据自动恢复 | P0 |
| F8.3 | 迁移路径 B（**整个文件夹**）：拷 exe + data/ 到新设备 → 登录 → 提示导入本机残留数据 | P0 |
| F8.4 | 导出 `.memodeck.zip`（Markdown + JSON + 附件），支持密码加密 | P0 |
| F8.5 | 从导出包导入，完整恢复 | P0 |
| F8.6 | 自动本地备份，滚动保留最近 10 份 | P1 |
| F8.7 | 明确显示本地数据实际存储路径 | P1 |

### F9 界面设计规范

| ID | 需求 |
|---|---|
| F9.1 | 设计基线对齐 **Windows 11 Fluent Design**，看起来就是原生 Windows 应用 |
| F9.2 | 字体：`Segoe UI Variable`，中文回退 `微软雅黑 / PingFang SC` |
| F9.3 | 圆角：卡片 8px，悬浮窗 12px，输入框 6px |
| F9.4 | 间距刻度：4 / 8 / 12 / 16 / 24px，严格对齐刻度 |
| F9.5 | 配色：以中性灰阶为底，等级用**低饱和语义色**（不用刺眼纯色） |
| F9.6 | 层级：窗口用 Mica 材质，卡片用 Subtle 半透明层 |
| F9.7 | 深色 / 浅色双主题，跟随 Windows 系统设置，可手动覆盖 |
| F9.8 | 动效：150–200ms ease-out，**仅使用 opacity 与 transform**（不触发重排） |
| F9.9 | 紧凑密度：待办行高 32px，悬浮窗一屏可见 ≥ 8 条 |
| F9.10 | 无障碍：全部交互元素支持键盘 Tab 聚焦与 Enter 激活；对比度符合 WCAG AA |

### F10 未来（不在 v1 范围）

AI 自然语言录入（"下周三提醒我交电费"自动解析为待办）· 桌面小组件 · Windows 11 通知动态 · 数据加密云备份 · 第三方日历双向同步（CalDAV / Google Calendar）

---

## 4. 非功能需求

| 维度 | 指标 |
|---|---|
| 冷启动 | < 1s（10 万条数据量级） |
| 空闲内存 | < 120 MB（常驻托盘，比普通应用更严格） |
| exe 体积 | < 20 MB |
| 列表滚动 | 10 万条下 60 FPS（虚拟列表） |
| 搜索延迟 | < 100 ms（P95） |
| 悬浮窗唤起 | < 100 ms |
| 同步延迟 | 联网状态下变更 3s 内推送完成 |
| 离线性 | 除同步外，100% 功能可用 |
| 稳定性 | 托盘常驻 ≥ 7 天无内存泄漏、无崩溃 |
| 数据安全 | 传输 HTTPS；密码 Argon2id；不采集任何遥测；导出包可选加密 |
| 兼容性 | Windows 10 1809+ / Windows 11；需 WebView2 Runtime（缺失时给出引导安装） |

---

## 5. 技术栈选型

### 5.1 外壳：Tauri 2（✅ 选定）

v0.1 选 Tauri 的首要理由是移动端打包，**这个理由在 v0.2 已消失**。重新评估后结论不变，但支撑理由换了一条更硬的：

| 维度 | Tauri 2 | Electron |
|---|---|---|
| **绿色版体积** | **单个 exe，约 8 MB** | 一个目录，约 200 MB |
| **迁移体验** | **复制一个文件** | 复制整个文件夹 |
| 空闲内存 | **60–120 MB** | 200–400 MB |
| 安装包体积 | 5–15 MB | 90–150 MB |
| 代码签名 | 绿色版可不签 | 绿色版可不签 |
| 托盘 / 全局热键 / 穿透 | 支持 | 支持 |
| 生态成熟度 | 中 | 高 |
| 学习成本 | 高（需 Rust） | 低 |

**核心理由**：需求 #4 要的是「复制-登录-即用」。Tauri 的单 exe 让这句话字面成立——拷一个文件过去；Electron 要拷一个 200 MB 的文件夹，对"方便迁移"是明显的体验劣势。其次是常驻托盘工具对内存的敏感度，一个常驻的小工具吃 200 MB 内存不合理。

**代价（明确接受）**：
- 需要 Rust 工具链，首次编译链路比 Electron 长
- 插件生态不如 Electron 密，个别能力（贴靠吸附、全屏检测、鼠标穿透的高级用法）需要自己写 Rust
- **如果完全不想碰 Rust**：Electron 也能做，功能一样，只是迁移时得拷目录、内存多占 100 MB。对"自己和朋友用"的规模，这不是致命问题——但我仍然推荐 Tauri。

### 5.2 前端

| 项 | 选型 | 理由 |
|---|---|---|
| 框架 | **React 19 + TypeScript** | 生态与人才面最宽 |
| 构建 | **Vite** | 冷启动快，产物小（直接影响 exe 体积） |
| 状态管理 | **Zustand** | 轻量，适合本地优先的读写分离模型 |
| UI | **Tailwind CSS + shadcn/ui** | 组件源码进仓库，不依赖外部组件服务，契合"clone 即用" |
| 日历 | **FullCalendar Standard** | dayGrid / timeGrid / list / interaction 均为 **MIT 许可，商用免费**（Premium 的资源排程视图才需商业授权，本项目不需要）。成熟、已过 Axe 无障碍测试。**注意 v7 破坏性变更**：仅 ESM、需手动引 `temporal-polyfill`、不再自带 CSS |
| 日期处理 | **date-fns** + **rrule** | RRULE 是重复规则行业标准，与 CalDAV 兼容 |
| 虚拟列表 | **@tanstack/react-virtual** | 10 万条 60 FPS 的前提 |

### 5.3 后端与数据

**同步层做 provider 抽象，本地实现永远可用**：

```
         ┌────────────────────────┐
         │     业务层 / UI 层       │
         └───────────┬────────────┘
                     │  interface SyncProvider
       ┌─────────────┴─────────────┐
       ▼                           ▼
┌──────────────────┐    ┌────────────────────┐
│  LocalProvider   │    │  SupabaseProvider  │
│ 仅本地 SQLite     │    │ （登录后启用）      │
│ 默认，不联网      │    │                    │
└──────────────────┘    └────────────────────┘
```

**为什么必须上后端**：需求 #3 要求每人登录只看到自己的数据，这需要服务端权威 + 数据库层隔离，没有第三条路。

**选型：Supabase 自建部署**

| 方案 | 评价 |
|---|---|
| **Supabase 自建（推荐）** | Postgres + Auth + RLS 三件套齐全，隔离逻辑天然合适；用 `docker compose` 部署到国内 VPS 即可，**避开官方节点在国内访问缓慢的问题**；开源可自托管，无厂商锁定 |
| Supabase 官方托管 | 省事，但国内访问延迟高——对"打开就同步"的体验影响明显，不推荐 |
| 完全自建（NestJS/Fastify + Prisma + Postgres） | 完全可控，但要自己实现注册登录、会话管理、密码哈希、隔离中间件，工作量多 2–3 周，规模不支持 |
| 云厂商 BaaS（LeanCloud / 阿里云等） | 国内快，但要绑定平台，与"数据归用户"的定位冲突 |

**规模测算**：目标 < 20 用户。Supabase 单实例在 2 核 4G VPS 上承载这个量级绰绰有余，日同步数据量按每人每天 200 次写操作估算，年增量在百 MB 量级。

### 5.4 同步协议

选择**增量操作日志（Operation Log）**，不在 v1 引入 CRDT。

```
本地写入事务（原子）：
   1. 写 notes 表
   2. 同事务写 oplog 表（op_id, entity, entity_id, op_type, payload, ts, synced=0）

同步循环（去抖 2s + 事件触发）：
   1. push: 推送 oplog 中 synced=0 的记录，按 op_id 服务端幂等去重
   2. pull: GET /changes?after=<cursor>  拉取服务端游标之后的变更
   3. 应用远端变更到本地，并写入 oplog 以便继续传播到其他设备
   4. 冲突: 字段级 LWW（比较服务端权威时间戳）
           被覆盖的本地值存入 conflict_copies 表，UI 提示"有 N 处冲突待处理"
```

**关于 CRDT 的诚实说明**：Yjs / Automerge 能做到无冲突合并，代价是每条记录膨胀 3–5 倍、无法建立索引、调试困难。本项目是少量用户的低并发场景，字段级 LWW + 冲突副本的用户体感几乎相同，复杂度却低一个数量级。数据模型预留 `rev` 字段，将来若要引入可平滑切换。

**实时性取舍**：不使用 WebSocket 实时推送，改用"推送后立即拉取" + 3–5s 轮询兜底。对"隔一会儿看一眼"的待办场景足够，且省掉长连接的生命周期管理复杂度。

### 5.5 分发与构建

| 环节 | 方案 |
|---|---|
| 源码托管 | GitHub（MIT 许可） |
| CI | GitHub Actions，`tauri-action` 构建 |
| 分发物 | **单个 `MemoDeck.exe`** 上传至 GitHub Releases |
| 安装包 | **不提供**（用户下载即用） |
| 数据库迁移 | `drizzle-orm` 版本化脚本，随应用启动自动执行 |

**明确不做**：代码签名。不签名的 exe 在 Windows 上首次运行会弹 SmartScreen 提示，用户点"更多信息 → 仍要运行"即可。对"自己和朋友用"完全可接受，省下每年数千元成本。

---

### 5.6 基础设施落地（v0.3 确认）

| 服务 | 用途 | 必需性 |
|---|---|---|
| **GitHub** | 源码托管 + CI + Releases 分发绿色版 exe | 必需 |
| **Supabase** | Postgres 数据库 + 用户认证 + RLS 数据隔离 + 同步 RPC | 必需（M5 之后） |
| **Vercel** | 托管下载页 | **可选**，不承担任何核心职责 |

**为什么 Vercel 不参与核心链路**：

- 它**不能存数据库**。Supabase 才是数据库，Vercel 只有边缘函数和静态托管
- 它**跑不了 Windows 桌面程序**。分发渠道是 GitHub Releases
- 在客户端与 Supabase 之间加一层 Serverless 中转没有收益：Supabase 自带
  PostgREST 和 Auth，多一跳只增加延迟与故障点，且鉴权逻辑要写两遍

Vercel 唯一合理的用途是托管一个静态下载页。**注意**：免费版在中国大陆的
访问状况需要实际验证，打不开就换 GitHub Pages。

**Supabase 免费额度的坑**：项目连续 7 天低活跃会被自动暂停，同步随之中断，
需要有人打开控制台点恢复。团队使用稳定的话直接上 Pro（$25/月）可避免。
`supabase/migrations/0001_init.sql` 已按托管版与自建版通用方式编写。

## 6. 数据模型

### 6.1 表结构

```sql
-- 单表承载全部笔记类型（待办 / 备忘 / 事件）
CREATE TABLE notes (
  id            TEXT PRIMARY KEY,           -- ULID，客户端生成，按时间有序
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  note_type     TEXT NOT NULL,              -- 'todo' | 'memo' | 'event'
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',   -- Markdown
  status        TEXT,                       -- 'open' | 'doing' | 'done' | 'archived'
  priority      INTEGER NOT NULL DEFAULT 0, -- 0=无 1=低 2=中 3=高
  list_id       UUID,
  start_at      TIMESTAMPTZ,                -- 事件开始
  end_at        TIMESTAMPTZ,                -- 事件结束
  due_at        TIMESTAMPTZ,                -- 待办截止
  all_day       BOOLEAN NOT NULL DEFAULT false,
  repeat_rule   TEXT,                       -- iCalendar RRULE
  remind_at     TIMESTAMPTZ,
  remind_repeat TEXT,
  color         TEXT,
  parent_id     TEXT,                       -- 子任务
  sort_order    TEXT,                       -- 分数索引，支持拖拽排序
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,       -- 服务端权威时间戳，冲突裁决依据
  deleted_at    TIMESTAMPTZ,                -- 软删除
  rev           INTEGER NOT NULL DEFAULT 1, -- 版本号，冲突检测 + CRDT 预留
  device_id     TEXT NOT NULL,
  -- 每个用户可见字段的最后修改时间戳。字段级 LWW 的前提（PRD §0 v0.3 第 2 条）
  field_timestamps TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_notes_user_type   ON notes(user_id, note_type, deleted_at);
CREATE INDEX idx_notes_user_due    ON notes(user_id, due_at);
CREATE INDEX idx_notes_user_start  ON notes(user_id, start_at);
CREATE INDEX idx_notes_seq         ON notes(server_seq);   -- 服务端增量拉取游标

-- 行级安全：隔离下沉到数据库，应用层无法绕过
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY notes_own_only ON notes
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 清单
CREATE TABLE lists (
  id       UUID PRIMARY KEY,
  user_id  UUID NOT NULL REFERENCES auth.users(id),
  name     TEXT NOT NULL,
  color    TEXT,
  sort_order TEXT
);
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY lists_own_only ON lists
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 标签
CREATE TABLE tags (
  id       UUID PRIMARY KEY,
  user_id  UUID NOT NULL REFERENCES auth.users(id),
  name     TEXT NOT NULL,
  color    TEXT,
  UNIQUE(user_id, name)
);
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tags_own_only ON tags
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE note_tags (
  note_id TEXT NOT NULL,
  tag_id  UUID NOT NULL,
  PRIMARY KEY (note_id, tag_id)
);
```

### 6.2 服务端同步支撑表

```sql
-- 服务端操作日志，seq 为增量拉取游标（单调递增）
CREATE TABLE server_oplog (
  seq        BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op_type    TEXT NOT NULL,     -- 'upsert' | 'delete'
  payload    JSONB NOT NULL,
  op_id      TEXT NOT NULL,     -- 客户端生成的幂等键
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, op_id)        -- 幂等去重的关键约束
);
CREATE INDEX idx_oplog_user_seq ON server_oplog(user_id, seq);

-- 冲突副本：LWW 覆盖时保留被淘汰的本地值
CREATE TABLE conflict_copies (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  field      TEXT NOT NULL,
  local_value  JSONB,
  remote_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved   BOOLEAN NOT NULL DEFAULT false
);
```

### 6.3 本地 SQLite 表

结构与服务端对齐（`user_id` 存本地身份标识），另加两张本地专属表：

```sql
-- 本地操作日志，同步引擎核心
CREATE TABLE oplog (
  op_id     TEXT PRIMARY KEY,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op_type   TEXT NOT NULL,
  payload   TEXT NOT NULL,          -- JSON
  ts        INTEGER NOT NULL,       -- Unix ms
  synced    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_oplog_pending ON oplog(synced, ts);

-- 本地全文检索
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content, content='notes', content_rowid='rowid', tokenize='trigram'
);
-- trigram 分词器对中文有效，且无需编译额外扩展

-- 单实例锁：防止两个 exe 副本同时写同一个库文件
CREATE TABLE instance_lock (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  pid     INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
```

### 6.4 时间与 ID 约定

- **时间**：一律以 UTC（ISO 8601 / `TIMESTAMPTZ`）存储，UI 层转本地时区。整日事件存 `all_day=true` 并按**日期**而非时间戳解释，避免跨时区漂移。
- **ID**：ULID，客户端生成，字典序 = 时间序——好处是本地新建的记录在排序中自然靠前，且不会在多设备间冲突。
- **排序**：用分数索引（fractional index）字符串，不在客户端做浮点运算，避免精度问题。

---

## 7. 关键流程

### 7.1 首次启动

```
双击 MemoDeck.exe
  → 检测 WebView2 Runtime（缺失则弹引导安装页）
  → 申请单实例锁（已有实例则唤起其窗口后退出）
  → 确定数据目录（exe 同级 data/，不可写则回退 %APPDATA%\MemoDeck\）
  → 执行数据库迁移
  → 无本地账号 → 直接进主界面，离线可用
  → 托盘常驻 + 悬浮窗出现
```

### 7.2 免安装迁移（需求 #4 核心路径）

**路径 A：只拷 exe（推荐）**

```
电脑 A                          电脑 B
─────────────────────           ─────────────────────
已登录，数据在服务端      →     下载 MemoDeck.exe
                                双击运行
                                点击"登录"
                                输入账号密码
                                  ↓
                          全量拉取该账号数据
                                登录完成，全部功能可用
```

**路径 B：整个文件夹（带离线数据）**

```
复制 MemoDeck.exe + data/  →   粘贴到电脑 B 任意目录
                                双击运行
                                登录 → 触发全量拉取
                                  ↓
                       检测到本机残留数据（data/ 中）
                                弹出选择：
                                  [ 合并导入 ]  ← 把本机离线数据并入云端
                                  [ 放弃本机数据 ] ← 以云端为准
```

### 7.3 登录后的数据合并策略

新设备上若已有离线残留数据，处理规则（写入需求 F7.7）：

| 情况 | 处理 |
|---|---|
| 残留数据的 `user_id` 与登录账号一致 | 记录 `device_id` 与云端不同 → 作为**另一台设备**的变更推送上去，全量合并 |
| 残留数据属于另一个已登出账号 | **不合并**，提示"检测到账号 X 的本地数据"，用户选择导入（归属当前账号）或丢弃 |
| 无残留数据 | 正常全量拉取 |

### 7.4 悬浮窗唤起

```
全局快捷键 Ctrl+Shift+Space
  → 若主窗口存在 → 置顶并聚焦
  → 若仅悬浮窗存在 → 展开 / 收起切换
  → 若进程在托盘 → 唤起悬浮窗 + 定位到鼠标所在屏幕
```

---

## 8. 界面设计

### 8.1 悬浮窗

```
┌────────────────────────────────┐  ← 12px 圆角，Mica 背景，阴影
│ ✏️ 记一笔…                ⊕ ⋮ │  ← 常驻快速输入，56px 高
├────────────────────────────────┤
│  今天  3                         │  ← 折叠分组标题，12px 字
│  ○ ▌ 交房租            10/25  │
│  ◉ ▌ 报销单据           逾期3天 │  ← 色条=等级，红=高
│  ○ ▌ 回邮件给张三        进行中 │
│                                │
│  稍后  1                         │
│  ○ ▌ 取快递            明天    │
├────────────────────────────────┤
│  ⟳ 已同步 12:04    ⤢ 展开主窗口│  ← 状态栏，24px
└────────────────────────────────┘
        320 × 480（展开态）
```

### 8.2 收起态

```
┌────────────────────────────────┐
│ ✏️ 记一笔…                 ▣ ⤢│  ← 320 × 56，可贴靠屏幕边缘
└────────────────────────────────┘
```

### 8.3 主窗口

```
┌──────────┬─────────────────────────────┬──────────────┐
│ 今天      │  全部待办  ·  筛选  ·  排序   │  详情         │
│ 日历      │                             │  标题         │
│ 全部待办  │  ▌ 交房租        10/25  高   │  Markdown     │
│ 备忘录    │  ▌ 回邮件        明天    中   │  编辑器       │
│ ─────    │  ○ 取快递        后天    低   │               │
│ 工作      │  ◉ 报销单据      逾期   高   │  等级 ▾       │
│ 生活      │                             │  截止 ▾       │
│ ─────    │                             │  提醒 ▾       │
│ ⚙ 设置    │                             │  [删除]       │
└──────────┴─────────────────────────────┴──────────────┘
   220px              flex: 1                    380px
```

### 8.4 视觉规范要点

| 项 | 规范 |
|---|---|
| 等级色 | 高 `#D13438` / 中 `#C76E00` / 低 `#0F6CBD` / 无 `#8A8886`（浅色主题，深色主题自动提亮） |
| 中性色 | 直接取 Windows 系统语义色（`--text-primary` 等），自动适配主题 |
| 字号 | 标题 14 / 正文 13 / 辅助 11 / 徽标 10，行高 1.4 |
| 行高 | 待办行 32px，列表项 hover 态底色变化 120ms |
| 圆角 | 卡片 8px / 悬浮窗 12px / 输入框 6px / 徽标 4px |
| 阴影 | 仅悬浮窗与浮层有，`0 8px 24px rgba(0,0,0,.12)` |
| 动效 | 仅 opacity / transform，150–200ms ease-out，禁止影响布局的动画 |
| 图标 | Lucide，1.5px 描边，与 Segoe Fluent 图标风格协调 |

---

## 9. 里程碑

| 阶段 | 内容 | 可交付物 |
|---|---|---|
| M0 | 脚手架、单 exe 构建、SQLite、托盘、悬浮窗外壳（无边框/圆角/置顶/穿透/快捷键） | 能常驻桌面的空壳 |
| M1 | 待办 CRUD + 等级 + 状态 + 悬浮窗快速输入 + 列表筛选排序 | **本地完全可用** |
| M2 | 详情面板 + Markdown 编辑器 + 备忘录 + 搜索 + 回收站 | 功能完整 |
| M3 | 日历三视图 + RRULE 重复规则 | 日历可用 |
| M4 | Windows 本地通知 + 免打扰 + 通知点击跳转 | 提醒可用 |
| M5 | Supabase 部署 + 注册登录 + RLS 隔离 + 增量同步引擎 | **多设备可用** |
| M6 | 迁移流程 A/B + 导入导出 + 首次登录合并策略 | **迁移闭环** |
| M7 | 视觉打磨 + 深色模式 + 边缘贴靠 + 失焦隐藏 + 性能优化 | 正式发布 |

M0–M4 构成一个**完全可用、无需任何服务器**的本地应用。这是刻意的设计：项目在任何阶段都可交付，后端与同步是可选项而非前置依赖。

---

## 10. 风险与已知限制

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | **WebView2 Runtime 缺失**（Win10 LTSC、精简版系统、刚装机的裸系统） | exe 无法启动 | 启动时检测并给出官方离线安装包引导；CI 中一并提供 WebView2 离线包 |
| R2 | **透明/毛玻璃窗口的渲染开销**：Windows 上 DWM 合成有成本，长时间常驻可能升温 | 电量与占用 | 实现阶段实测；提供"关闭毛玻璃用纯色"降级开关 |
| R3 | **悬浮窗遮挡与误触** | 用户反感 | 提供穿透开关 + 失焦隐藏 + 全屏自动隐藏；默认不置顶 |
| R4 | **开机自启在绿色版下不可靠**：用户移动 exe 后注册的自启项路径失效 | 功能静默失效 | 启动时检测自启项路径，失效则提示重新开启；或干脆不做自启 |
| R5 | **同目录多副本**：用户把 exe 复制多份，会同时打开同一数据库 | SQLite 锁冲突、数据错乱 | `instance_lock` 表 + `tauri-plugin-single-instance`，检测到已运行实例直接唤起并退出 |
| R6 | **可写目录检测**：exe 放在受保护目录下无法写数据 | 首次启动失败 | 启动探测写权限，失败自动回退 `%APPDATA%` 并在设置中明示实际路径 |
| R7 | **后端可用性**：自建 Supabase 宕机或重启 | 同步暂停 | 本地功能完全不受影响；托盘同步图标给出明确状态与错误提示 |
| R8 | **同步冲突无法彻底消除** | 极端并发下可能丢编辑 | 字段级 LWW + 冲突副本 + 完整 oplog 可追溯；用户在"设置 → 同步"可查看冲突列表 |
| R9 | **Rust 工具链门槛** | 贡献者上手成本高 | 提供预编译 exe，开发需说明文档；这是"不碰 Rust"的直接代价 |
| R10 | **提醒依赖应用运行**：退出应用后不再提醒 | 用户可能误解 | 已在 F6.5 要求界面明确告知；退出时二次确认 |
| R11 | **鼠标穿透是全局开关，无法局部**：`set_ignore_cursor_events(true)` 会让整个窗口不可交互，用户若不记得怎么关回来就用不了了 | 开启穿透后无法操作悬浮窗 | 必须提供**两条明确的退出路径**：托盘右键菜单 + 快捷键；开启穿透时在窗口位置显示短暂提示"穿透已开启，Ctrl+Shift+Space 或托盘可关闭" |

---

## 11. 待确认问题

1. **后端部署在哪？** 需要一台国内 VPS（2 核 4G 起步，约 ¥600–1000/年）自建 Supabase，还是先用免费额度试用？这直接影响 M5 能否开始。
2. **悬浮窗默认行为**：默认收起（只一条输入栏）还是默认展开？我倾向**首次启动展开一次并引导，之后默认收起态**——用户看到它能干什么，才会留着它。
3. **是否需要"悬浮窗置顶"默认开启？** 我倾向默认关闭，靠全局快捷键唤起，避免长期挡在屏幕中央。

---

## 附录 A. 技术调研结论

| 主题 | 结论 |
|---|---|
| 日历组件 | FullCalendar Standard（dayGrid / timeGrid / list / interaction）为 **MIT 许可，商用免费**；Premium（resource-timeline 等资源排程视图）为 GPL→AGPL 或商业授权，本项目不涉及。**v7 破坏性变更**：仅 ESM、需手动引入 `temporal-polyfill`、不再自带 CSS、样式定制需迁移到 CSS 变量 |
| 重复规则 | 采用 iCalendar RRULE 标准，`rrule` 库与 CalDAV / Google Calendar 兼容 |
| 中文全文检索 | SQLite FTS5 `trigram` 分词器对中文有效，且无需编译额外扩展 |
| Windows 通知 | Tauri `plugin-notification` 基于 WinRT Toast，支持点击回调跳转 |
| 窗口穿透 | Tauri v2 `Window.set_ignore_cursor_events(true)` 原生支持 |
| 全屏检测 | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 或轮询 `GetForegroundWindow` 尺寸；对独占全屏游戏需另行验证 |
| 亚克力 / Mica 背景 | **Tauri 原生 `setEffects()`**：Windows 上支持 `Mica` / `MicaAlt` / `Acrylic` / `Tabbed` / `Popover` / `Tooltip`，调用 `EffectsBuilder::new().effect(Effect::Mica).state(EffectState::Active).build()` 即可，**无需手写 Win32 `SetWindowCompositionAttribute`**。要求窗口 `transparent: true` |
| 无边框窗口圆角 | **Windows 11 上对无边框窗口调用 `setShadow(true)` 会自动获得系统原生圆角**（官方文档明确说明）。但同一文档也写明：此时窗口会带 **1px 白色边框**，浅色主题下需实测是否突兀，必要时用 `setShadow(false)` + CSS 自绘圆角 |
| 窗口穿透 | `Window.set_ignore_cursor_events(bool)` 原生支持。**注意坑**：`true` 会让**整个窗口**不再接收任何鼠标事件（托盘菜单除外），无法"窗口一部分可点、一部分穿透"。若要精细的局部穿透，需引入多边形命中测试方案（见 R11） |
| 置顶 / 无边框 / 隐藏 / 跳过任务栏 | `set_always_on_top()` / `set_decorations()` / `hide()` / `set_skip_taskbar()` 均原生支持；托盘图标用 `tray-icon` feature |
| 密码哈希 | 服务端 Argon2id（Supabase Auth 内置） |
| 数据库迁移 | `drizzle-orm`，SQLite 与 Postgres 双驱动，迁移脚本随应用启动自动执行 |

## 附录 B. 范围边界（明确不做）

| 不做 | 理由 |
|---|---|
| 移动端 / macOS / Linux | 需求限定 Windows |
| 团队 / 组织 / 共享清单 | 规模仅 < 20 人，各自管理自己的待办即可 |
| 邮件找回密码 | 目标用户可自行记录；后续如需要再接 SMTP |
| 服务端推送通知 | 见 §2.4，本地通知已满足需求 |
| 代码签名与公证 | 绿色版不签名也可运行，见 §5.5 |
| Web 版 / PWA | 无桌面悬浮能力，需求未要求 |
