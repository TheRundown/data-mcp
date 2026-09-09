#!/usr/bin/env python3
"""Export only reviewed source files to the public website's download directory."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

FILES = (
    "server.mjs", "smoke.mjs", "package.json", "package-lock.json",
    "README.md", "DESIGN.md", "test/server.test.mjs",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    version = json.loads((source / "package.json").read_text())["version"]
    prefix = f"therundown-data-mcp-{version}"
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=source, text=True
    ).strip()
    inputs = {name: ('BUNDLE-README.md' if name == 'README.md' else name) for name in FILES}
    if any((source / name).is_symlink() for name in inputs.values()):
        raise SystemExit('Bundle inputs must be regular source files, not symlinks.')
    contents = {name: (source / inputs[name]).read_bytes() for name in FILES}
    for name, data in contents.items():
        committed = subprocess.check_output(
            ["git", "show", f"{revision}:{inputs[name]}"], cwd=source
        )
        if committed != data:
            raise SystemExit(f"Commit {name} before exporting a versioned bundle.")
    manifest = {
        "version": version,
        "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()},
    }
    contents["MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    archive = args.output_directory / f"{prefix}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, data in contents.items():
            entry = zipfile.ZipInfo(f"{prefix}/{name}", date_time=(2026, 9, 9, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            bundle.writestr(entry, data)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".sha256").write_text(f"{digest}  {archive.name}\n")
    print(f"Created {archive.name}: {archive.stat().st_size} bytes")


if __name__ == "__main__":
    main()
