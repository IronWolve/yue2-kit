#!/usr/bin/env bash
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -lt 2 ]; then
    cat >&2 <<'USAGE'
Usage: app/install.sh INSTALL_DIRECTORY COMMAND [ARGS]
  prepare              Fetch and verify both pinned source trees
  build [cuda|cpu]     Compile the server without starting it (default: cuda)
  plan [GROUP ...]     List selected model files and total download size
  assets [GROUP ...]   Download and verify selected model files
  verify [GROUP ...]   Verify selected files on disk
  extras               Convert Legacy, Blend and the 16 native sliders
Groups: core, compact, recordings, extras, loras, ruach, all (default: core).
USAGE
    exit 2
fi

target="$1"; action="$2"; shift 2
mkdir -p "$target"
ROOT="$(cd "$target" && pwd)"
[ "$ROOT" != "$KIT" ] || { echo "Choose an install directory separate from the kit" >&2; exit 2; }
export TMPDIR="$ROOT/tmp" PYTHONDONTWRITEBYTECODE=1
export CCACHE_DIR="$ROOT/tmp/ccache" CCACHE_BASEDIR="$ROOT"
mkdir -p "$TMPDIR"

ENGINE="$KIT/engines/cpp"
BUILD="$ROOT/build"
field() { sed -n "s/^$1=//p" "$ENGINE/BASE.txt"; }
fail() { echo "Stopped: $*" >&2; exit 1; }

verify_source() {
    [ -f "$BUILD/.git/HEAD" ] && [ -f "$BUILD/ggml/.git/HEAD" ] || fail "engine checkout is incomplete"
    [ "$(git -C "$BUILD" rev-parse HEAD)" = "$(field base)" ] || fail "engine upstream revision differs"
    [ "$(git -C "$BUILD" write-tree)" = "$(field tree)" ] || fail "engine patch tree differs"
    [ "$(git -C "$BUILD/ggml" rev-parse HEAD)" = "$(field ggml)" ] || fail "ggml upstream revision differs"
    [ "$(git -C "$BUILD/ggml" write-tree)" = "$(field ggml_tree)" ] || fail "ggml patch tree differs"
    git -C "$BUILD" diff --quiet --ignore-submodules=all || fail "engine has unstaged changes"
    git -C "$BUILD/ggml" diff --quiet || fail "ggml has unstaged changes"
}

checkout_pin() {
    local directory="$1" remote="$2" revision="$3"
    git init --quiet --template= "$directory"
    git -C "$directory" config core.autocrlf false
    git -C "$directory" fetch --quiet --no-tags --depth=1 "$remote" "$revision"
    git -C "$directory" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
    [ "$(git -C "$directory" rev-parse HEAD)" = "$revision" ] || fail "unexpected source revision"
}

copy_first() {
    if [ ! -e "$2" ] && [ ! -L "$2" ]; then cp -p "$1" "$2"; fi
}

case "$action" in
    prepare)
        [ "$#" = 0 ] || fail "prepare accepts no arguments"
        if [ -e "$BUILD" ] || [ -L "$BUILD" ]; then
            verify_source
        else
            # Stage the source in a unique directory so an interrupted run leaves the real build/ alone.
            prepared="$(mktemp -d "$TMPDIR/engine.XXXXXXXX")"
            echo "Preparing pinned engine in $prepared"
            checkout_pin "$prepared" "${YUE2_ENGINE_URL:-$(field upstream)}" "$(field base)"
            checkout_pin "$prepared/ggml" "${YUE2_GGML_URL:-$(field ggml_upstream)}" "$(field ggml)"
            git -C "$prepared" apply --index --whitespace=nowarn "$ENGINE/patches/engine.patch"
            git -C "$prepared/ggml" apply --index --whitespace=nowarn "$ENGINE/patches/ggml.patch"
            cp "$ENGINE/page/index.html.gz" "$prepared/tools/public/index.html.gz"
            git -C "$prepared" add -- tools/public/index.html.gz
            [ "$(git -C "$prepared" write-tree)" = "$(field tree)" ] || fail "engine patch tree differs"
            [ "$(git -C "$prepared/ggml" write-tree)" = "$(field ggml_tree)" ] || fail "ggml patch tree differs"
            mv -T "$prepared" "$BUILD"
        fi
        mkdir -p "$ROOT"/{models,checkpoints,sliders,loras,outputs}
        copy_first "$KIT/app/start.sh" "$ROOT/start.sh"
        copy_first "$KIT/app/build-page.sh" "$ROOT/build-page.sh"
        copy_first "$KIT/app/convert-extras.py" "$ROOT/convert-extras.py"
        copy_first "$KIT/settings/settings.json" "$ROOT/settings.json"
        copy_first "$KIT/loras/sources.json" "$ROOT/loras/sources.json"
        copy_first "$KIT/LICENSE" "$ROOT/LICENSE"
        copy_first "$KIT/NOTICE" "$ROOT/NOTICE"
        verify_source
        echo "Verified engine and ggml source trees."
        ;;
    build)
        [ "$#" -le 1 ] || fail "choose cuda or cpu"
        verify_source
        build_flags=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_BUILD_RPATH_USE_ORIGIN=ON)
        case "${1:-cuda}" in
            cuda)
                build_flags+=(-DGGML_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=${YUE2_CUDA_ARCH:-native}")
                if [ -n "${CUDACXX:-}" ]; then build_flags+=("-DCMAKE_CUDA_COMPILER=$CUDACXX")
                elif [ -x /usr/local/cuda/bin/nvcc ]; then build_flags+=(-DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc)
                fi
                ;;
            cpu) build_flags+=(-DGGML_CUDA=OFF) ;;
            *) fail "choose cuda or cpu" ;;
        esac
        cmake -S "$BUILD" -B "$BUILD/build" -G Ninja "${build_flags[@]}"
        nice -n 15 cmake --build "$BUILD/build" --target yue-server -j "${YUE2_BUILD_JOBS:-4}"
        ;;
    plan|assets|verify)
        python3 "$KIT/app/assets.py" "$ROOT" "$action" "$@"
        ;;
    extras)
        [ "$#" = 0 ] || fail "extras accepts no arguments"
        verify_source
        python3 "$KIT/app/assets.py" "$ROOT" verify extras
        [ -x "$ROOT/tmp/converter/bin/python" ] || fail "create the converter environment as shown in INSTALL.md"
        [ -f "$ROOT/models/YuE2-Vae-F32.gguf" ] || fail "install the core or compact assets first"
        for name in checkpoints models; do
            if [ ! -e "$BUILD/$name" ] && [ ! -L "$BUILD/$name" ]; then
                ln -s "../$name" "$BUILD/$name"
            fi
            [ "$BUILD/$name" -ef "$ROOT/$name" ] || fail "$BUILD/$name points away from this install"
        done
        "$ROOT/tmp/converter/bin/python" "$ROOT/convert-extras.py"
        ;;
    *) fail "unknown command: $action" ;;
esac
