// SPDX-License-Identifier: MIT
// QEMU compatibility for Wine's single-iovec process_vm_readv calls.
// Only ENOSYS triggers the fallback. Kernel procfs permissions and readable
// mappings remain enforced; this never adds capabilities or changes ptrace policy.
#define _GNU_SOURCE
#include <sys/uio.h>
#include <sys/fsuid.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <limits.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>

typedef ssize_t (*readv_fn)(pid_t, const struct iovec *, unsigned long,
                          const struct iovec *, unsigned long, unsigned long);
static readv_fn original;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static void resolve(void) { original = (readv_fn)dlsym(RTLD_NEXT, "process_vm_readv"); }

static int memory_file(pid_t pid) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%ld/mem", (long)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0 && errno == ENOENT) errno = ESRCH;
    else if (fd < 0 && errno == EACCES) errno = EPERM;
    return fd;
}

static pthread_once_t coordinates_once = PTHREAD_ONCE_INIT;
static int coordinates_match;
static void check_coordinates(void) {
    // Guest addresses must be valid procfs offsets. Refuse the fallback when
    // an emulator's non-zero guest_base would make us read unrelated memory.
    uintptr_t marker[2] = {0x7163797370726f63ULL ^ (uintptr_t)getpid(), 0};
    marker[1] = (uintptr_t)marker;
    uintptr_t copy[2] = {0, 0};
    int fd = memory_file(getpid());
    if (fd < 0) return;
    ssize_t n = pread(fd, copy, sizeof(copy), (off_t)(uintptr_t)marker);
    close(fd);
    coordinates_match = n == sizeof(copy) && !memcmp(marker, copy, sizeof(copy));
}

// procfs can read PROT_NONE pages; process_vm_readv cannot. Preserve that
// protection rather than using procfs's forced-read behavior on guard pages.
static size_t readable(pid_t pid, uintptr_t address) {
    char path[64], *line = NULL;
    size_t capacity = 0, length = 0;
    snprintf(path, sizeof(path), "/proc/%ld/maps", (long)pid);
    FILE *file = fopen(path, "re");
    if (!file) return 0;
    while (getline(&line, &capacity, file) >= 0) {
        unsigned long start, end;
        char mode[5];
        if (sscanf(line, "%lx-%lx %4s", &start, &end, mode) == 3 &&
            address >= start && address < end) {
            if (mode[0] == 'r') length = end - address;
            break;
        }
    }
    free(line);
    fclose(file);
    if (!length) errno = EFAULT;
    return length;
}

static int vector_copy(const struct iovec *source, struct iovec *dest) {
    if (readable(getpid(), (uintptr_t)source) < sizeof(*source)) { errno = EFAULT; return -1; }
    int fd = memory_file(getpid());
    if (fd < 0) return -1;
    ssize_t n = pread(fd, dest, sizeof(*dest), (off_t)(uintptr_t)source);
    int saved = errno;
    close(fd);
    errno = n == sizeof(*dest) ? saved : EFAULT;
    return n == sizeof(*dest) ? 0 : -1;
}

ssize_t process_vm_readv(pid_t pid, const struct iovec *local, unsigned long nl,
                        const struct iovec *remote, unsigned long nr, unsigned long flags) {
    pthread_once(&once, resolve);
    if (original) {
        ssize_t n = original(pid, local, nl, remote, nr, flags);
        if (n != -1 || errno != ENOSYS) return n;
    } else errno = ENOSYS; // libc without this symbol is also unsupported.
    if (flags || nl > IOV_MAX || nr > IOV_MAX) { errno = EINVAL; return -1; }
    if (!nl || !nr) return 0;
    // Deliberately narrow: Wine uses exactly one local and remote vector.
    if (nl != 1 || nr != 1) { errno = ENOSYS; return -1; }
    if (pid <= 0) { errno = ESRCH; return -1; }
    // procfs uses fs credentials; refuse a credential mismatch rather than
    // silently changing process_vm_readv's real-credential access semantics.
    if (getuid() != geteuid() || getgid() != getegid() ||
        (uid_t)setfsuid((uid_t)-1) != getuid() ||
        (gid_t)setfsgid((gid_t)-1) != getgid()) { errno = EPERM; return -1; }
    pthread_once(&coordinates_once, check_coordinates);
    if (!coordinates_match) { errno = ENOSYS; return -1; }
    struct iovec l, r;
    if (vector_copy(local, &l) || vector_copy(remote, &r)) return -1;
    if (l.iov_len > SSIZE_MAX || r.iov_len > SSIZE_MAX) { errno = EINVAL; return -1; }
    size_t size = l.iov_len < r.iov_len ? l.iov_len : r.iov_len;
    if (!size) return 0;
    uintptr_t address = (uintptr_t)r.iov_base;
    if (address > INT64_MAX || size > (size_t)INT64_MAX - address) { errno = EFAULT; return -1; }
    int fd = memory_file(pid);
    if (fd < 0) return -1;
    size_t done = 0;
    while (done < size) {
        // This mapping snapshot is not atomic with a concurrent mprotect.
        // The kernel attach-level permission check still governs all reads.
        size_t chunk = readable(pid, address + done);
        if (!chunk) break;
        if (chunk > size - done) chunk = size - done;
        ssize_t n = pread(fd, (char *)l.iov_base + done, chunk, (off_t)(address + done));
        if (n <= 0) { if (!n || errno == EIO) errno = EFAULT; break; }
        done += n;
        if ((size_t)n < chunk) break;
    }
    int saved = errno;
    close(fd);
    errno = saved;
    return done ? (ssize_t)done : -1;
}
