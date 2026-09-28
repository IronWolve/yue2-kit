#!/usr/bin/env bash
# The install's own record, kept inside the install (install-record/): every step's command, start and end
# time, exit status, attempt number and full output; the adaptations made on this machine, in words; and
# the tool versions and pins. The runbook sends every stage through this, so a finished install can show
# exactly what ran, what failed, what was retried and what was changed from the runbook.
#
#   tools/record.sh STAGE -- COMMAND [ARGS...]   run it, log it, and return its exit status
#   tools/record.sh note "TEXT"                  an adaptation or a decision, with the time
#   tools/record.sh versions                     tool versions, the code tree and every pin, into the record
#   tools/record.sh show                         the steps so far, one line each
#
#   install-record/steps.jsonl    one line per step: stage, command, start, end, seconds, exit, attempt, log
#   install-record/logs/          the full output of every step
#   install-record/notes.md       the notes
#   install-record/versions-*.txt the version snapshots
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REC="$ROOT/install-record"; mkdir -p "$REC/logs"
now() { python3 -c 'import datetime; print(datetime.datetime.now().astimezone().isoformat(timespec="seconds"))'; }

case "${1:-}" in
  note)
    shift; printf -- '- %s  %s\n' "$(now)" "$*" >> "$REC/notes.md"; echo "noted in install-record/notes.md" ;;
  versions)
    f="$REC/versions-$(date +%Y%m%d-%H%M%S).txt"
    {
      echo "# $(now)"; uname -a
      [ "$(uname -s)" = Darwin ] && sw_vers 2>/dev/null
      for c in "python3 --version" "cmake --version" "ninja --version" "git --version" "node --version" \
               "nvcc --version" "clang --version" "gcc --version"; do
        set -- $c; command -v "$1" >/dev/null && { echo "## $c"; $c 2>&1 | head -3; }
      done
      echo "## code tree"; git -C "$ROOT/build" rev-parse 'HEAD^{tree}' 2>/dev/null
      for p in tools/hf-revisions.txt tools/downloader-requirements.txt tools/converter-requirements.txt; do
        [ -f "$ROOT/$p" ] && { echo "## $p"; cat "$ROOT/$p"; }
      done
      for v in tmp/hf-venv tmp/venv; do
        [ -x "$ROOT/$v/bin/python" ] && { echo "## $v (pip freeze)"; "$ROOT/$v/bin/python" -m pip freeze 2>/dev/null; }
      done
    } > "$f" 2>&1
    echo "versions saved to ${f#$ROOT/}" ;;
  show)
    python3 - "$REC/steps.jsonl" <<'PY'
import json, sys
try:
    for line in open(sys.argv[1]):
        s = json.loads(line)
        print(f"{s['start'][:19]}  {'ok ' if s['exit'] == 0 else 'ERR'} {s['exit']:>3}  try {s['attempt']}  {s['seconds']:>6.0f} s  {s['stage']}")
except FileNotFoundError:
    print("no steps recorded yet")
PY
    ;;
  "" | -h | --help)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)
    stage="$1"; shift
    [ "${1:-}" = "--" ] && shift
    [ $# -gt 0 ] || { echo "usage: tools/record.sh STAGE -- COMMAND [ARGS...]"; exit 2; }
    prev=0; [ -f "$REC/steps.jsonl" ] && prev=$(awk -v s="\"stage\": \"$stage\"" 'index($0, s) {n++} END {print n + 0}' "$REC/steps.jsonl")
    attempt=$(( prev + 1 ))
    log="logs/$(date +%Y%m%d-%H%M%S)-$(printf '%s' "$stage" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-40)-$attempt.log"
    start=$(now); t0=$(date +%s)
    "$@" 2>&1 | tee "$REC/$log"
    rc=${PIPESTATUS[0]}
    python3 - "$REC/steps.jsonl" "$stage" "$start" "$(now)" "$(( $(date +%s) - t0 ))" "$rc" "$attempt" "$log" "$@" <<'PY'
import json, shlex, sys
out, stage, start, end, secs, rc, attempt, log, *cmd = sys.argv[1:]
with open(out, "a") as f:
    f.write(json.dumps({"stage": stage, "command": shlex.join(cmd), "start": start, "end": end,
                        "seconds": int(secs), "exit": int(rc), "attempt": int(attempt), "log": log}) + "\n")
PY
    exit "$rc" ;;
esac
