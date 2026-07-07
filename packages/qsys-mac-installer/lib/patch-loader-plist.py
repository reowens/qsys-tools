#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Owens
"""Rewrite the unix Wine loader's embedded __info_plist CFBundleName.

Why: the bold macOS menu-bar app name is AppKit's `applicationName`, read ONCE at
init from the *main bundle's* CFBundleName. After Wine re-execs into its loose unix
loader (lib/wine/x86_64-unix/wine), CFBundleGetMainBundle() uses that binary's
EMBEDDED __info_plist (a __TEXT,__info_plist section) — which ships as
CFBundleName="Wine". Neither menu-item titles, nor the process name, nor an on-disk
adjacent Info.plist reliably override it. So we rewrite the embedded plist in place.

Constraint: a Mach-O section can't grow without relocating everything after it, so we
MUST keep the new plist <= the section size. The stock plist is pretty-printed; we
re-emit it minified (whitespace stripped) which frees plenty of room for a longer
CFBundleName, then null-pad back to the exact section size. Caller re-signs after.

Usage: patch-loader-plist.py <loader-binary> <CFBundleName> [CFBundleIdentifier]
Exit: 0 patched (or already patched), 2 no section / won't fit (caller warns).
"""
import re, subprocess, sys, plistlib

def section_off_size(path):
    lc = subprocess.run(["otool", "-l", path], capture_output=True, text=True).stdout
    lines = lc.splitlines()
    for i, l in enumerate(lines):
        if "sectname __info_plist" in l:
            blk = "\n".join(lines[i:i + 8])
            size = int(re.search(r"size 0x([0-9a-f]+)", blk).group(1), 16)
            off = int(re.search(r"offset (\d+)", blk).group(1))
            return off, size
    return None, None

def main():
    if len(sys.argv) < 3:
        print("usage: patch-loader-plist.py <loader> <name> [bundleid]", file=sys.stderr)
        return 2
    path, name = sys.argv[1], sys.argv[2]
    bundleid = sys.argv[3] if len(sys.argv) > 3 else None

    off, size = section_off_size(path)
    if off is None:
        print("no __info_plist section — nothing to patch", file=sys.stderr)
        return 2

    raw = bytearray(open(path, "rb").read())
    cur = bytes(raw[off:off + size]).split(b"\x00")[0]
    try:
        d = plistlib.loads(cur)
    except Exception as e:
        print(f"embedded plist unparseable: {e}", file=sys.stderr)
        return 2

    if d.get("CFBundleName") == name and (bundleid is None or d.get("CFBundleIdentifier") == bundleid):
        print("already patched")
        return 0

    d["CFBundleName"] = name
    d["CFBundleDisplayName"] = name
    if bundleid:
        d["CFBundleIdentifier"] = bundleid

    # minified XML plist (plistlib emits pretty XML; strip inter-tag whitespace)
    xml = plistlib.dumps(d, fmt=plistlib.FMT_XML)
    xml = re.sub(rb">\s+<", b"><", xml).strip()
    if len(xml) > size:
        print(f"new plist {len(xml)}B > section {size}B — won't fit", file=sys.stderr)
        return 2

    raw[off:off + size] = xml + b"\x00" * (size - len(xml))
    open(path, "wb").write(raw)
    print(f"patched CFBundleName -> {name} ({len(xml)}/{size}B)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
