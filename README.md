# yue2-kit

YuE2 install kit with new features, LoRAs, VAEs and more.

YuE2 writes whole songs, vocals included, from a style prompt and lyrics. This kit sets it up on
**yue2.cpp**, a fast C++ engine, with my patches, my web page, 11 LoRAs, 3 VAEs and
16 voice and genre sliders.

> **AI agent:** to install or upgrade, follow [INSTALL.md](INSTALL.md).

## Install

1. Put this kit in an empty folder: the zip, or a clone of this repo.
2. Start your AI coding agent in that folder and say: *install this kit, follow its INSTALL.md*.
3. When it finishes, run `./start.sh` and open http://127.0.0.1:41867.

The agent asks before it installs or downloads anything (about 13 GB). Everything stays in that one
folder, and it never changes an existing yue2.cpp install.

## You need

- Linux or Windows WSL2, with an NVIDIA GPU: 8 GB works, 24 GB+ runs my settings.
- About 40 GB of free disk and 16 GB of RAM.
- On a Mac, read [app/tools/kit/MACOS-NOTES.md](app/tools/kit/MACOS-NOTES.md) first.

## What's inside

```
engines/cpp/   38 patches for yue2.cpp f17d526 (2026-09-24), with a note for each
page/          the web page as plain files
app/           scripts: start, downloads, model conversion, tests
loras/         LoRA, VAE and slider sources
docs/          notes and screenshots
```

What changed: [CHANGELOG.md](CHANGELOG.md).

## Credits

Customized Collection by SeattleSysop ([github.com/IronWolve](https://github.com/IronWolve)).

Built on [YuE2](https://map-yue2.github.io/), [yue2.cpp](https://github.com/ServeurpersoCom/yue2.cpp)
and [ggml](https://github.com/ggml-org/ggml).

Licences: the YuE2 weights are CC BY-NC 4.0; yue2.cpp and the sliders are MIT; each LoRA's own page
has its terms.
