# Engine patches

`BASE.txt` identifies the upstream engine revision and the exact GGML revision pinned by it. `engine.patch` is the cumulative diff from that engine revision to the v13 engine, excluding the GGML gitlink and the separately packaged web page. It includes the local Studio, library, adapters and continuation, the reviewed score and memory improvements, and the acoustic attention padding crash fix.

`ggml.patch` applies to the pinned GGML revision. It implements strict F32 matrix products for the new expanded decoders. The installer checks each patched tree against the corresponding hash in `BASE.txt` and keeps the public upstream Git revisions as the checkout heads. The server's Git revision display identifies that upstream base. `local_engine` and `local_ggml` record the original integration commits from which the patched trees were exported.

`page/index.html.gz` is the embedded Studio page. The uncompressed Studio and its editable sources are in the kit's top-level `page/` directory.
