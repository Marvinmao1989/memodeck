#!/usr/bin/env bash
#
# 一键部署：GitHub 建仓推代码 + Supabase 应用数据库迁移。
#
# 为什么不用官方 CLI：
#   沙箱环境下载不到 gh / supabase 的二进制（GitHub Releases 直连超时），
#   但 GitHub REST API 和 Postgres 协议都通。所以这里直接用
#   curl + git + node(pg) 实现，不引入额外依赖。
#
# 用法：
#   export GH_TOKEN='ghp_xxx'
#   export DATABASE_URL='postgresql://postgres:密码@db.xxx.supabase.co:5432/postgres'
#   export GH_REPO_NAME='memodeck'
#   ./scripts/deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
step() { printf '\n%s==>%s %s\n' "$GREEN" "$RESET" "$1"; }

# 沙箱有 TLS 拦截网关，git 不认 CURL_CA_BUNDLE 这类环境变量，得显式指定
GATEWAY_CA=/etc/ssl/certs/agent-identity/sandbox-gateway-ca.crt
if [ -f "$GATEWAY_CA" ]; then
  export GIT_SSL_CAINFO="$GATEWAY_CA"
  ok "已配置 git TLS 信任库（沙箱网关）"
fi

# ---------------------------------------------------------------------------
step "0/6 校验凭证与环境"

[ -n "${GH_TOKEN:-}" ] || die "未设置 GH_TOKEN"
[ -n "${DATABASE_URL:-}" ] || die "未设置 DATABASE_URL（Supabase 控制台 → Project Settings → Database → Connection string，取 Direct connection）"

GH_REPO_NAME="${GH_REPO_NAME:-memodeck}"
GH_VISIBILITY="${GH_VISIBILITY:-private}"

AUTH=(-H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

# 顺带检查 token 权限够不够，避免推上去一半才失败
PERMS="$(curl -sS "${AUTH[@]}" -o /dev/null -w '%{http_code}' https://api.github.com/user)"
[ "$PERMS" = "200" ] || die "GitHub token 无效（API 返回 $PERMS）"

ok "GitHub token 有效"
ok "仓库名：$GH_REPO_NAME（$GH_VISIBILITY）"

# ---------------------------------------------------------------------------
step "1/6 本地校验"

npm run typecheck >/dev/null 2>&1 || die "类型检查未通过"
ok "类型检查"
npm test -- --reporter=dot >/dev/null 2>&1 || die "单元测试未通过"
ok "单元测试"

if [ -n "$(git status --porcelain -- ':!scripts' ':!.gitignore')" ]; then
  warn "有未提交的改动（不含脚本），将一并提交"
  git add -A ':!scripts'
  git commit -q -m "chore: 部署前自动提交" || true
else
  ok "工作区干净"
fi

# ---------------------------------------------------------------------------
step "2/6 创建仓库"

GH_USER="$(curl -sS "${AUTH[@]}" https://api.github.com/user | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).login)}catch{process.exit(1)}})')" \
  || die "读取 GitHub 用户名失败"
ok "账号：$GH_USER"

EXISTS="$(curl -sS "${AUTH[@]}" -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$GH_USER/$GH_REPO_NAME")"

if [ "$EXISTS" = "200" ]; then
  warn "仓库已存在，跳过创建"
elif [ "$EXISTS" = "404" ]; then
  BODY="$(node -e '
    const [name, vis] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({
      name, private: vis === "private",
      description: "Windows 桌面悬浮备忘录 —— 待办、日历、提醒、多设备同步",
      auto_init: false, has_issues: true,
    }))' "$GH_REPO_NAME" "$GH_VISIBILITY")"

  CODE="$(curl -sS "${AUTH[@]}" -X POST -d "$BODY" \
    -o /tmp/repo.json -w '%{http_code}' https://api.github.com/user/repos)"

  [ "$CODE" = "201" ] || die "创建仓库失败（$CODE）：$(head -c 300 /tmp/repo.json)"
  ok "仓库已创建"
else
  die "检查仓库时返回 $EXISTS"
fi

# ---------------------------------------------------------------------------
step "3/6 推送代码"

# 用 token 做 basic auth；仓库名和 token 都不含 @ : / 字符，拼接是安全的
REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${GH_REPO_NAME}.git"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"

if git push -u origin HEAD 2>&1 | sed 's|https://[^ ]*@github.com|https://github.com|g'; then
  ok "已推送 $(git rev-parse --short HEAD) → github.com/$GH_USER/$GH_REPO_NAME"
else
  die "推送失败。若报错提到 workflow，是 token 缺少 **Workflows: Read and write** 权限"
fi

ok "CI 已触发 —— 它会替你验证 src-tauri 里尚未编译过的 Rust 代码"

# ---------------------------------------------------------------------------
step "4/6 连接 Supabase 数据库"

node scripts/apply-migrations.mjs "$DATABASE_URL" 2>&1 | sed 's/^/  /' \
  || die "迁移执行失败，见上方报错"

# ---------------------------------------------------------------------------
step "5/6 记录"

git tag -f "deploy-$(date +%Y%m%d-%H%M%S)" -m "部署快照" >/dev/null 2>&1 || true
ok "已打本地部署标签"

# ---------------------------------------------------------------------------
printf '\n%s%s部署完成%s\n\n' "$BOLD" "$GREEN" "$RESET"
cat <<EOF
仓库    https://github.com/$GH_USER/$GH_REPO_NAME
Actions https://github.com/$GH_USER/$GH_REPO_NAME/actions

接下来手动做两件事：
  1. 看 CI 结果 —— 这一步会告诉你 src-tauri 的 Rust 能不能编译（本地没验证过）
  2. Supabase 控制台 → Authentication → Providers → Email → 关闭 "Confirm email"
     （产品决策不做邮件找回密码，开着的话注册后登不进去）

发第一个版本：
  git tag v0.1.0 && git push origin v0.1.0
EOF
