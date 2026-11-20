"""Read the pinned asset list beside this script and fetch only the selected groups."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote


def valid(path, item):
    if not path.is_file() or path.stat().st_size != item["bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]


def under(root, relative):
    parts = PurePosixPath(relative)
    if parts.is_absolute() or ".." in parts.parts or not parts.parts:
        raise ValueError(f"invalid manifest path: {relative}")
    path = root.joinpath(*parts.parts)
    if not path.parent.resolve().is_relative_to(root):
        raise ValueError(f"destination parent is outside the install: {relative}")
    return path


def main():
    target, mode, *groups = sys.argv[1:]
    root = Path(target).resolve()
    files = json.loads(Path(__file__).with_name("assets.json").read_text(encoding="utf-8"))["files"]
    available = {group for item in files for group in item["groups"]}
    chosen = set(groups or ["core"])
    if "all" in chosen:
        chosen |= available
        chosen.remove("all")
    if chosen - available:
        raise ValueError(f"unknown groups: {', '.join(sorted(chosen - available))}")
    selected = [item for item in files if chosen.intersection(item["groups"])]
    print(f"{len(selected)} files, {sum(item['bytes'] for item in selected) / 1e9:.2f} GB total", flush=True)
    missing = []
    for item in selected:
        dest = under(root, item["destination"])
        if mode == "plan":
            print(f"{item['bytes']:>12,}  {item['destination']}")
            continue
        if valid(dest, item):
            print(f"Verified {item['destination']}", flush=True)
            continue
        if mode == "verify" or dest.exists() or dest.is_symlink():
            missing.append(item["destination"])
            continue
        if mode != "assets":
            raise ValueError(f"unknown action: {mode}")
        if not re.fullmatch(r"[0-9a-f]{40}", item["revision"]):
            raise ValueError("expected a pinned model revision")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(dest.parent).free < item["bytes"]:
            raise ValueError(f"insufficient space for {item['destination']}")
        url = "https://huggingface.co/" + quote(item["repo"], safe="/")
        url += "/resolve/" + item["revision"] + "/" + quote(item["file"], safe="/")
        print(f"Downloading {item['destination']}", flush=True)
        with tempfile.TemporaryDirectory(prefix=".download-", dir=dest.parent) as work:
            temporary = Path(work) / dest.name
            subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "3",
                            "--connect-timeout", "20", "--output", str(temporary), url], check=True)
            if not valid(temporary, item):
                raise ValueError(f"checksum or size mismatch: {item['destination']}")
            # Link exclusively so a concurrent invocation cannot overwrite an existing file.
            try:
                os.link(temporary, dest)
            except FileExistsError:
                if not valid(dest, item):
                    raise ValueError(f"destination already holds different content: {dest}")
        print(f"Verified {item['destination']}", flush=True)
    if missing:
        raise ValueError("missing or differing files (preserved): " + ", ".join(missing))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
