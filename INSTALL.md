# Install yue2-kit v13

Use a separate, writable Linux or WSL2 directory on a filesystem that supports symbolic links and hard links. Keep the extracted kit or its Git checkout available while installing. The engine build and model downloads are separate steps. Run them only where you have permission to fetch the listed files and use the necessary compute.

You need Git, curl, Bash, a C++17 compiler, CMake 3.24 or newer, Ninja and Python 3.11 or newer. For the GPU build you also need an NVIDIA driver, a CUDA toolkit that supports your GPU architecture, and the toolkit's supported host compiler. The CPU build provides a way to test on machines without CUDA. v13 validation on this machine used Linux/WSL2. The v13 macOS and native Windows builds have not been validated.

From the kit directory:

```bash
install_dir="$PWD/../YuE2 Studio v13"
app/install.sh "$install_dir" plan core
app/install.sh "$install_dir" prepare
app/install.sh "$install_dir" build cuda
app/install.sh "$install_dir" assets core
```

`prepare` fetches two exact upstream commits and verifies the patched engine and GGML trees independently. On repeated runs it verifies the same trees. Use a new directory if an existing tree differs. `build` builds the server and leaves it stopped. Set `YUE2_BUILD_JOBS` to change the build's default four jobs. If automatic CUDA architecture detection fails, set `YUE2_CUDA_ARCH` to the installed GPU's architecture, such as `120a` on an RTX 5090 with a compatible toolkit. Set `CUDACXX` to the absolute path to nvcc if needed.

The default `core` group downloads stock BF16 and the Standard decoder. You can use `compact` in place of `core` for Q5_K_M and the Standard decoder. The launcher uses Q5_K_M when it is the only installed backbone. Multiple groups may be selected in one command, and shared files are counted once.

| Group | Downloads |
| --- | ---: |
| `core` | 7.70 GB stock BF16 and Standard VAE |
| `compact` | 3.15 GB stock Q5_K_M and Standard VAE |
| `recordings` | 2.93 GB split SheetSage2, MERT and audio tokenizer |
| `extras` | 1.32 GB sources for Legacy, Blend and the 16 particle sliders |
| `loras` | 15.20 GB across 90 adapters and their loader settings |
| `ruach` | 15.94 GB for two Tsunami Wave BF16 backbones and RS x3 v1/v2 decoders |

Use `app/install.sh "$install_dir" plan all` for the full download size. Allow additional disk space for Git, compiler output and converted files. `assets` verifies every installed file against the pinned size and SHA-256. A differing existing file remains in place and is reported. Use `verify` to check selected files without fetching them.

To install and convert the optional Legacy, Blend and particle assets, use a Python 3.12 or newer interpreter that supports the pinned packages:

```bash
app/install.sh "$install_dir" assets extras
python3 -m venv "$install_dir/tmp/converter"
TMPDIR="$install_dir/tmp" PIP_CACHE_DIR="$install_dir/tmp/pip-cache" \
  "$install_dir/tmp/converter/bin/python" -m pip install -r app/converter-requirements.txt
app/install.sh "$install_dir" extras
```

To start the server:

```bash
cd "$install_dir"
./start.sh
```

Open <http://127.0.0.1:41867>. For a CPU build, use `YUE2CPP_DEVICE=CPU ./start.sh`. For a preflight that leaves the server stopped, use `YUE2CPP_DRY_RUN=1 ./start.sh`. The normal server binds to loopback. Settings are stored in `settings.json` and generated takes in `outputs/` beside the launcher. Model files, LoRAs, checkpoints, caches and the build live inside the selected installation directory.

## Upgrade from v12

Install v13 beside the existing installation. Before switching, verify the new launcher in dry-run mode, then stop the old server before starting the new one on the same port. Copy the old `outputs/` into the new installation to carry over the library, and copy `settings.json` if you want to retain your presets. Keep the v12 installation available for rollback. Use v13's refreshed LoRA metadata and split recording assets. When reusing weights, check each file with `verify` against the v13 manifest first.

The new Tsunami Wave and RS x3 options are optional. Selecting a Tsunami Wave backbone clears the current stock-model slider and LoRA selections in the page. The Kit can still apply them if reselected, but their audible result on the fine-tune is experimental.
