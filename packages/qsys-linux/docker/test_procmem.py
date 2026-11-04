"""Opt-in compiler tests for the experimental Wine/QEMU process-memory shim."""
import ctypes as c
import errno
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


def probe(name):
    class Iovec(c.Structure):
        _fields_ = [('base', c.c_void_p), ('size', c.c_size_t)]
    lib = c.CDLL(None, use_errno=True)
    call = lib.process_vm_readv
    call.restype = c.c_ssize_t
    call.argtypes = [c.c_int, c.POINTER(Iovec), c.c_ulong, c.POINTER(Iovec), c.c_ulong, c.c_ulong]
    source = c.create_string_buffer(b'test')
    dest = c.create_string_buffer(5)
    local, remote = Iovec(c.addressof(dest), 4), Iovec(c.addressof(source), 4)
    def read(pid=None, l=None, r=None, nl=1, nr=1, flags=0):
        c.set_errno(0)
        n = call(os.getpid() if pid is None else pid, c.byref(local) if l is None else l,
                 nl, c.byref(remote) if r is None else r, nr, flags)
        return n, c.get_errno()
    if name == 'read':
        assert read()[0] == 4 and dest.value == b'test'
        rfd, wfd = os.pipe()
        child = os.fork()
        if not child:
            os.close(wfd); os.read(rfd, 1); os._exit(0)
        os.close(rfd)
        try:
            dest.value = b''
            assert read(child)[0] == 4 and dest.value == b'test'
        finally:
            os.write(wfd, b'x'); os.close(wfd); os.waitpid(child, 0)
    elif name == 'errors':
        assert read(flags=1) == (-1, errno.EINVAL)
        assert read(l=c.cast(1, c.POINTER(Iovec))) == (-1, errno.EFAULT)
        assert read(r=c.cast(1, c.POINTER(Iovec))) == (-1, errno.EFAULT)
        assert read(nr=1025) == (-1, errno.EINVAL)
        remote.size = 1 << 63
        assert read() == (-1, errno.EINVAL)
        remote.size = 4
        remote.base = 1
        assert read() == (-1, errno.EFAULT)
        remote.base = c.addressof(source)
        assert read(nl=2) == (-1, errno.ENOSYS)
        assert read(pid=99999999) == (-1, errno.ESRCH)
        assert read(nl=0)[0] == 0
    elif name == 'protected':
        lib.mmap.restype = c.c_void_p
        lib.mmap.argtypes = [c.c_void_p,c.c_size_t,c.c_int,c.c_int,c.c_int,c.c_long]
        address = lib.mmap(None, 4096, 0, 0x22, -1, 0)
        assert address != c.c_void_p(-1).value
        try:
            remote.base = address
            assert read() == (-1, errno.EFAULT), read()
        finally:
            lib.munmap.argtypes = [c.c_void_p,c.c_size_t]
            assert lib.munmap(address, 4096) == 0
    elif name == 'denied':
        assert read() == (-1, errno.EPERM) and dest.value == b''
    elif name == 'nondumpable':
        ready_r, ready_w = os.pipe()
        stop_r, stop_w = os.pipe()
        child = os.fork()
        if not child:
            os.close(ready_r); os.close(stop_w)
            lib.prctl.argtypes = [c.c_int,c.c_ulong,c.c_ulong,c.c_ulong,c.c_ulong]
            ok = lib.prctl(4, 0, 0, 0, 0) == 0  # PR_SET_DUMPABLE
            os.write(ready_w, b'y' if ok else b'n')
            os.read(stop_r, 1); os._exit(0)
        os.close(ready_w); os.close(stop_r)
        try:
            assert os.read(ready_r, 1) == b'y'
            n, error = read(child)
            assert (n, error) == (-1, errno.EPERM), (n, error)
            assert dest.value == b''
        finally:
            os.write(stop_w, b'x'); os.close(stop_w); os.close(ready_r)
            os.waitpid(child, 0)
    elif name == 'native':
        assert read()[0] == 4 and dest.value == b'test'
    else:
        raise AssertionError(name)
    print('PASS', name)


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('cc'), 'Linux C compiler required')
class ProcmemTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='qsys-procmem-')
        cls.root = Path(cls.scratch.name)
        cls.shim = cls.root / 'shim.so'
        flags = ['cc', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-Wl,-z,relro,-z,now']
        subprocess.run([*flags, '-o', str(cls.shim), str(Path(__file__).with_name('wine-procmem.c')), '-ldl', '-pthread'], check=True)
        fake = cls.root / 'missing.c'
        fake.write_text('#define _GNU_SOURCE\n#include <sys/uio.h>\n#include <errno.h>\n#include <stdlib.h>\n'
                        'ssize_t process_vm_readv(pid_t p,const struct iovec*a,unsigned long b,const struct iovec*d,unsigned long e,unsigned long f)'
                        '{(void)p;(void)a;(void)b;(void)d;(void)e;(void)f;errno=atoi(getenv("QSYS_TEST_ERRNO"));return -1;}\n')
        cls.fake = cls.root / 'missing.so'
        subprocess.run([*flags, '-o', str(cls.fake), str(fake)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def run_probe(self, name, error=errno.ENOSYS):
        preload = str(self.shim)
        if name != 'native': preload += ':' + str(self.fake)
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--probe', name],
                                env=dict(os.environ, LD_PRELOAD=preload, QSYS_TEST_ERRNO=str(error)),
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_self_and_cross_process_read(self): self.run_probe('read')
    def test_flags_vectors_ranges_and_missing_process(self): self.run_probe('errors')
    def test_guard_pages_remain_unreadable(self): self.run_probe('protected')
    def test_kernel_denial_never_triggers_fallback(self): self.run_probe('denied', errno.EPERM)
    @unittest.skipIf(os.geteuid() == 0, 'kernel denial must be checked without root privileges')
    def test_procfs_denies_a_nondumpable_target(self): self.run_probe('nondumpable')
    def test_existing_native_syscall_is_preserved(self): self.run_probe('native')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--probe': probe(sys.argv[2])
    else: unittest.main()
