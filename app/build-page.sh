#!/usr/bin/env bash
# Builds the console page for yue-server: app.css, the official example prompts
# and app.js are inlined into index.html, written as one page for testing, then
# gzipped into the file the server embeds when it is compiled.
#
#   ./build-page.sh      -> tmp/console.html  (served by tools/mock_server.py)
#                        -> build/tools/public/index.html.gz  (embedded by the server build)
#
# It never runs cmake or ninja: rebuild the server yourself to pick the page up.
# The first run keeps the upstream page as tmp/index.html.gz.upstream.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TMPDIR="$ROOT/tmp"
mkdir -p "$TMPDIR"

G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' C=$'\e[36m' D=$'\e[2m' B=$'\e[1m' X=$'\e[0m'
# plain text when NO_COLOR is set or the output is not a terminal (a log file, a pipe)
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then G="" Y="" R="" C="" D="" B="" X=""; fi

SRC="$ROOT/build/tools/console"
EXAMPLES="$ROOT/build/tools/webui/example"
PAGE="$TMPDIR/console.html"
GZ="$ROOT/build/tools/public/index.html.gz"
t0=$(python3 -c 'import time; print(time.time_ns())')      # portable: macOS date has no %N

for f in index.html app.css themes.css instrumental.js help.js loras.js vaes.js themes.js app.js; do
    if [ ! -f "$SRC/$f" ]; then
        echo "${R}missing${X} ${SRC#"$ROOT"/}/$f"
        exit 1
    fi
done


# Inline everything; print the numbers for the stats block (tab separated).
stats=$(python3 - "$SRC" "$EXAMPLES" "$PAGE" "$(basename "$ROOT")" <<'PY'
import json, pathlib, re, sys

src, examples, page = (pathlib.Path(a) for a in sys.argv[1:4])
folder = sys.argv[4]
html = (src / "index.html").read_text(encoding="utf-8")
css = (src / "app.css").read_text(encoding="utf-8")
js = (src / "app.js").read_text(encoding="utf-8")
ins = (src / "instrumental.js").read_text(encoding="utf-8")
helps = (src / "help.js").read_text(encoding="utf-8")
lorajs = (src / "loras.js").read_text(encoding="utf-8")
vaejs = (src / "vaes.js").read_text(encoding="utf-8")
themecss = (src / "themes.css").read_text(encoding="utf-8")
themejs = (src / "themes.js").read_text(encoding="utf-8")

prompts = []
for path in sorted(examples.glob("*.json")) if examples.is_dir() else []:
    data = json.loads(path.read_text(encoding="utf-8"))
    prompts.append({k: data[k] for k in ("title", "style", "lyrics", "cot", "abc", "seed")
                    if k in data and data[k] not in (None, "")})
# "</" inside a JSON string is written "<\/" so it can never close the script.
examples_js = ("window.YUE2_EXAMPLES = " +
               json.dumps(prompts, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/") + ";")

for name, text, closer in (("app.css", css, "</style"), ("instrumental.js", ins, "</script"), ("help.js", helps, "</script"), ("loras.js", lorajs, "</script"), ("vaes.js", vaejs, "</script"), ("themes.css", themecss, "</style"), ("themes.js", themejs, "</script"), ("app.js", js, "</script")):
    if closer in text.lower():
        sys.exit(f"{name} contains '{closer}>', which would end its inlined block")

# Each marker must appear exactly once; the page is assembled from slices of the
# original, so inlined text can never be mistaken for a later marker.
swaps = [
    ('<link rel="stylesheet" href="app.css" />', "<style>\n" + css + "</style>"),
    ('<link rel="stylesheet" href="themes.css" />', "<style>\n" + themecss + "</style>"),
    ('<script src="examples.js"></script>', "<script>" + examples_js + "</script>"),
    ('<script src="instrumental.js"></script>', "<script>\n" + ins + "</script>"),
    ('<script src="help.js"></script>', "<script>\n" + helps + "</script>"),
    ('<script src="loras.js"></script>', "<script>\n" + lorajs + "</script>"),
    ('<script src="vaes.js"></script>', "<script>\n" + vaejs + "</script>"),
    ('<script src="themes.js"></script>', "<script>\n" + themejs + "</script>"),
    ('<script src="app.js"></script>', "<script>\n" + js + "</script>"),
]
found = []
for marker, replacement in swaps:
    count = html.count(marker)
    if count != 1:
        sys.exit(f"marker {marker!r} appears {count} times in index.html (want exactly 1)")
    found.append((html.index(marker), marker, replacement))
found.sort()
out, at = [], 0
for index, marker, replacement in found:
    out.append(html[at:index])
    out.append(replacement)
    at = index + len(marker)
out.append(html[at:])
result = "".join(out)

# The folder name is data: the page must not carry it, nor an absolute home path. External links whose
# name happens to match (upstream's own repo, which the CPP badge opens, and the collection's own repo, which
# the status note opens) are not paths, so they are left out.
EXTERNAL = ("https://github.com/ServeurpersoCom/yue2.cpp", "https://github.com/IronWolve/yue2-kit")
checked = re.sub(r"<!-- credits:.*?<!-- /credits -->", "", result, flags=re.S)   # the About card's upstream names
for url in EXTERNAL:   # the whole link (its text names the project too), then any bare mention of the URL
    checked = re.sub(r'<a\b[^>]*href="' + re.escape(url) + r'"[^>]*>.*?</a>', "", checked, flags=re.S)
    checked = checked.replace(url, "")
for bad in (folder, "/home/"):
    if bad and bad in checked:
        sys.exit(f"the page contains {bad!r}; paths and the folder name must not be baked in")

page.write_text(result, encoding="utf-8")
# the stats groups: every stylesheet and every script that was inlined
styles = (css, themecss)
scripts = (js, ins, helps, lorajs, vaejs, themejs)
sizes = [len(t.encode("utf-8")) for t in (html, "".join(styles), "".join(scripts), examples_js, result)]
lines = [t.count("\n") for t in (html, "".join(styles), "".join(scripts))]
print("\t".join(str(v) for v in sizes + lines + [len(prompts), len(styles), len(scripts)]))
PY
) || { echo "${R}build failed${X}"; exit 1; }

IFS=$'\t' read -r s_html s_css s_js s_ex s_page l_html l_css l_js n_ex n_css n_js <<<"$stats"

gzip -9 -n -c "$PAGE" > "$GZ.part"
gzip -t "$GZ.part"
mv "$GZ.part" "$GZ"
s_gz=$(python3 -c 'import os, sys; print(os.path.getsize(sys.argv[1]))' "$GZ")

t1=$(python3 -c 'import time; print(time.time_ns())')
kb() { awk -v b="$1" 'BEGIN { printf "%.1f KB", b / 1024 }'; }
ms=$(( (t1 - t0) / 1000000 ))
ratio=$(awk -v a="$s_gz" -v b="$s_page" 'BEGIN { printf "%.1f%%", 100 * a / b }')

echo "${B}console page${X}  ${G}built${X} in ${ms} ms"
printf "  %-9s %-11s %6s lines  %10s\n" sources index.html "$l_html" "$(kb "$s_html")"
printf "  %-9s %-11s %6s lines  %10s\n" "" "app.css+$((n_css - 1))" "$l_css" "$(kb "$s_css")"
printf "  %-9s %-11s %6s lines  %10s\n" "" "app.js+$((n_js - 1))" "$l_js" "$(kb "$s_js")"
printf "  %-9s %-11s %6s prompts%10s\n" "" examples "$n_ex" "$(kb "$s_ex")"
printf "  %-9s ${C}%-40s${X} %10s\n" page "${PAGE#"$ROOT"/}" "$(kb "$s_page")"
printf "  %-9s ${C}%-40s${X} %10s  ${D}(%s of the page)${X}\n" "gzip -9" "${GZ#"$ROOT"/}" "$(kb "$s_gz")" "$ratio"
echo "${B}stats${X}  $((1 + n_css + n_js)) source files ($n_css stylesheets, $n_js scripts) + $n_ex example prompts inlined, page $(kb "$s_page") -> gzip $(kb "$s_gz") ($ratio), ${ms} ms"
echo "  ${D}next: rebuild yue-server to embed it (this script never runs cmake); test with tools/mock_server.py${X}"
