# yue2-kit v13

Generate full songs from a style prompt and lyrics in a local browser studio powered by [YuE2](https://map-yue2.github.io/) and [yue2.cpp](https://github.com/ServeurpersoCom/yue2.cpp). Original kit contributions are covered by the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. Third-party files retain their existing terms.

[Install or upgrade](INSTALL.md) · [What changed](CHANGELOG.md) · [Pinned versions](VERSIONS.txt)

![The v13 YuE2 studio showing the song form, player, and take library](docs/screenshots/song-page.png)

- Generate with Full Plan, Melody Only, Direct or Instrumental mode. Edit the score, re-render a take, or continue a saved song or a recording.
- Save takes with their prompts, scores and audio. Play a finished track while the rest of its batch renders. Export WAV, MP3 or FLAC from the library as available for the take.
- Choose from up to 90 LoRAs, 16 live particle sliders and five sound decoders. The kit includes source links, descriptions and trigger guidance in the Engine panel.
- Use the stock BF16 or Q5_K_M backbone. Two optional Tsunami Wave BF16 fine-tunes and the RS x3 decoders are available in their own download group.
- v13 fixes the CUDA abort caused by padding half-precision attention data. It also adds score repair and retries, a separate acoustic chunk limit and decoder tile fallback.

The kit builds on Linux or WSL2 with an NVIDIA GPU and a compatible CUDA toolkit. It also has a CPU build option for development and checks. Start with the stock model and Standard decoder. The download plan reports exact sizes before it transfers models.

The archive contains an installer, source patches, the custom studio page, and a pinned model manifest. The installer fetches upstream code and model files into the directory you choose. Once built, start the studio there with `./start.sh` and open <http://127.0.0.1:41867>.
