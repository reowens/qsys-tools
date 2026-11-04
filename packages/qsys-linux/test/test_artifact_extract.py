"""Real tar bytes and filesystem race tests; no vendor inputs or Docker."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('artifact_extract', Path(__file__).parents[1] / 'scripts/artifact-extract.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def archive(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w', format=tarfile.PAX_FORMAT) as output:
        for name, body, kind in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(body) if kind == tarfile.REGTYPE else 0
            info.linkname = '/outside/never-follow'
            output.addfile(info, io.BytesIO(body))
    return data.getvalue()


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='qsys-extract-')
        self.root = Path(self.temporary.name)
        self.owned = self.root / 'owned'; self.owned.mkdir()
        self.fd = os.open(self.owned, os.O_RDONLY | os.O_DIRECTORY)

    def tearDown(self):
        os.close(self.fd)
        self.temporary.cleanup()

    def unpack(self, data, limits=module.Limits()):
        return module.extract(io.BytesIO(data), self.fd, limits)

    def test_regular_nested_unicode_and_pax_paths(self):
        name = 'nested/' + 'long-' * 30 + '/résumé data.txt'
        result = self.unpack(archive([('.', b'', tarfile.DIRTYPE), (name, b'payload', tarfile.REGTYPE)]))
        self.assertEqual(result['files'], 1)
        self.assertEqual((self.owned / 'container' / name).read_bytes(), b'payload')
        self.assertEqual((self.owned / 'container' / name).stat().st_mode & 0o777, 0o600)

    def test_traversal_absolute_and_invalid_names(self):
        for name in ['../outside', 'nested/../../outside', '/outside', 'nested/../inside', 'a\\b', 'a//b', 'bad\nname']:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.root) as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises((ValueError, tarfile.HeaderError)):
                        module.extract(io.BytesIO(archive([(name, b'bad', tarfile.REGTYPE)])), fd)
                finally:
                    os.close(fd)

    def test_links_devices_fifo_and_sparse_are_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.GNUTYPE_SPARSE]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises(ValueError):
                        module.extract(io.BytesIO(archive([('bad', b'', kind)])), fd)
                finally:
                    os.close(fd)

    def test_duplicate_file_preserves_first_content(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.unpack(archive([('a', b'first', tarfile.REGTYPE), ('./a', b'second', tarfile.REGTYPE)]))
        self.assertEqual((self.owned / 'container/a').read_bytes(), b'first')

    def test_portable_collisions_include_implicit_parents(self):
        for first, second, kind in [
                ('Dir/x', 'dir/y', tarfile.REGTYPE),
                ('café/x', 'cafe\u0301/y', tarfile.REGTYPE),
                ('Dir/x', 'dir', tarfile.DIRTYPE),
                ('File', 'file', tarfile.REGTYPE),
                ('café', 'cafe\u0301', tarfile.REGTYPE)]:
            with self.subTest(first=first, second=second), tempfile.TemporaryDirectory(dir=self.root) as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaisesRegex(ValueError, 'Portable artifact path collision'):
                        module.extract(io.BytesIO(archive([(first, b'first', tarfile.REGTYPE),
                                                          (second, b'second', kind)])), fd)
                    self.assertEqual((Path(directory) / 'container' / first).read_bytes(), b'first')
                finally:
                    os.close(fd)

    def test_pax_diagnostics_escape_archive_control_characters(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w', format=tarfile.PAX_FORMAT) as output:
            info = tarfile.TarInfo('file')
            info.pax_headers = {'bad\x1b[2J': 'value'}
            output.addfile(info)
        with self.assertRaisesRegex(ValueError, 'Unsupported artifact PAX metadata') as caught:
            self.unpack(data.getvalue())
        self.assertNotIn('\x1b', str(caught.exception))
        self.assertIn('\\x1b', str(caught.exception))

    def test_preexisting_export_refused(self):
        (self.owned / 'container').mkdir()
        with self.assertRaises(FileExistsError):
            self.unpack(archive([]))

    def test_truncated_checksum_and_trailer_fail(self):
        original = archive([('file', b'hello', tarfile.REGTYPE)])
        for data in [original[:100], original[:514], original[:1024], b'bad' + original[3:], original + b'bad']:
            with self.subTest(size=len(data)), tempfile.TemporaryDirectory(dir=self.root) as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises((ValueError, tarfile.HeaderError)):
                        module.extract(io.BytesIO(data), fd)
                finally:
                    os.close(fd)

    def test_size_entry_metadata_and_wire_limits(self):
        cases = [(archive([('file', b'abcdef', tarfile.REGTYPE)]), module.Limits(file=5)),
                 (archive([('a', b'abc', tarfile.REGTYPE), ('b', b'abc', tarfile.REGTYPE)]), module.Limits(total=5)),
                 (archive([('a', b'', tarfile.DIRTYPE), ('b', b'', tarfile.DIRTYPE)]), module.Limits(headers=1)),
                 (archive([('long/' * 40 + 'file', b'a', tarfile.REGTYPE)]), module.Limits(metadata=5)),
                 (archive([]), module.Limits(wire=100))]
        for data, limit in cases:
            with self.subTest(limits=limit), tempfile.TemporaryDirectory(dir=self.root) as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises(ValueError):
                        module.extract(io.BytesIO(data), fd, limit)
                finally:
                    os.close(fd)

    def test_parent_swap_and_restore_cannot_redirect_extraction(self):
        victim = self.root / 'foreign'; victim.mkdir()
        (victim / 'sentinel').write_bytes(b'stay')
        displaced = self.root / 'displaced'
        outer = self
        class Swapping(io.BytesIO):
            reads = 0
            def read(self, size):
                self.reads += 1
                if self.reads == 1:
                    outer.owned.rename(displaced); outer.owned.symlink_to(victim, target_is_directory=True)
                if self.reads == 3:
                    outer.owned.unlink(); displaced.rename(outer.owned)
                return super().read(size)
        data = archive([('nested/data', b'owned output', tarfile.REGTYPE)])
        module.extract(Swapping(data), self.fd)
        self.assertEqual(sorted(p.name for p in victim.iterdir()), ['sentinel'])
        self.assertEqual((self.owned / 'container/nested/data').read_bytes(), b'owned output')

    def test_inserted_descendant_symlink_is_never_followed(self):
        victim = self.root / 'foreign'; victim.mkdir()
        outer = self
        class Inserting(io.BytesIO):
            first = True
            def read(self, size):
                if self.first:
                    self.first = False
                    (outer.owned / 'container/nested').symlink_to(victim, target_is_directory=True)
                return super().read(size)
        with self.assertRaises(OSError):
            module.extract(Inserting(archive([('nested/file', b'bad', tarfile.REGTYPE)])), self.fd)
        self.assertEqual(list(victim.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
