// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// DataDir — where the app keeps its provisioned state, and the wine handoff.
//
// Everything mutable/BYO (Wine, the prefix, the menu shim, the extracted icon) lives
// under ~/Library/Application Support — NOT inside the .app bundle, because a notarized
// app can't write into its own signed bundle. The recipe is told this path via WRAP_HOME.

import Foundation

enum DataDir {
    static let root = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Q-SYS Designer", isDirectory: true)
        .path

    static var prefix: String { "\(root)/prefix" }
    static var wineApp: String { "\(root)/Wine Staging.app" }
    static var wine: String { "\(wineApp)/Contents/Resources/wine/bin/wine" }
    static var wineserver: String { "\(wineApp)/Contents/Resources/wine/bin/wineserver" }
    static var shim: String { "\(root)/appmenu.dylib" }
    static var icon: String { "\(root)/QSYSDesigner.icns" }
    static var provisionedMarker: String { "\(root)/.provisioned" }
    static var schemaMarker: String { "\(root)/.qsys-recipe-schema" }

    /// Minimum provision-schema this build can launch. Keep in sync with RECIPE_SCHEMA in
    /// lib/recipe.sh (which stamps schemaMarker after a successful provision). A data dir
    /// provisioned by an older recipe is treated as NOT provisioned — the launcher then points
    /// the user at the installer instead of booting a broken layout (a v1 prefix
    /// is missing the component layer and NREs on inventory drags).
    static let requiredRecipeSchema = 2

    /// Schema the data dir was provisioned with; 1 when the dir predates stamping (v1 era).
    static var provisionedSchema: Int {
        guard let raw = try? String(contentsOfFile: schemaMarker, encoding: .utf8),
              let n = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return 1 }
        return n
    }

    /// Provisioned, but by a recipe too old for this build — needs a re-run of the installer.
    static var isStaleProvision: Bool {
        FileManager.default.fileExists(atPath: provisionedMarker)
            && provisionedSchema < requiredRecipeSchema
    }

    /// Where wine's stdout+stderr land. A GUI launch (Finder/Dock/`open`) connects fd 1/2 to
    /// LaunchServices, NOT the unified log, on modern macOS — so a crash backtrace is otherwise
    /// unrecoverable. The launcher redirects here before execve; wine inherits the fds.
    static var logFile: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Q-SYS Designer/wine.log").path
    }

    /// True once a prior run finished provisioning into the data dir — with a layout this
    /// build can actually launch (schema gate: see requiredRecipeSchema).
    static var isProvisioned: Bool {
        FileManager.default.fileExists(atPath: provisionedMarker)
            && provisionedSchema >= requiredRecipeSchema
            && FileManager.default.isExecutableFile(atPath: wine)
            && designerExe != nil
    }

    /// Locate Q-Sys Designer.exe by name (the install dir is hash-named, never hard-code it).
    static var designerExe: String? {
        let driveC = "\(prefix)/drive_c"
        guard let walker = FileManager.default.enumerator(atPath: driveC) else { return nil }
        for case let rel as String in walker where rel.lowercased().hasSuffix("q-sys designer.exe") {
            return "\(driveC)/\(rel)"
        }
        return nil
    }

    /// The pinned recipe env for the wine handoff — token-for-token with emit_app's generated
    /// launcher. DYLD_INSERT_LIBRARIES carries the menu/icon shim into wine and survives its
    /// loose-loader re-exec (proven in Phase 1).
    private static func designerEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["WINEPREFIX"] = prefix
        env["WINELOADER"] = wine
        env["WINEDEBUG"] = "fixme-all,err-all"
        env["DOTNET_EnableWriteXorExecute"] = "0"   // Rosetta 2 W^X compat for the .NET 8 JIT
        env["LIBGL_ALWAYS_SOFTWARE"] = "1"           // WPF software render (else black window)
        env["WINEDLLOVERRIDES"] = "mshtml=d;mountmgr.sys=d" // mscoree ON — off breaks the managed loader; mountmgr.sys=d stops the /Volumes raw-device scan (parity with launch.sh + emit_app)
        env["QSYS_MENU_NAME"] = "Q-SYS Designer"
        env["QSYS_ICON"] = icon
        if FileManager.default.fileExists(atPath: shim) {
            env["DYLD_INSERT_LIBRARIES"] = shim
        }
        return env
    }

    /// Defensive de-quarantine of the Mach-O code we inject/exec: the menu shim, plus the ENTIRE
    /// Wine install — the wine binary AND the libwine.*/winemac.drv dylibs it dlopens (hence `-dr`,
    /// recursive over the Wine app, not just bin/wine). provision.sh strips quarantine from the whole
    /// tree, but a data dir provisioned by an OLDER build, or any re-quarantine, would leave these
    /// tainted — and macOS aborts the wine process with "library load disallowed by system policy"
    /// on the dlopen. The prefix holds no macOS-loadable dylibs, so the Wine app is the full surface.
    /// Cheap + idempotent → every launch self-heals.
    private static func dequarantineForLaunch() {
        for path in [shim, wineApp] where FileManager.default.fileExists(atPath: path) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
            p.arguments = ["-dr", "com.apple.quarantine", path]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run(); p.waitUntilExit()
        }
    }

    /// Point fd 1/2 at logFile so wine's output — and crucially the CLR's own unhandled-exception
    /// stack, which .NET writes straight to stderr (not via a wine debug channel, so it survives the
    /// quiet WINEDEBUG) — is captured. execve preserves fds, so the redirect carries into wine and its
    /// children; a Designer crash-on-exit lands here for diagnosis. Appends a per-launch header, and
    /// rotates (truncates) once the file passes ~1 MB so it can't grow unbounded.
    private static func redirectOutputToLog() {
        let dir = (logFile as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let attrs = try? FileManager.default.attributesOfItem(atPath: logFile)
        if let size = attrs?[.size] as? Int, size > 1_000_000 {
            try? FileManager.default.removeItem(atPath: logFile)
        }
        let fd = open(logFile, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard fd >= 0 else { return }
        fchmod(fd, 0o600)   // owner-only — enforce even if the log pre-existed 0o644 or umask widened it
        let header = "\n===== launch \(ISO8601DateFormatter().string(from: Date())) pid \(getpid()) =====\n"
        _ = header.withCString { write(fd, $0, strlen($0)) }
        dup2(fd, STDOUT_FILENO)
        dup2(fd, STDERR_FILENO)
        if fd > STDERR_FILENO { close(fd) }
    }

    /// Replace this process with wine running Designer — the pinned recipe env, token-for-token with
    /// emit_app's generated launcher. execve (not spawn) so DYLD_INSERT_LIBRARIES survives into wine +
    /// its loose-loader re-exec (Phase 1) AND the .app's LaunchServices registration stays on THIS pid
    /// — that's what gives the Dock tile / menu / icon the bundle identity ("Q-SYS Designer", not
    /// "wine"). Teardown is handled by a sidecar reaper spawned just before this call (spawnReaper).
    static func launchDesigner() -> Never {
        redirectOutputToLog()
        guard let exe = designerExe else {
            FileHandle.standardError.write(Data("q-sys-designer: not provisioned\n".utf8))
            exit(1)
        }
        dequarantineForLaunch()
        let argv = [wine, exe] + CommandLine.arguments.dropFirst()
        let cArgv = argv.map { strdup($0) } + [UnsafeMutablePointer<CChar>?(nil)]
        let cEnv = designerEnv().map { strdup("\($0.key)=\($0.value)") } + [UnsafeMutablePointer<CChar>?(nil)]
        execve(wine, cArgv, cEnv)
        FileHandle.standardError.write(Data("execve failed: \(String(cString: strerror(errno)))\n".utf8))
        exit(127)
    }

    /// Spawn a detached copy of ourselves in `--reap <pid>` mode to watch `pid` (this process, which
    /// is about to become wine via execve) and reap stragglers when it exits. The reaper never creates
    /// an NSApplication → it's invisible (no Dock tile, no menu), so the visible identity stays
    /// entirely with the execve'd wine. This is how we get quit-time teardown without the
    /// supervise-child Dock-name regression (wine-as-child ⇒ LSDisplayName "wine").
    static func spawnReaper(watching pid: pid_t) {
        guard let me = Bundle.main.executablePath else { return }
        let argv = [me, "--reap", String(pid)]
        let cArgv = argv.map { strdup($0) } + [UnsafeMutablePointer<CChar>?(nil)]
        var renv = ProcessInfo.processInfo.environment
        renv["QSYS_REAPER"] = "1"   // proves to the spawned `--reap` instance it's our internal reaper
        let cEnv = renv.map { strdup("\($0.key)=\($0.value)") } + [UnsafeMutablePointer<CChar>?(nil)]
        defer { cArgv.forEach { free($0) }; cEnv.forEach { free($0) } }
        var child: pid_t = 0
        _ = me.withCString { posix_spawn(&child, $0, nil, nil, cArgv, cEnv) }
    }

    /// `--reap` mode: block until `pid` (the launcher-become-wine) exits — clean quit OR crash —
    /// then `wineserver -k`. kqueue/NOTE_EXIT is a precise, race-free wait; if the pid is already
    /// gone (registration fails with ESRCH), reap immediately.
    static func reapAfter(pid: pid_t) -> Never {
        if pid > 0 { waitForExit(pid: pid) }
        teardownWine()
        exit(0)
    }

    /// Block until `pid` (the launcher-become-wine) exits — clean quit OR crash. kqueue/NOTE_EXIT is
    /// the precise, race-free wait; returns the instant the process is confirmed gone. The invariant
    /// callers rely on: never return while the watched process is still alive (a premature return
    /// makes reapAfter tear down a RUNNING Designer). So EINTR re-arms/re-waits instead of falling
    /// through, ESRCH (already gone) returns at once, and any other kqueue failure degrades to a
    /// liveness poll rather than a blind teardown.
    private static func waitForExit(pid: pid_t) {
        let kq = kqueue()
        if kq < 0 { return pollUntilGone(pid: pid) }
        defer { close(kq) }
        var ev = kevent()
        ev.ident = UInt(pid)
        ev.filter = Int16(truncatingIfNeeded: EVFILT_PROC)
        ev.flags = UInt16(truncatingIfNeeded: EV_ADD)
        ev.fflags = UInt32(truncatingIfNeeded: NOTE_EXIT)
        while kevent(kq, &ev, 1, nil, 0, nil) == -1 {
            if errno == EINTR { continue }          // interrupted before arming → retry
            if errno == ESRCH { return }            // pid already exited → reap now
            return pollUntilGone(pid: pid)          // unexpected → poll, don't teardown blindly
        }
        while true {
            var out = kevent()
            let n = kevent(kq, nil, 0, &out, 1, nil)   // blocks until NOTE_EXIT fires
            if n == 1 { return }                       // process exited
            if n == -1 && errno == EINTR { continue }  // signal woke us early → keep waiting
            return pollUntilGone(pid: pid)             // hard error → confirm via poll
        }
    }

    /// Liveness fallback when kqueue is unusable: `kill(pid, 0)` probes existence without signalling.
    /// Loop until the process is gone (ESRCH), so we still tear down only after it actually exits.
    private static func pollUntilGone(pid: pid_t) {
        while true {
            if kill(pid, 0) == 0 { Thread.sleep(forTimeInterval: 0.25); continue }   // alive
            if errno == EINTR || errno == EPERM { Thread.sleep(forTimeInterval: 0.25); continue }
            return   // ESRCH (or unexpected) → treat as gone
        }
    }

    /// Reap any Wine processes still bound to our prefix (winedevice/CefSharp/wineserver) after
    /// Designer's process exits — clean quit OR crash. The durable teardown: even a hung Designer
    /// gets killed instead of orphaning to PPID 1. `wineserver -k` signals the whole prefix tree.
    static func teardownWine() {
        if FileManager.default.isExecutableFile(atPath: wineserver) {
            runQuietly(wineserver, ["-k"], environment: ["WINEPREFIX": prefix])
        }
        let wineBin = "\(wineApp)/Contents/Resources/wine/bin/"
        guard FileManager.default.fileExists(atPath: wineBin) else { return }
        runQuietly("/usr/bin/pkill", ["-f", wineBin])
        Thread.sleep(forTimeInterval: 0.5)
        runQuietly("/usr/bin/pkill", ["-9", "-f", wineBin])
    }

    private static func runQuietly(_ tool: String, _ args: [String], environment extraEnv: [String: String] = [:]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        if !extraEnv.isEmpty {
            var env = ProcessInfo.processInfo.environment
            for (key, value) in extraEnv { env[key] = value }
            p.environment = env
        }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()
    }
}
