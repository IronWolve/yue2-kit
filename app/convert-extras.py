#!/usr/bin/env python3
"""Make the extra GGUFs the console needs from the shared model library.

1. The Legacy and Blend VAEs, through upstream convert.py's own VAE path
   (same architecture as the Standard VAE; only the source folder and the
   output name differ).
2. The 16 voice/genre sliders (ntc-ai/yue2-particle-sliders, routed-particle
   adapters on the 112 AR attention projections) as one GGUF each plus a
   catalog.json the server reads with --sliders.

Existing outputs are skipped. Every source is checked against its published
checksum before conversion.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import time

import gguf
import numpy as np
from safetensors import safe_open

ROOT = os.path.dirname(os.path.abspath(__file__))
# The sources are found from build/checkpoints (the folder convert.py reads): on one
# machine a link into a shared model library (hf/m-a-p, with hf/Mothersuperior and
# hf/ntc-ai beside it), on another the PyTorch console's own models/ folder.
CKPT = os.path.realpath(os.path.join(ROOT, "build", "checkpoints"))
VAE_OUT = os.path.join(ROOT, "build", "models")
SLIDER_OUT = os.path.join(ROOT, "sliders")


def first_dir(*candidates):
    for c in candidates:
        if os.path.isdir(c):
            return c
    raise SystemExit("none of these exist: " + ", ".join(candidates))


LEGACY_SRC = os.path.join(CKPT, "YuE2-Vae-legacy")
BLEND_SRC = first_dir(os.path.join(CKPT, "YuE2-Vae-merge-0.666"),
                      os.path.join(CKPT, "..", "Mothersuperior", "YuE2-Vae-merge-0.666"))
SLIDER_SRC = first_dir(os.path.join(CKPT, "particle-sliders"),
                       os.path.join(CKPT, "..", "ntc-ai", "yue2-particle-sliders"))

G, Y, R, D, X = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[0m"
PROJ = ("q_proj", "k_proj", "v_proj", "o_proj")
MLP_INDEX = (0, 2, 4, 6)   # the Linear layers of nn.Sequential(Linear, LeakyReLU, ...)

stats = {"made": 0, "skipped": 0, "failed": 0}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def load_upstream_converter():
    spec = importlib.util.spec_from_file_location("upstream_convert", os.path.join(ROOT, "build", "convert.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def convert_vae_variant(conv, source_dir, name):
    out = os.path.join(VAE_OUT, "YuE2-Vae-%s-F32.gguf" % name)
    if os.path.exists(out):
        print(f"{G}have{X}      {os.path.basename(out)}")
        stats["skipped"] += 1
        return
    manifest = json.load(open(os.path.join(source_dir, "weights_manifest.json")))
    expected = manifest["files"]["model.safetensors"]["sha256"]
    if sha256(os.path.join(source_dir, "model.safetensors")) != expected:
        print(f"{R}checksum{X}  {source_dir} does not match its manifest; skipped")
        stats["failed"] += 1
        return
    staging = os.path.join(ROOT, "tmp", "vae-" + name)
    os.makedirs(staging, exist_ok=True)
    conv.CHECKPOINT_DIR = os.path.dirname(source_dir)
    conv.COMPONENTS["vae"] = os.path.basename(source_dir)
    conv.OUTPUT_DIR = staging
    conv.convert_vae()
    shutil.move(os.path.join(staging, "YuE2-Vae-F32.gguf"), out)
    os.rmdir(staging)
    print(f"{G}made{X}      {os.path.basename(out)}  {D}{os.path.getsize(out) / 1e6:.1f} MB{X}")
    stats["made"] += 1


def convert_slider(entry):
    source = os.path.join(SLIDER_SRC, entry["weights"])
    out = os.path.join(SLIDER_OUT, entry["id"] + ".gguf")
    if os.path.exists(out):
        stats["skipped"] += 1
        return True
    if sha256(source) != entry["sha256"]:
        print(f"{R}checksum{X}  slider {entry['id']} does not match the catalog; skipped")
        stats["failed"] += 1
        return False
    with safe_open(source, "np") as f:
        record = json.loads((f.metadata() or {}).get("conceptmod", "{}"))
        if record.get("format") != "conceptmod-yue2-routed-particle-ar-v1":
            print(f"{R}format{X}    slider {entry['id']}: {record.get('format')} is not supported")
            stats["failed"] += 1
            return False
        rank, alpha = int(record["rank"]), float(record["alpha"])
        targets = record["targets"]
        w = gguf.GGUFWriter(out, arch="yue2-slider")
        w.add_name("YuE2 slider " + entry["id"])
        w.add_string("yue2-slider.id", entry["id"])
        w.add_string("yue2-slider.format", record["format"])
        w.add_uint32("yue2-slider.rank", rank)
        w.add_float32("yue2-slider.alpha", alpha)
        w.add_uint32("yue2-slider.layers", len(targets) // 4)
        w.add_string("yue2-slider.source_sha256", entry["sha256"])
        particles = f.get_tensor("particles").astype(np.float32)          # [128, 4]
        w.add_tensor("sld.particles", particles)
        w.add_tensor("sld.particles_t", np.ascontiguousarray(particles.T))
        for target in targets:
            _, _, layer, _, proj = target.split(".")                         # model.layers.L.self_attn.P
            key = "adapters." + target.replace(".", "-")
            if float(f.get_tensor(key + ".alpha")) != alpha:
                raise SystemExit("alpha mismatch in " + key)
            base = "sld.%s.%s" % (layer, proj[0])
            w.add_tensor(base + ".down", f.get_tensor(key + ".lora_down.weight").astype(np.float32))
            w.add_tensor(base + ".up", f.get_tensor(key + ".lora_up.weight").astype(np.float32))
            for part, short in (("router", "r"), ("net", "n")):
                for i, index in enumerate(MLP_INDEX):
                    w.add_tensor("%s.%s%d.w" % (base, short, i),
                                 f.get_tensor("%s.bridge.%s.%d.weight" % (key, part, index)).astype(np.float32))
                    w.add_tensor("%s.%s%d.b" % (base, short, i),
                                 f.get_tensor("%s.bridge.%s.%d.bias" % (key, part, index)).astype(np.float32))
        w.write_header_to_file()
        w.write_kv_data_to_file()
        w.write_tensors_to_file()
        w.close()
    stats["made"] += 1
    return True


def main():
    start = time.time()
    os.makedirs(VAE_OUT, exist_ok=True)
    os.makedirs(SLIDER_OUT, exist_ok=True)
    conv = load_upstream_converter()
    convert_vae_variant(conv, LEGACY_SRC, "legacy")
    convert_vae_variant(conv, os.path.realpath(BLEND_SRC), "blend")

    catalog = json.load(open(os.path.join(SLIDER_SRC, "catalog.json")))
    entries = []
    for entry in catalog["sliders"]:
        if convert_slider(entry):
            entries.append({"id": entry["id"], "label": entry["label"], "description": entry.get("description", ""),
                            "file": entry["id"] + ".gguf", "source_sha256": entry["sha256"]})
    with open(os.path.join(SLIDER_OUT, "catalog.json"), "w") as f:
        json.dump({"source": "ntc-ai/yue2-particle-sliders", "release": catalog.get("release"),
                   "experimental": catalog.get("experimental"), "recommended_range": catalog.get("recommended_range"),
                   "sliders": entries}, f, indent=2)
    size = sum(os.path.getsize(os.path.join(SLIDER_OUT, e["file"])) for e in entries) / 1e6
    print(f"{G}sliders{X}   {len(entries)} in {os.path.realpath(SLIDER_OUT)}  {D}{size:.0f} MB{X}")
    print(f"\nextras: made {G}{stats['made']}{X}, already here {stats['skipped']}, "
          f"failed {R if stats['failed'] else ''}{stats['failed']}{X}  in {time.time() - start:.0f}s")
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
