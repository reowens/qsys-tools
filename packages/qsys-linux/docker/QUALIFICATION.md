# Execution qualification

The source checkout's `docker:smoke` runner supports native amd64 execution and
an explicit experimental `hybrid-qemu` mode on ARM64 engines. Both use the same
actual Designer basic/fixture checks. Full-profile coverage remains incomplete.
See the package README for commands and resource admission requirements.

## Integrated basic qualification, 2026-10-30

Development image ID: `sha256:30174c52f99523043a6249e89d1f3523cda414ef91f8aa70f9aca514d763576a` (a local image ID, not a published registry digest).
The same image passed the following real-fixture matrix:

| Execution target | Cold install + UI/QRC | Warm downloads + fresh prefix | Interrupted install | Interrupted UI |
| --- | --- | --- | --- | --- |
| Linux host, native amd64 | Passed | Passed, 3 archives reverified | SIGTERM handled, exit 143 | SIGINT handled, exit 130 |
| Apple Silicon Mac, local Docker Desktop, hybrid-qemu | Passed | Passed, 3 archives reverified | SIGTERM handled, exit 143 | SIGHUP handled, exit 129 |

Each successful application run passed actual in-app Open, saved-file fresh-process
reopen, Emulate and all eight public-client QRC assertions. Both cold caches
started with zero verified archives. All interrupted application results remained
failed, rather than becoming passes. All eight runs exported artifacts, reported
no cleanup errors, and left no run-owned containers or temporary volumes. Only
the explicitly selected runtime caches were retained.

Budgets were 8 GiB RAM, 4 CPUs and 1 GiB shared memory. The Apple Silicon runs reached the
memory cap, with no OOM or swap recorded; this is passing at the cap, not evidence
of headroom. The vendor-free authenticated runtime check also passed on the Linux host.
Hermetic regression coverage includes phase provenance, cache ownership and
leases, failed-removal lease retention, input checksums and signal propagation.
The Python phase/helper tests are wired into Linux CI without vendor inputs.

This qualifies the recorded basic fixture cases on these two hosts. Full-profile
coverage, fully Rosetta-free cold provisioning, broader lifecycle/concurrency
scenarios, a committed-source build, local Mac image building and registry
publication remain separate work.

## Apple Silicon investigation, 2026-10-30

The verified Windows x64 runtime ZIPs unblock installation under Docker Desktop's
Rosetta translation. Designer execution still encounters a Rosetta signal-context
assertion. The integrated hybrid mode avoids that application-execution failure; it still
uses the configured engine translator for provisioning.

The integrated execution mode follows this experimentally established route:

1. Provision the private prefix with the packaged CLI under Rosetta.
2. Execute the Windows application through BuildKit's native arm64 QEMU x86-64
   emulator (observed version 10.2.3), without registering a kernel interpreter
   or changing Docker Desktop settings.
3. Invoke the packaged Node CLI and the Python extraction wrapper with explicit
   interpreters; QEMU's handling of their `env` shebangs otherwise fails coreutils
   executable-name validation.
4. Use the Nehalem guest CPU model and, for the QEMU phase only,
   `DOTNET_EnableHWIntrinsic=0`, `DOTNET_ReadyToRun=0`, `DOTNET_EnableAVX=0`,
   `DOTNET_EnableAVX2=0`, and `DOTNET_EnableWriteXorExecute=0`.
5. Preload the image-built `wine-procmem.c` helper only for the QEMU phase. It
   supplies Wine's single-vector process-memory reads when QEMU returns ENOSYS.
   The helper, interpreter shims and their parent directories are root-owned and
   not writable by the test user. The image records the compiler/source/binary
   hashes in `compatibility.json`.

`DOTNET_EnableWriteXorExecute=0` changes the process's JIT executable-memory allocation policy.
It is an experimental diagnostic setting, not an adopted security default.
The tests retained UID 1000, dropped capabilities, no-new-privileges, resource
limits and read-only installer/design inputs. No host display or privileged
container was used.

With that helper, this route passed actual fixture launch, stable nonblank
rendering, resizing, dialog clipboard, save, **in-app Open of a different
document**, fresh-process reopen, Emulate, all eight public-client QRC assertions,
control restoration and cleanup. Open starts another Designer instance; its
readiness check now uses the same 180-second budget as initial launch and still
requires the different document's title. Installation was validated in the
preceding provisioning phase. The integrated runner records both phases and
credits installation only if its receipt matches the current run, selected
installer and installed-prefix manifest. It does not skip installation. Earlier
UI-only diagnostics remain incomplete historical evidence; their skips have not
been relabeled. This is not Rosetta-free provisioning. The four full-profile
Lua/UCI/schematic checks remain unimplemented.

Without the helper, in-app Open reported access denied while inspecting process
modules. A standalone self-memory-read probe succeeds under Rosetta and returns
ENOSYS under this QEMU binary. Wine's server uses `process_vm_readv` with a ptrace
fallback. Supplying the missing read operation removed the error and allowed the
real Open check to pass. Running only wineserver under Rosetta had instead timed
out during path conversion.

### Experimental memory-read helper

The Dockerfile compiles this MIT-licensed source in a separate amd64 build stage;
the compiler is not installed in the runtime image. For standalone testing on
Linux amd64, build outside the checkout:

```sh
cc -shared -fPIC -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now \
  -o /path/outside/checkout/procmem.so wine-procmem.c -ldl -pthread
python3 -m unittest discover -s . -p test_procmem.py -v
```

Run these commands from this directory. The helper delegates to libc first and
falls back only on ENOSYS. Other original errors, including EPERM, remain errors.
It supports only Wine's single local/remote vector calls, checks credential
consistency and guest/procfs address correspondence, and opens process memory
read-only subject to the kernel's access checks. It refuses already unreadable
mappings. Protected-page and nondumpable-target probes pass under the actual
Apple Silicon QEMU configuration without additional capabilities.

This is a narrow compatibility helper, not a general syscall implementation.
The mapping check is a snapshot and cannot eliminate races with concurrent
protection changes. Its procfs operations are not async-signal-safe and add
overhead. Adjacent-map vector structures and other general multi-vector behavior
are outside its compatibility contract. The hybrid preset applies it to the QEMU UI process tree, including its test
helpers; provisioning and host processes do not receive it. Do not preload it
for unrelated host processes or treat it as a security boundary.

The QEMU binary is a checksum-pinned, read-only runtime input, separate from the
vendor-free image. `qemu-pin.json` records its version, ARM64 source image/path,
checksum and upstream license/source references. It is not automatically fetched,
shipped in npm or registered with the kernel. QEMU is GPL-licensed software; this
project ships only its own helper source/image and pin metadata. The native mode
does not set LD_PRELOAD or the QEMU-specific JIT environment. Private screenshots,
fixtures and logs are not included here.

## Receipts, cache and lifecycle

`phases.json` separates actual provisioning from application acceptance. A failed
provisioning phase prevents UI work. The host also checks both phase receipts and
the selected installer hash before accepting a passing UI result. Cancellation
stops the attached Docker CLI without signal proxying, delivers one bounded
container stop, exports artifacts only after confirmed stop, and removes only
resources with the run's ownership label. Repeated signals cannot interrupt the
entrypoint's cleanup grace.

Artifact export uses `docker cp ... -` and a bounded descriptor-relative host
extractor, rather than asking Docker to resolve a host destination path. This
applies on both Linux and macOS. The extractor accepts regular files/directories
only, validates archive framing and bounded PAX path metadata, and refuses unsafe
paths, links, special files, duplicates and oversized/truncated streams. Python
runs isolated from caller-directory imports. Transport checks are separate from
Designer acceptance; the runtime image is unchanged by this host-side hardening.

An explicit `--cache-volume` retains runtime downloads, with checksum validation
before reuse. A deterministic container-name reservation provides an exclusive
lease, and foreign cache volumes/lease holders are refused. Fresh per-run work,
home and prefix volumes are still required. Installer/design inputs never enter
the cache. Before provisioning, recognized interrupted downloads and old helper scratch
directories are removed and recorded. Unknown files, links and invalid archive
hashes are refused. Apt helpers use per-run scratch instead of the persistent
cache; the cache is checked again after application acceptance. If container
removal cannot be confirmed, its cache lease is deliberately retained. After a
host crash or forced driver kill, inspect the lease container's ownership label
and all containers from that run; remove the lease manually only after its cache
users have stopped and been removed. Removing the cache volume alone does not
release that lease.

References: [BuildKit emulator helpers](https://github.com/tonistiigi/binfmt#buildkit-target),
[Wine 11.20 process-memory implementation](https://github.com/wine-mirror/wine/blob/wine-11.20/server/ptrace.c),
[.NET 10.0.14 executable allocator](https://github.com/dotnet/runtime/blob/v10.0.14/src/coreclr/utilcode/executableallocator.cpp).
