#!/usr/bin/env python3
"""Assemble the COMPLETE Q-SYS Designer app into the prefix by mapping every
OFFLINE payload file to its MSI-defined install target path.

InstallAware shatters the installer payload into hash-named OFFLINE/<hash>/<hash>
dirs and ships a metadata-only MSI (no embedded CAB stream — 7z has already
unpacked the bytes into OFFLINE). The MSI's Directory/Component/File tables
encode, for every file, BOTH its source (the OFFLINE hash path) and its install
target path, via DefaultDir's `[target]:[source]` form (each side `short|long`).
Resolving both and copying source -> target lays down the complete app — all 326
.luax component definitions, 28 .qplug plugins, the symbols and the full DLL set
— instead of the old hand-picked ~40% that omitted the entire component layer
(which is what NRE'd the LCQ-LN drag and boxed the missing-symbol components).

Usage:  assemble-msi.py <installer.msi> <src_root> <app_target_dir>
  src_root = the directory CONTAINING the OFFLINE folder (the MSI source chain
             begins with the literal 'OFFLINE' segment, so paths resolve against
             OFFLINE's parent).
Requires: msiinfo on PATH. The packaged installer supplies a bundled copy in Resources/bin;
source builds can use Homebrew msitools.
"""
import os
import sys
import subprocess


def msi_export(msi, table):
    """Return the rows of an MSI table as a list of dicts (msiinfo IDT output).

    IDT layout: line0=column names, line1=types, line2=table+keys, line3+=data.
    """
    out = subprocess.run(["msiinfo", "export", msi, table],
                         capture_output=True, text=True, check=True).stdout
    lines = out.split("\n")
    cols = lines[0].split("\t")
    rows = []
    for ln in lines[3:]:
        if not ln:
            continue
        vals = ln.split("\t")
        vals += [""] * (len(cols) - len(vals))
        rows.append(dict(zip(cols, vals)))
    return rows


def long_name(part):
    """`short|long` -> long; plain -> itself; '.' / '' -> '' (no path segment)."""
    if part in (".", ""):
        return ""
    return part.split("|", 1)[1] if "|" in part else part


def split_default_dir(dd):
    """`[target]:[source]` -> (target_long, source_long); no colon => both same."""
    tgt, src = dd.split(":", 1) if ":" in dd else (dd, dd)
    return long_name(tgt), long_name(src)


def build_resolver(directory_rows):
    """key -> (target_path, source_path), walking Directory_Parent to the root."""
    dirs = {}
    for r in directory_rows:
        tgt, src = split_default_dir(r["DefaultDir"])
        dirs[r["Directory"]] = (r["Directory_Parent"], tgt, src)
    memo = {}

    def resolve(key):
        if key in memo:
            return memo[key]
        if key not in dirs or key == "TARGETDIR":
            memo[key] = ("", "")
            return memo[key]
        parent, tgt, src = dirs[key]
        # SourceDir's own DefaultDir is the literal 'SourceDir' — a root, no segment.
        tgt = "" if tgt == "SourceDir" else tgt
        src = "" if src == "SourceDir" else src
        pt, ps = resolve(parent) if parent else ("", "")
        memo[key] = (pt + ("/" + tgt if tgt else ""),
                     ps + ("/" + src if src else ""))
        return memo[key]

    return resolve


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: assemble-msi.py <installer.msi> <src_root> <app_target_dir>")
    msi, src_root, app = sys.argv[1], sys.argv[2], sys.argv[3]

    resolve = build_resolver(msi_export(msi, "Directory"))
    comp_dir = {r["Component"]: r["Directory_"] for r in msi_export(msi, "Component")}

    # (target_rel, source_rel) for every File row.
    files = []
    for r in msi_export(msi, "File"):
        d = comp_dir.get(r["Component_"])
        if d is None:
            continue
        tp, sp = resolve(d)
        fname = long_name(r["FileName"])
        files.append(((tp.lstrip("/") + "/" + fname).lstrip("/"),
                      (sp.lstrip("/") + "/" + fname).lstrip("/")))

    # Collision resolution. Exactly one target (Q-Sys Designer.exe) has two
    # differing-byte sources: the real app build sits beside libcef.dll, a CEF-less
    # twin does not. Prefer whichever colliding source shares libcef.dll's dir; that
    # reproduces the known-good install. Identical-byte collisions: first wins.
    libcef_dir = next((os.path.dirname(s) for t, s in files
                       if os.path.basename(s).lower() == "libcef.dll"), None)
    chosen = {}
    for target, source in files:
        prev = chosen.get(target)
        if prev is None:
            chosen[target] = source
        elif os.path.dirname(source) == libcef_dir:
            chosen[target] = source  # the libcef-colocated source wins the tie

    copied = 0
    missing = []
    for target, source in chosen.items():
        abs_src = os.path.join(src_root, source)
        if not os.path.isfile(abs_src):
            missing.append(source)
            continue
        abs_dst = os.path.join(app, target)
        os.makedirs(os.path.dirname(abs_dst), exist_ok=True)
        with open(abs_src, "rb") as fi, open(abs_dst, "wb") as fo:
            while True:
                chunk = fi.read(1 << 20)
                if not chunk:
                    break
                fo.write(chunk)
        copied += 1

    # Fail hard on a broken mapping — a silently-incomplete app is the bug we are fixing.
    if missing:
        sys.exit(f"assemble-msi: {len(missing)} mapped source file(s) absent from "
                 f"{src_root} — installer payload looks incomplete. First few:\n  "
                 + "\n  ".join(missing[:5]))
    luax = sum(1 for t in chosen if t.lower().endswith(".luax"))
    if not os.path.isfile(os.path.join(app, "Q-Sys Designer.exe")):
        sys.exit("assemble-msi: Q-Sys Designer.exe did not land at the app root.")
    if luax == 0:
        sys.exit("assemble-msi: no .luax component definitions mapped — the "
                 "component layer is missing (the very bug this assembler fixes).")
    print(f"assemble-msi: laid out {copied} files ({luax} .luax component defs).")


if __name__ == "__main__":
    main()
