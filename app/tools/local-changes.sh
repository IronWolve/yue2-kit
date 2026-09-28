#!/usr/bin/env bash
# What makes this yue2.cpp install differ from a stock one, read live from the disk and git.
# LOCAL-CHANGES.md explains each item and the update procedure.
#
#   tools/local-changes.sh           compare with upstream as of the last fetch
#   tools/local-changes.sh --fetch   fetch upstream first (updates git's copy of the remote only, never your files)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$ROOT/build"
UP="origin/master"
G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' C=$'\e[36m' D=$'\e[2m' B=$'\e[1m' X=$'\e[0m'
t0=$(date +%s)
git() { command git -C "$REPO" "$@"; }

[ "${1:-}" = "--fetch" ] && { git fetch --quiet origin && echo "${D}fetched $UP${X}"; }

base=$(git merge-base HEAD "$UP")
local_n=$(git rev-list --count "$base..HEAD")
up_n=$(git rev-list --count "$base..$UP")
mod=$(git diff --name-status "$base" HEAD | awk '$1=="M"' | wc -l)
add=$(git diff --name-status "$base" HEAD | awk '$1=="A"' | wc -l)

echo "${B}code${X}  base ${C}$(git log -1 --format='%h %ad' --date=short "$base")${X} (upstream $UP)"
echo "  local commits on top   ${G}$local_n${X}"
echo "  upstream files changed ${Y}$mod${X}, new files ${G}$add${X}"
unmarked=""
while read -r f; do
  case "$f" in *.h|*.cpp|*.txt) ;; *) continue ;; esac
  n=$(command grep -c 'Local addition\|Local patch\|Local change' "$REPO/$f" || true)
  [ "$n" = 0 ] && unmarked="$unmarked $f"
done < <(git diff --name-only --diff-filter=M "$base" HEAD)
[ -n "$unmarked" ] && echo "  ${D}changed upstream files with no \"Local ...\" comment:${X}$unmarked"
dirty=$(git status --short | wc -l)
[ "$dirty" -gt 0 ] && echo "  ${Y}uncommitted in build/: $dirty${X} ${D}($(git status --short | awk '{print $2}' | head -5 | tr '\n' ' '))${X}"

echo "${B}upstream${X}  ${up_n} new commit(s) not in your tree"
overlap=0
if [ "$up_n" -gt 0 ]; then
  git log --format='  %h %ad %s' --date=short "$base..$UP" | head -10
  while read -r f; do
    echo "  ${R}both changed${X} $f"; overlap=$((overlap + 1))
  done < <(comm -12 <(git diff --name-only "$base" "$UP" | sort) <(git diff --name-only "$base" HEAD | sort))
  [ "$overlap" = 0 ] && echo "  ${G}no file changed on both sides${X}"
  git diff --quiet "$base" "$UP" -- ggml || echo "  ${Y}ggml submodule moves${X} ${D}(git submodule update --init after the rebase)${X}"
fi

echo "${B}links${X}"
links=0; broken=0
while read -r l; do
  t=$(readlink "$l"); links=$((links + 1))
  if [ -e "$l" ]; then printf '  %s%-4s%s %-50s -> %s\n' "$G" ok "$X" "${l#$ROOT/}" "$t"
  else printf '  %s%-4s%s %-50s -> %s\n' "$R" BROKEN "$X" "${l#$ROOT/}" "$t"; broken=$((broken + 1)); fi
done < <(find "$ROOT" \( -path "$ROOT/tmp" -o -path "$ROOT/outputs" -o -path "$REPO/build" -o -path "$REPO/ggml" -o -path "$REPO/.git" -o -path "$ROOT/upstream" -o -path "$ROOT/repo" -o -path "$ROOT/kits" \) -prune -o -type l -print | sort)

echo "${B}outside git${X}  $(cd "$ROOT" && ls -p | command grep -v / | tr '\n' ' ')tools/"
[ -f "$ROOT/loras/sources.json" ] && echo "  loras/sources.json ${G}present${X}" || echo "  loras/sources.json ${R}missing${X}"

echo "${B}build${X}  $(command grep -E '^(CMAKE_CUDA_ARCHITECTURES|GGML_CUDA|CMAKE_BUILD_TYPE):' "$REPO/build/CMakeCache.txt" 2>/dev/null | sed 's/:[A-Z]*=/=/' | tr '\n' ' ')"
gz="$REPO/tools/public/index.html.gz" bin="$REPO/build/yue-server"
newest_console=$(find "$REPO/tools/console" -type f -newer "$gz" | head -1)
[ -n "$newest_console" ] && echo "  ${Y}page source newer than the built page${X}: run ./build-page.sh, then rebuild yue-server"
[ -f "$bin" ] && [ "$gz" -nt "$bin" ] && echo "  ${Y}built page newer than yue-server${X}: cmake --build build/build --target yue-server"
[ -f "$bin" ] && [ "$(git log -1 --format=%ct HEAD)" -gt "$(stat -c %Y "$bin")" ] && echo "  ${Y}last commit newer than yue-server${X}: rebuild"

echo "${B}models${X}  $(find -L "$ROOT/models" -maxdepth 1 -name '*.gguf' -printf '%f ' 2>/dev/null | tr ' ' '\n' | sort | tr '\n' ' ')"

PB="$ROOT/repo/engines/cpp/BASE.txt"
if [ ! -f "$PB" ]; then
    echo "${B}patches${X}  ${Y}none in repo/ yet${X}: tools/export-patches.sh"
elif [ "$(awk -F= '$1 == "tree" {print $2}' "$PB")" = "$(git -C "$REPO" rev-parse 'HEAD^{tree}')" ]; then
    echo "${B}patches${X}  repo/engines/cpp ${G}matches${X} build/ ${D}($(awk -F= '$1 == "patches" {print $2}' "$PB") patches on upstream $(awk -F= '$1 == "base" {print substr($2, 1, 7)}' "$PB"), made $(awk -F= '$1 == "made" {print $2}' "$PB"))${X}"
else
    echo "${B}patches${X}  repo/engines/cpp ${Y}is older than build/'s commits${X}: tools/export-patches.sh"
fi
[ -z "$(command git -C "$ROOT/repo" status --porcelain 2>/dev/null)" ] || echo "  ${Y}repo/ has uncommitted changes${X} ${D}(the distribution repo)${X}"

echo
echo "${B}stats${X}  commits ${G}$local_n${X} local / ${Y}$up_n${X} upstream, files ${mod} changed + ${add} new, links $links ($([ "$broken" -gt 0 ] && echo "$R")$broken broken${X}), overlap $([ "$overlap" -gt 0 ] && echo "$R")${overlap}${X}, $(( $(date +%s) - t0 ))s"
[ "$broken" = 0 ]
