#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Owens
"""Rewrite a TTF's name-table family strings — pure stdlib, no fontTools.

    rename-font-family.py <in.ttf> <out.ttf> <old-name> <new-name>

Used by the recipe to turn the bundled (unmodified, OFL) Selawik files into a
locally-generated "Segoe UI" shim inside the user's own Wine prefix, so WPF
resolves the family directly instead of engaging its missing-family fallback —
the path that drops U+002D under Wine (bug 59925, see
the project's bug-59925 evidence notes). The rename happens on the user's machine only;
nothing trademark-named is redistributed (and dropping the OFL reserved name
"Selawik" from the modified copy is exactly what the OFL requires).

Rebuilds the name table (string lengths change), reassembles the sfnt with
fresh offsets, and recomputes table checksums + head.checkSumAdjustment.
"""
import struct
import sys


def checksum(data: bytes) -> int:
    data += b"\0" * (-len(data) % 4)
    return sum(struct.unpack(f">{len(data) // 4}I", data)) & 0xFFFFFFFF


def rename(src: bytes, old: str, new: str) -> bytes:
    ver, num_tables, sr, es, rs = struct.unpack(">IHHHH", src[:12])
    tables = []  # (tag, data) in file order
    for i in range(num_tables):
        tag, _csum, off, length = struct.unpack(">4sIII", src[12 + 16 * i : 28 + 16 * i])
        tables.append([tag, bytearray(src[off : off + length])])

    for t in tables:
        if t[0] == b"name":
            t[1] = rebuild_name(bytes(t[1]), old, new)

    # Reassemble: directory first, tables 4-byte aligned, checksums fresh.
    tables.sort(key=lambda t: t[0])  # directory must be sorted by tag
    header = struct.pack(">IHHHH", ver, num_tables, sr, es, rs)
    offset = 12 + 16 * num_tables
    directory = b""
    body = b""
    head_off = None
    for tag, data in tables:
        data = bytes(data)
        if tag == b"head":
            data = data[:8] + b"\0\0\0\0" + data[12:]  # zero checkSumAdjustment
            head_off = offset
        pad = b"\0" * (-len(data) % 4)
        directory += struct.pack(">4sIII", tag, checksum(data), offset, len(data))
        body += data + pad
        offset += len(data) + len(pad)
    font = header + directory + body
    if head_off is not None:
        adj = (0xB1B0AFBA - checksum(font)) & 0xFFFFFFFF
        font = font[: head_off + 8] + struct.pack(">I", adj) + font[head_off + 12 :]
    return font


def rebuild_name(table: bytes, old: str, new: str) -> bytearray:
    fmt, count, str_off = struct.unpack(">HHH", table[:6])
    records = []
    for i in range(count):
        pid, eid, lid, nid, length, off = struct.unpack(
            ">HHHHHH", table[6 + 12 * i : 18 + 12 * i]
        )
        raw = table[str_off + off : str_off + off + length]
        enc = "utf-16-be" if (pid == 3 or (pid == 0)) else "latin-1"
        try:
            s = raw.decode(enc)
            if old in s:
                repl = new.replace(" ", "") if nid == 6 else new  # PS names: no spaces
                raw = s.replace(old, repl).encode(enc)
        except UnicodeDecodeError:
            pass  # leave undecodable records untouched
        records.append((pid, eid, lid, nid, raw))

    storage = b""
    out = struct.pack(">HHH", fmt, count, 6 + 12 * count)
    for pid, eid, lid, nid, raw in records:
        idx = storage.find(raw)  # dedupe identical strings
        if idx == -1 or len(raw) == 0:
            idx = len(storage)
            storage += raw
        out += struct.pack(">HHHHHH", pid, eid, lid, nid, len(raw), idx)
    return bytearray(out + storage)


def main() -> None:
    if len(sys.argv) != 5:
        sys.exit(f"usage: {sys.argv[0]} <in.ttf> <out.ttf> <old-name> <new-name>")
    src_path, dst_path, old, new = sys.argv[1:]
    with open(src_path, "rb") as f:
        src = f.read()
    with open(dst_path, "wb") as f:
        f.write(rename(src, old, new))
    print(f"{dst_path}: family '{old}' -> '{new}'")


if __name__ == "__main__":
    main()
