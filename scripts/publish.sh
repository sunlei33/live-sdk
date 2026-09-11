#!/usr/bin/env bash
#
# live-sdk 本地发布脚本（npm publish）
#
# 用法：
#   bash scripts/publish.sh                # 正式发布（走完校验 → 预览 → 确认 → 上传）
#   bash scripts/publish.sh --dry-run      # 演练：只走校验与预览，不上传、不打 tag
#   bash scripts/publish.sh --otp=123456   # 账号开启两步验证（2FA）时附带一次性口令
#   bash scripts/publish.sh --skip-gate    # 跳过质量门（不推荐；仅用于已单独验证过的场景）
#
# 说明：
#   - 质量门（test + build + verify）在本脚本内显式执行并展示结果，便于发布前 review；
#     随后用 `npm publish --ignore-scripts` 上传，避免 prepublishOnly 重复跑一遍。
#   - 若你直接跑裸 `npm publish`，package.json 里的 prepublishOnly 仍会兜底执行同样的质量门。
#
set -euo pipefail

# ── 进入包根目录（脚本所在目录的上一级）──
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
SKIP_GATE=0
PUBLISH_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --skip-gate) SKIP_GATE=1 ;;
    --otp=*)     PUBLISH_ARGS+=("$arg") ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $arg（用 --help 查看用法）"; exit 1 ;;
  esac
done

# ── 输出辅助 ──
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  \033[36m›\033[0m %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 读取包信息 ──
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
PRIVATE="$(node -p "Boolean(require('./package.json').private)")"

echo
bold "发布 $NAME@$VERSION$([ "$DRY_RUN" = 1 ] && echo '  [演练模式]')"
echo

# ── 1. 前置检查 ──
bold "1) 前置检查"

command -v node >/dev/null 2>&1 || die "未找到 node"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"
ok "node $(node -v) / npm $(npm -v)"

[ "$PRIVATE" = "false" ] || die "package.json 里 private=true，无法发布"

# npm 登录态
if WHOAMI="$(npm whoami 2>/dev/null)"; then
  ok "npm 已登录：$WHOAMI"
elif [ "$DRY_RUN" = 1 ]; then
  warn "npm 未登录（演练模式不阻断；正式发布前需 npm adduser / npm login）"
else
  die "npm 未登录。请先执行  npm adduser  （或 npm login）后再跑本脚本"
fi

# 作用域归属提示（发布 scoped 包必须先拥有该 scope；可用 npm org ls <scope> 查看）
case "$NAME" in
  @*)
    SCOPE="${NAME%%/*}"
    info "包名为 scoped（$SCOPE），发布前请确认你有该 scope 的发布权限：npm org ls ${SCOPE#@}"
    ;;
esac

# 工作区干净度（仅警告，不阻断——发布取的是构建产物，未提交文件不影响）
if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    warn "工作区有未提交改动（不影响发布，但建议先提交以便 tag 与代码对应）"
  else
    ok "git 工作区干净"
  fi
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  [ "$BRANCH" = "main" ] || warn "当前分支为 $BRANCH（非 main）"
fi

# ── 2. 质量门 ──
echo
if [ "$SKIP_GATE" = 1 ]; then
  warn "2) 已跳过质量门（--skip-gate）"
else
  bold "2) 质量门：单测 → 构建 → 契约/导出/冒烟校验"
  info "npm test"
  npm test
  info "npm run build"
  npm run build
  info "npm run verify"
  npm run verify
  ok "质量门全部通过"
fi

# ── 3. 预览待发布内容 ──
echo
bold "3) 预览发布内容（npm pack --dry-run）"
echo
npm pack --dry-run
echo

# ── 4. 确认 ──
if [ "$DRY_RUN" = 1 ]; then
  bold "演练结束：未上传、未打 tag。"
  echo "  （去 --dry-run 即为正式发布）"
  echo
  exit 0
fi

bold "4) 确认发布"
printf '  即将上传 %s@%s 到 npm registry（公开）。继续？[y/N] ' "$NAME" "$VERSION"
read -r REPLY
case "$REPLY" in
  y|Y|yes|YES) ;;
  *) echo "  已取消。"; exit 0 ;;
esac

# ── 5. 发布 ──
echo
bold "5) 发布"
npm publish --ignore-scripts "${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}"
ok "已发布：$NAME@$VERSION"
info "验证：npm view $NAME version"
info "安装：npm i $NAME"

# ── 6. 可选：打 tag 并推送到 GitHub ──
echo
if git rev-parse --git-dir >/dev/null 2>&1; then
  TAG="v$VERSION"
  printf '  现在为本次发布打 tag %s 并推送到 origin？[y/N] ' "$TAG"
  read -r REPLY2
  case "$REPLY2" in
    y|Y|yes|YES)
      git tag -a "$TAG" -m "release: $NAME@$VERSION"
      git push origin "$TAG"
      ok "已打 tag 并推送：$TAG"
      ;;
    *) echo "  已跳过打 tag（可稍后手动：git tag -a $TAG -m \"release: $NAME@$VERSION\" && git push origin $TAG）" ;;
  esac
fi

echo
bold "完成 🎉"
echo
