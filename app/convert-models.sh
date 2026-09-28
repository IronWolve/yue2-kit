#!/usr/bin/env bash
# Make yue2.cpp's GGUF files from checkpoints already on disk, instead of
# downloading them. Reads build/checkpoints (a link to the folder holding
# YuE2-3B, YuE2-Vae, SheetSage2, MERT-v2-FullSong: a shared model library or the
# install's own checkpoints/), writes build/models and sliders/. Complete outputs are skipped.
#
#   YuE2-3B-BF16.gguf     7.2 GB  main model, byte-exact BF16
#   YuE2-Vae-F32.gguf     0.5 GB  Standard VAE (+ Legacy, Blend and the 16 sliders via convert-extras.py)
#   SheetSage2-F32.gguf   2.6 GB  transcriber (SheetSage2 + MERT), for covers
#
# Interruptions: every output is written as <name>.partial and renamed when complete
# (tools/gguf_atomic.py); an output an earlier run left incomplete is found (tools/gguf_check.py),
# removed and made again.
# Low memory: YUE2_LOWMEM=1 (automatic below 16 GiB of RAM; YUE2_LOWMEM=0 turns it off) keeps the
# tensors in a temporary file in tmp/ instead of RAM, which needs about 7.5 GB more free disk while
# the backbone converts. The output bytes are the same either way.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' D=$'\e[2m' B=$'\e[1m' X=$'\e[0m'
export TMPDIR="$ROOT/tmp" PIP_CACHE_DIR="$ROOT/tmp/pip-cache" PYTHONNOUSERSITE=1
PY="$ROOT/tmp/venv/bin/python"
# portable helpers (no GNU df/readlink needed)
real() { python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
free_gb() { python3 -c 'import shutil, sys; print(shutil.disk_usage(sys.argv[1]).free // 2**30)' "$1"; }
ram_gb() { python3 -c 'import os; print(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // 2**30)'; }

for need in YuE2-3B YuE2-Vae SheetSage2 MERT-v2-FullSong; do
    if [ ! -d "$ROOT/build/checkpoints/$need" ]; then
        echo "${R}missing${X} checkpoint $need in $(real "$ROOT/build/checkpoints")"
        exit 1
    fi
done

if [ ! -x "$PY" ]; then
    python3 -m venv "$ROOT/tmp/venv"
fi
# tools/converter-requirements.txt, shipped in the friend kit, pins the converter's packages to its
# owner's versions (so the GGUFs come out the same); without it the versions below are used.
# The check compares the installed versions, not just whether the imports work.
REQ="$ROOT/tools/converter-requirements.txt"
pins_ok() {
    "$PY" - "$REQ" <<'PYCHK'
import subprocess, sys
norm = lambda n: n.lower().replace("_", "-")
want = {norm(l.split("==")[0]): l.split("==")[1].strip() for l in open(sys.argv[1]) if "==" in l and not l.startswith("#")}
out = subprocess.run([sys.executable, "-m", "pip", "freeze"], capture_output=True, text=True).stdout
have = {norm(l.split("==")[0]): l.split("==")[1].strip() for l in out.splitlines() if "==" in l}
bad = [f"{k} {have.get(k, 'missing')} (pinned {v})" for k, v in want.items() if have.get(k) != v]
print(", ".join(bad)); sys.exit(1 if bad else 0)
PYCHK
}
if [ -f "$REQ" ]; then
    if ! pins_ok >/dev/null; then
        echo "${D}installing the converter's pinned packages into tmp/venv${X}"
        if "$ROOT/tmp/venv/bin/pip" install --quiet -r "$REQ" && diff_out=$(pins_ok); then
            echo "${D}converter packages match $(basename "$REQ")${X}"
        else
            echo "${Y}the pinned converter packages do not install on this Python${X} ${D}($("$PY" --version); ${diff_out:-}); using the defaults below${X}"
            "$ROOT/tmp/venv/bin/pip" install --quiet gguf numpy "mir_eval==0.8.2" "pretty_midi==0.2.10" "setuptools==78.1.1" safetensors
        fi
    fi
elif ! "$PY" -c "import gguf, numpy, mir_eval, pretty_midi, safetensors" 2>/dev/null; then
    echo "${D}installing the converter's packages into tmp/venv${X}"
    # pretty_midi 0.2.10 still imports pkg_resources, which newer setuptools dropped
    "$ROOT/tmp/venv/bin/pip" install --quiet gguf numpy "mir_eval==0.8.2" "pretty_midi==0.2.10" "setuptools==78.1.1" safetensors
fi
"$PY" -c "import gguf, numpy, mir_eval, pretty_midi, safetensors" || { echo "${R}the converter's packages do not import${X}"; exit 1; }

# low memory: automatic below 16 GiB of RAM (unified memory on a Mac counts: it is shared with the system)
LOW="${YUE2_LOWMEM:-}"
[ -n "$LOW" ] || { [ "$(ram_gb)" -lt 16 ] && LOW=1 || LOW=0; }
LOWARG=(); [ "$LOW" = 1 ] && LOWARG=(--low-memory)
mkdir -p "$ROOT/sliders"
free_before=$(free_gb "$ROOT/build/models/")
need_gb=$([ "$LOW" = 1 ] && echo 22 || echo 15)    # 13.1 GB of outputs (+ a 7.5 GB temporary file in low-memory mode)
[ "$free_before" -ge "$need_gb" ] || echo "${Y}only ${free_before} GB free; converting everything needs about ${need_gb} GB${X} ${D}(complete outputs are skipped)${X}"

# outputs an interrupted run left behind: .partial files, and anything that is not a complete GGUF
cleaned=0
for f in "$ROOT"/build/models/*.partial "$ROOT"/sliders/*.partial; do
    [ -e "$f" ] && { rm -f "$f"; cleaned=$((cleaned + 1)); }
done
for f in "$ROOT"/build/models/*.gguf "$ROOT"/sliders/*.gguf; do
    [ -e "$f" ] || continue
    if ! python3 "$ROOT/tools/gguf_check.py" complete "$f" >/dev/null 2>&1; then
        echo "${Y}incomplete${X} $(basename "$f") ${D}(an earlier run was interrupted): made again${X}"
        rm -f "$f"; cleaned=$((cleaned + 1))
    fi
done

start=$(date +%s)
echo "${D}converting$([ "$LOW" = 1 ] && echo " in low-memory mode (tensors wait in a temporary file in tmp/)")${X}"
cd "$ROOT/build"
nice -n 15 "$PY" "$ROOT/tools/gguf_atomic.py" ${LOWARG[@]+"${LOWARG[@]}"} convert.py
# Legacy + Blend VAEs and the 16 sliders
nice -n 15 "$PY" "$ROOT/tools/gguf_atomic.py" ${LOWARG[@]+"${LOWARG[@]}"} "$ROOT/convert-extras.py"
secs=$(( $(date +%s) - start ))
free_after=$(free_gb "$ROOT/build/models/")

# every output must now be a complete GGUF
bad=0
for f in "$ROOT"/build/models/*.gguf "$ROOT"/sliders/*.gguf; do
    [ -e "$f" ] || continue
    python3 "$ROOT/tools/gguf_check.py" complete "$f" >/dev/null 2>&1 || { echo "${R}incomplete${X} $(basename "$f")"; bad=$((bad + 1)); }
done

echo
echo "${B}converted${X} in ${secs}s into $(real "$ROOT/build/models")$([ "$LOW" = 1 ] && echo " ${D}(low-memory mode)${X}")"
for f in "$ROOT"/build/models/*.gguf; do
    [ -f "$f" ] && echo "  ${G}$(basename "$f")${X}  ${D}$(du -h "$f" | cut -f1)${X}"
done
echo "  sliders: $(ls "$ROOT"/sliders/*.gguf 2>/dev/null | wc -l | tr -d ' ') GGUF files, catalog $([ -f "$ROOT/sliders/catalog.json" ] && echo present || echo "${R}missing${X}")"
echo "  leftovers from an interrupted run removed: $cleaned; incomplete now: $([ $bad = 0 ] && echo "${G}0${X}" || echo "${R}$bad${X}")"
echo "  disk free ${free_before}G -> ${free_after}G"
[ "$bad" = 0 ]
