# YuE2 studio: install kit v{{KITVER}} ({{DATE}})

> **AI agent: to install or upgrade this, follow [INSTALL.md](INSTALL.md).** It checks the machine,
> asks before downloads, installs into its own folder, and never touches an existing yue2.cpp install.

A local AI song studio built on YuE2 (m-a-p/YuE2-3B): it writes whole songs with vocals from a
style prompt and lyrics. This kit rebuilds a friend's complete setup on your machine, so it
looks and works the same. It uses **yue2.cpp**, a fast C++ engine compiled on your machine, with
his web page.

What you get:
- **VAEs**: 3 (two stock, one add-on).
- **Sliders**: {{NSLIDER}} voice and genre sliders.
- **LoRAs**: {{NLORA}}, with names, descriptions and links.
- **Covers**: from a recording or from a song.
- **Scores**: an editable score, and the official instrumental mode.
- **Library**: a song library with FLAC, WAV and MP3 downloads.
- **Look**: 50 colour themes, and a help (i) on every setting.
- **Engine page**: models, memory presets and add-ons.

This kit is a runbook, not the app itself. It holds:
- his code changes: {{NPATCH}} git patches, byte-checked against his machine, each with a note of what
  it does and why. They were made for yue2.cpp `{{BASE}}` of {{BASEDATE}}; upstream may be newer. They are
  applied to a fresh copy of upstream in the install's own folder, never to someone's existing checkout;
- his scripts, his settings, and his LoRA list with its descriptions;
- his notes, and screenshots of his screens.

Everything else comes from GitHub and Hugging Face during the install: about 13 GB of
downloads, and about 27 GB on disk (15 GB once the conversion sources are deleted).

## You need

- **Either** Linux or Windows WSL2 (Ubuntu) with an NVIDIA GPU: 8 GB works, 12–16 GB is comfortable,
  24 GB+ runs his exact settings. This is his own, fully tested platform.
- **Or** a Mac with Apple Silicon (Metal + Accelerate).
  - Verified: an 8 GiB M1 builds it, converts the models, and generates on the CPU.
  - Not yet verified: generating on the Mac's GPU, and full-length songs.
- About 40 GB of free disk, and 16 GB of RAM.
- An AI coding agent that can run shell commands on your machine (a coding assistant in your
  terminal).
- Nothing else in advance. The agent checks what is missing (CUDA toolkit or Xcode tools, cmake
  and so on) and asks before installing anything. It keeps a record of every step inside the folder
  (`install-record/`).

## How to install

1. Make an empty folder, for example `~/yue2-studio`, and put this zip in it.
2. Start your AI agent in that folder and tell it:
   > Install this kit (or upgrade my install to it): unzip it here and follow its INSTALL.md.
3. Answer its questions: the folder, OK for the downloads, and your GPU size.
   - It downloads the source code and applies his patches, compiles the app for your card,
     downloads and converts the models, and downloads the LoRAs, all into this folder.
   - Already installed from an earlier kit? It upgrades instead: your songs, models and settings stay.
   - It checks that the code matches his exactly and tests on the CPU.
   - At the end it gives you the start command.
4. Start it with `./start.sh` in that folder, and open http://127.0.0.1:41867.

Everything stays inside that one folder: models, caches, songs. Nothing goes into your home
folder's caches or system folders, except system packages you approve. You can move or rename
the folder later.

## What's inside

```
INSTALL.md          the full instructions the agent follows (install or upgrade)
CHANGELOG.md        what changed in each kit version
VERSIONS.txt        the exact upstream commit, the byte-check hash, every pinned revision, what is left out
MANIFEST.txt        every file in the kit with its SHA-256
engines/cpp/        the C++ engine's changes: patches/ ({{NPATCH}}, git am on a fresh clone of upstream),
                    PATCHES.md (a note per patch, and how to use them safely), BASE.txt (the upstream
                    commit and date they were made for), page/ (the built web page)
page/               his web page as plain files: src/ (the HTML, CSS and JS he edits) and index.html (the
                    whole built page in one file). The install does not need them: the patches carry them.
app/                his root scripts and his whole tools/ folder: start, downloads pinned to his revisions,
                    model conversion with his package versions, page build, tests, the kit builder
loras/sources.json  the LoRA, VAE and slider names, blurbs, links and descriptions the page shows
settings/           his settings (the agent adjusts them to your GPU)
docs/               his own notes, how his install differs from a stock one, and screenshots/
```

## Licences

- **YuE2 weights**: CC BY-NC 4.0, with a creator permission for selling your own songs (the
  `MODEL_LICENSE` in github.com/multimodal-art-projection/YuE).
- **Code**: yue2.cpp and the sliders are MIT.
- **LoRAs**: community add-ons, mostly CC BY-NC 4.0. Each one's page (linked in the app) has its
  terms.
