// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// Remove — uninstall Q-SYS Designer: the emitted launcher (/Applications or ~/Applications)
// and the provisioned data dir (~4 GB) under Application Support. Offered from the installer's
// idle screen when an existing install is detected. The user's own installer .exe is never
// touched. Zero QSC code.

import Foundation

enum Uninstaller {
    /// Both places the installer may have placed the launcher.
    static var appLocations: [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ["/Applications/\(Emitter.appName)", "\(home)/Applications/\(Emitter.appName)"]
    }

    /// True if a provisioned data dir or an installed launcher exists.
    static var isInstalled: Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: DataDir.root) || appLocations.contains { fm.fileExists(atPath: $0) }
    }

    struct Summary { let removed: [String]; let failures: [String] }

    /// Best-effort removal; collects anything it couldn't delete (e.g. /Applications without admin).
    static func remove() -> Summary {
        let fm = FileManager.default
        // Terminate any Designer/Wine processes running from our prefix FIRST — otherwise they
        // orphan (wineserver keeps running off the now-deleted prefix). Match the wine *binary*
        // dir, not the data-dir root: pkill -f scans the whole command line, so the broad root
        // path ("…/Q-SYS Designer") would also kill unrelated user procs that merely reference it
        // — a grep, an editor with the folder open, `tail wine.log`. Only processes we actually
        // launched carry the wine bin path in their argv. TERM, brief grace, then KILL.
        if fm.fileExists(atPath: DataDir.root) {
            _ = run(DataDir.wineserver, ["-k"], environment: ["WINEPREFIX": DataDir.prefix])
            let wineBin = "\(DataDir.wineApp)/Contents/Resources/wine/bin/"
            _ = run("/usr/bin/pkill", ["-f", wineBin])
            Thread.sleep(forTimeInterval: 0.5)
            _ = run("/usr/bin/pkill", ["-9", "-f", wineBin])
        }
        var removed: [String] = []; var failures: [String] = []
        for path in appLocations + [DataDir.root] where fm.fileExists(atPath: path) {
            // Never delete through a symlink. attributesOfItem doesn't follow the final component, so
            // a planted link (e.g. ~/Applications/Q-SYS Designer.app -> /elsewhere) reads as
            // .typeSymbolicLink — surface it as a failure rather than unlink it silently.
            if (try? fm.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeSymbolicLink {
                failures.append(path); continue
            }
            do { try fm.removeItem(atPath: path); removed.append(path) }
            catch { failures.append(path) }
        }
        return Summary(removed: removed, failures: failures)
    }

    @discardableResult
    private static func run(_ tool: String, _ args: [String], environment extraEnv: [String: String] = [:]) -> Int32 {
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
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
    }
}
