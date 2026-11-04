#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Extract a Docker cp tar stream beneath inherited directory fd 3.

No extractall, absolute destinations, symlinks, hardlinks, ownership, modes or
timestamps from the archive. Partial exports remain untrusted on any failure.
"""
import json
import os
import stat
import sys
import tarfile
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    total: int = 1024**3
    file: int = 256 * 1024**2
    headers: int = 4096
    metadata: int = 64 * 1024
    wire: int = 1024**3 + 64 * 1024**2
    trailer: int = 1024**2


class Reader:
    def __init__(self, source, limits):
        self.source, self.limits, self.count = source, limits, 0

    def read(self, size):
        value = self.source.read(size)
        self.count += len(value)
        if self.count > self.limits.wire:
            raise ValueError('Archive wire-size limit exceeded')
        return value

    def exact(self, size):
        chunks = []
        while size:
            value = self.read(size)
            if not value:
                raise ValueError('Truncated artifact archive')
            chunks.append(value)
            size -= len(value)
        return b''.join(chunks)


def components(name):
    if not name or name.startswith('/') or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Unsafe exported artifact path')
    while name.startswith('./'):
        name = name[2:]
    if name in ('', '.'):
        return []
    name = name.rstrip('/')
    parts = name.split('/')
    if (len(parts) > 32 or len(name.encode('utf-8')) > 4096
            or any(p in ('', '.', '..') or len(p.encode('utf-8')) > 255 for p in parts)):
        raise ValueError('Unsafe exported artifact path')
    return parts


def pax_path(data):
    path, offset = None, 0
    allowed = {'path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'}
    while offset < len(data):
        end = data.find(b' ', offset)
        number = data[offset:end] if end >= 0 else b''
        if not number.isdigit() or len(number) > 8:
            raise ValueError('Invalid PAX record length')
        length = int(number)
        if length <= end - offset + 2 or offset + length > len(data):
            raise ValueError('Invalid PAX record bounds')
        record = data[end + 1:offset + length]
        if not record.endswith(b'\n') or b'=' not in record or b'\0' in record:
            raise ValueError('Invalid PAX record')
        key, value = record[:-1].decode('utf-8').split('=', 1)
        if key not in allowed:
            raise ValueError('Unsupported artifact PAX metadata: ' + repr(key)[:80])
        if key == 'path':
            if path is not None:
                raise ValueError('Duplicate PAX path')
            components(value)
            path = value
        offset += length
    return path


def directory(parent, name):
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError:
        pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)


def extract(source, root_fd, limits=Limits()):
    if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
        raise ValueError('Artifact root must be a directory descriptor')
    os.mkdir('container', 0o700, dir_fd=root_fd)  # Never merge into an existing export.
    target = os.open('container', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    reader, seen, pending, has_pax = Reader(source, limits), set(), None, False
    portable_names = {}
    count, total, files = 0, 0, 0
    try:
        while True:
            header = reader.exact(512)
            if not any(header):
                if has_pax or any(reader.exact(512)):
                    raise ValueError('Invalid archive end marker')
                tail = 0
                while True:
                    value = reader.read(65536)
                    if not value:
                        break
                    tail += len(value)
                    if any(value) or tail > limits.trailer:
                        raise ValueError('Invalid archive trailer')
                return {'files': files, 'bytes': total, 'headers': count, 'wireBytes': reader.count}
            count += 1
            if count > limits.headers:
                raise ValueError('Archive entry limit exceeded')
            member = tarfile.TarInfo.frombuf(header, encoding='utf-8', errors='strict')
            if member.size < 0:
                raise ValueError('Negative archive entry size')
            if member.type == tarfile.XHDTYPE:
                if has_pax or member.size > limits.metadata:
                    raise ValueError('Artifact PAX metadata limit exceeded')
                pending = pax_path(reader.exact(member.size))
                if any(reader.exact((-member.size) % 512)):
                    raise ValueError('Invalid metadata padding')
                has_pax = True
                continue
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
                raise ValueError('Unsafe exported artifact type')
            parts = components(pending if pending is not None else member.name)
            pending, has_pax = None, False
            key = '/'.join(parts)
            if key in seen:
                raise ValueError('Duplicate exported artifact path')
            seen.add(key)
            # Include implicit parents: Mac filesystems can merge spellings that
            # Linux keeps separate. Refuse those archives consistently on hosts.
            for depth in range(1, len(parts) + 1):
                spelling = '/'.join(parts[:depth])
                folded = unicodedata.normalize('NFC', unicodedata.normalize('NFC', spelling).casefold())
                if portable_names.setdefault(folded, spelling) != spelling:
                    raise ValueError('Portable artifact path collision')
            if member.type == tarfile.DIRTYPE:
                if member.size:
                    raise ValueError('Artifact directory has data')
            elif not parts or member.size > limits.file or total + member.size > limits.total:
                raise ValueError('Artifact file/total size limit exceeded')
            parent = os.dup(target)
            try:
                for part in (parts if member.type == tarfile.DIRTYPE else parts[:-1]):
                    next_fd = directory(parent, part)
                    os.close(parent)
                    parent = next_fd
                if member.type != tarfile.DIRTYPE:
                    fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                    with os.fdopen(fd, 'wb') as output:
                        remaining = member.size
                        while remaining:
                            value = reader.exact(min(remaining, 65536))
                            output.write(value)
                            remaining -= len(value)
                    total += member.size
                    files += 1
                    if any(reader.exact((-member.size) % 512)):
                        raise ValueError('Invalid artifact padding')
            finally:
                os.close(parent)
    finally:
        os.close(target)


if __name__ == '__main__':
    try:
        print(json.dumps(extract(sys.stdin.buffer, 3)))
    except Exception as error:
        print('Artifact stream rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
