#!/usr/bin/env bash
# yue2.cpp: the C++ YuE2 server and its own browser page.
# Everything it needs lives in this folder: build/ (the engine: upstream plus the patches, compiled in build/build), models/, tmp/.
#
#   ./start.sh                      the backbone settings.json picks (else the first one present)
#   YUE2CPP_QUANT=Q8_0 ./start.sh   a given backbone copy, if present
#   YUE2CPP_PORT=41868 ./start.sh   another port
#   YUE2CPP_DRY_RUN=1 ./start.sh    only print the server command it would run
#   YUE2CPP_FP16_MATMUL=0 ./start.sh   keep BF16 maths on an RTX 20 / Volta card (the matmul block below)
#
# Extra arguments go to yue-server (for example --keep-loaded).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TMPDIR="$ROOT/tmp"

G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' D=$'\e[2m' B=$'\e[1m' X=$'\e[0m' C=$'\e[36m'
# plain text when NO_COLOR is set or the output is not a terminal (a log file, a pipe), like the server's log
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then G="" Y="" R="" D="" B="" X="" C=""; fi

PORT="${YUE2CPP_PORT:-41867}"
# The backbone: YUE2CPP_QUANT, else the one settings.json picks (the page saves it there), else the
# first copy present. Resolved before any file is required, so a Q5_K_M-only install starts.
QUANT="${YUE2CPP_QUANT:-}"
if [ -z "$QUANT" ] && [ -f "$ROOT/settings.json" ]; then
    QUANT=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("model") or "")' "$ROOT/settings.json" 2>/dev/null || true)
fi
if [ -z "$QUANT" ] || [ ! -f "$ROOT/models/YuE2-3B-$QUANT.gguf" ]; then
    wanted="$QUANT"; QUANT=""
    for q in BF16 Q8_0 Q6_K Q5_K_M; do [ -f "$ROOT/models/YuE2-3B-$q.gguf" ] && { QUANT="$q"; break; }; done
    [ -n "$wanted" ] && [ -n "$QUANT" ] && echo "${Y}no models/YuE2-3B-$wanted.gguf${X}: using $QUANT"
    [ -n "$QUANT" ] || QUANT="${wanted:-BF16}"      # nothing present: the check below names what is missing
fi
BIN="$ROOT/build/build/yue-server"
MODEL="$ROOT/models/YuE2-3B-$QUANT.gguf"
VAE="$ROOT/models/YuE2-Vae-F32.gguf"
SLIDERS="$ROOT/sliders"
OUTPUTS="$ROOT/outputs"
TRANSCRIBER="$ROOT/models/SheetSage2-Q8_0.gguf"     # downloaded; convert-models.sh makes F32
[ -f "$TRANSCRIBER" ] || TRANSCRIBER="$ROOT/models/SheetSage2-F32.gguf"

missing=0
for f in "$BIN" "$MODEL" "$VAE"; do
    if [ ! -f "$f" ]; then
        echo "${R}missing${X} ${f#$ROOT/}"
        missing=1
    fi
done
if [ "$missing" = 1 ]; then
    echo "${D}build: the cmake line in LOCAL-CHANGES.md (or the install kit); models: tools/download-checkpoints.sh then ./convert-models.sh, or ./download-models.sh${X}"
    exit 1
fi

size() { du -h "$1" 2>/dev/null | cut -f1 | tr -d ' '; }
count() { wc -l | tr -d ' '; }          # macOS pads wc's number with spaces
row() { printf '  %s%-12s%s %s\n' "$C" "$1" "$X" "$2"; }
args=(--host 127.0.0.1 --port "$PORT" --model "$QUANT=$MODEL" --vae "standard=$VAE" --outputs "$OUTPUTS"
      --max-batch "${YUE2CPP_BATCH:-2}" --settings "$ROOT/settings.json")
# every other backbone that is present can be picked in the page (Engine -> Model)
models="${B}$QUANT${X} $(size "$MODEL") ${G}starts${X}"
for q in BF16 Q8_0 Q6_K Q5_K_M; do
    if [ "$q" != "$QUANT" ] && [ -f "$ROOT/models/YuE2-3B-$q.gguf" ]; then
        args+=(--model "$q=$ROOT/models/YuE2-3B-$q.gguf")
        models="$models, ${B}$q${X} $(size "$ROOT/models/YuE2-3B-$q.gguf")"
    fi
done
vaes="${B}standard${X}"
for extra in legacy blend; do
    if [ -f "$ROOT/models/YuE2-Vae-$extra-F32.gguf" ]; then
        args+=(--vae "$extra=$ROOT/models/YuE2-Vae-$extra-F32.gguf")
        vaes="$vaes, ${B}$extra${X}"
    fi
done

# The GPU: one query for its name, memory and compute capability (NVIDIA), else what runs instead.
# Older NVIDIA cards (compute capability 7.x: RTX 20, Volta) have FP16 but no BF16 tensor cores, so BF16
# prefills and the sound stage fall back to their FP32 cores. --fp16-matmul runs those on the FP16 tensor
# cores (measured on an RTX 2070 laptop: sound stage 9.25 -> 3.4 s per step, a song 440 -> 215 s). Newer
# cards have BF16 tensor cores and older ones none, so it stays off there. YUE2CPP_FP16_MATMUL=0 keeps
# it off, =1 forces it on.
CC="" GPU_NAME="" GPU_USED="" GPU_TOTAL=""
SMI="$(command -v nvidia-smi 2>/dev/null || true)"
if [ -z "$SMI" ] && [ -x /usr/lib/wsl/lib/nvidia-smi ]; then SMI=/usr/lib/wsl/lib/nvidia-smi; fi
if [ -n "$SMI" ]; then
    IFS=, read -r GPU_NAME GPU_USED GPU_TOTAL CC <<EOF
$("$SMI" --query-gpu=name,memory.used,memory.total,compute_cap --format=csv,noheader,nounits 2>/dev/null | head -1 || true)
EOF
    CC="$(printf '%s' "$CC" | tr -d ' ')"
fi
ON_GPU=1
if [ "${CUDA_VISIBLE_DEVICES-all}" = "" ]; then ON_GPU=0; fi
case "${GGML_BACKEND:-}" in CPU*) ON_GPU=0 ;; esac
FP16_MATMUL="${YUE2CPP_FP16_MATMUL:-auto}"
why="forced by YUE2CPP_FP16_MATMUL=1"
if [ "$FP16_MATMUL" = auto ]; then
    FP16_MATMUL=0
    why="compute $CC has no BF16 tensor cores; YUE2CPP_FP16_MATMUL=0 turns it off"
    case "$ON_GPU/$CC" in 1/7.*) FP16_MATMUL=1 ;; esac
fi
[ "$FP16_MATMUL" = 1 ] && args+=(--fp16-matmul)

# The page's address as a terminal hyperlink (OSC 8) when printing to a terminal: clickable even where
# the terminal does not spot links itself. Terminals without OSC 8 show the plain address; so do logs.
URL="http://127.0.0.1:$PORT"
TTY=0; [ -t 1 ] && TTY=1      # tested here: inside $(...) stdout is a pipe
link() { if [ "$TTY" = 1 ]; then printf '\e]8;;%s\e\\%s\e]8;;\e\\' "$1" "$1"; else printf '%s' "$1"; fi; }
echo "${B}yue2.cpp${X}  ${G}$(link "$URL")${X}"
if [ -n "$GPU_NAME" ] && [ "$ON_GPU" = 1 ]; then
    row gpu "${B}$(printf '%s' "$GPU_NAME" | sed 's/^ *//')${X} ${D}·${X} $(awk -v u="$GPU_USED" -v t="$GPU_TOTAL" 'BEGIN { printf "%.1f of %.1f GiB in use", u / 1024, t / 1024 }') ${D}· compute $CC${X}"
elif [ -n "$GPU_NAME" ]; then
    row gpu "${Y}hidden${X}: this run uses the CPU ${D}(GGML_BACKEND=CPU or an empty CUDA_VISIBLE_DEVICES)${X}"
elif [ "$(uname -s)" = Darwin ]; then
    row gpu "Apple GPU (Metal) ${D}· memory shared with macOS${X}"
else
    row gpu "${Y}no NVIDIA GPU found${X}: runs on the CPU ${D}(slow)${X}"
fi
if [ "$FP16_MATMUL" = 1 ]; then
    row matmul "${G}FP16 tensor cores${X} ${D}($why)${X}"
fi
row backbones "$models  ${D}(the Engine page picks; settings.json remembers)${X}"
row vaes "$vaes"
LORAS="$ROOT/loras"
if [ -d "$LORAS" ]; then
    args+=(--loras "$LORAS")
    row loras "${B}$(find -L "$LORAS" -name '*.safetensors' -not -path '*/.*' 2>/dev/null | count)${X} files in ${B}$(find -L "$LORAS" -mindepth 1 -maxdepth 1 -type d -not -name '.*' 2>/dev/null | count)${X} folders ${D}· $(du -shL "$LORAS" 2>/dev/null | cut -f1 | tr -d ' ') · loras/: files, folders or links${X}"
fi
if [ -f "$SLIDERS/catalog.json" ]; then
    args+=(--sliders "$SLIDERS")
    row sliders "${B}$(ls "$SLIDERS"/*.gguf 2>/dev/null | count)${X} voice/genre sliders"
else
    row sliders "${Y}not converted${X} ${D}(./convert-models.sh)${X}"
fi
row library "${B}$(find "$OUTPUTS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | count)${X} songs ${D}· $(du -sh "$OUTPUTS" 2>/dev/null | cut -f1 | tr -d ' ') in ${OUTPUTS#$ROOT/}/${X}"
if [ -f "$TRANSCRIBER" ]; then
    args+=(--transcriber "$TRANSCRIBER")
    row transcriber "$(basename "$TRANSCRIBER") ${D}· $(size "$TRANSCRIBER") · covers from a recording${X}"
else
    row transcriber "${Y}not downloaded${X} ${D}(covers from a recording are off)${X}"
fi
if [ -f "$ROOT/settings.json" ]; then
    engine=$(python3 -c '
import json, sys
s = json.load(open(sys.argv[1]))
seq = s.get("max_seq") or 0
print("models " + ("kept loaded" if s.get("keep_loaded") else "unloaded after each song"),
      "context " + ("whole" if not seq else f"{seq:,}"), "VAE tiles " + str(s.get("vae_core", 512)), sep=" · ")' "$ROOT/settings.json" 2>/dev/null || true)
    row engine "${engine:-${Y}settings.json unreadable${X}} ${D}· up to ${YUE2CPP_BATCH:-2} songs per pass${X}"
else
    row engine "defaults ${D}(no settings.json yet: the Engine page saves one) · up to ${YUE2CPP_BATCH:-2} songs per pass${X}"
fi
echo "  ${D}Ctrl-C to stop · NO_COLOR=1 for a plain log${X}"

cd "$ROOT"
if [ -n "${YUE2CPP_DRY_RUN:-}" ]; then
    printf '%q ' "$BIN" "${args[@]}" "$@"; echo
    exit 0
fi
exec "$BIN" "${args[@]}" "$@"
