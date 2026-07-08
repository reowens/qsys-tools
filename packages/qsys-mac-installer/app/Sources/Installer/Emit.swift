// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// Emit — the installer's final act: place the emitted "Q-SYS Designer.app" into /Applications
// and give it the real QSC icon.
//
// The launcher ships inside the installer (Developer-ID signed so the installer can notarize).
// We copy it out, bake the user-extracted QSC icon into its Contents/Resources, and ad-hoc
// re-sign. Why icon-in-Resources + ad-hoc (not a custom Finder icon): a custom Finder icon sets
// a com.apple.FinderInfo xattr that fails `codesign --verify --strict` on macOS 26; an icns
// sealed into Contents/Resources keeps a clean signature. The re-sign drops the Developer-ID
// signature, but this copy is created locally (never downloaded) so it carries no quarantine and
// Gatekeeper opens it — the proven original build.sh model. The downloaded installer + dmg stay
// fully notarized. Zero QSC code.

import Foundation

enum Emitter {
    struct Result {
        let installedPath: String
        let usedUserApplications: Bool
    }

    enum EmitError: LocalizedError {
        case noResources, launcherMissing, resignFailed
        var errorDescription: String? {
            switch self {
            case .noResources:     return "Couldn’t locate the installer’s resources."
            case .launcherMissing: return "The bundled Q-SYS Designer app is missing from the installer."
            case .resignFailed:    return "Couldn’t finalize Q-SYS Designer (code-sign step failed)."
            }
        }
    }

    static let appName = "Q-SYS Designer.app"

    /// Place the launcher, bake the icon, ad-hoc re-sign. Throws on a hard failure.
    static func install() throws -> Result {
        let fm = FileManager.default
        guard let res = Bundle.main.resourcePath else { throw EmitError.noResources }
        let src = "\(res)/Launcher.app"
        guard fm.fileExists(atPath: src) else { throw EmitError.launcherMissing }

        let systemApps = "/Applications"
        let userApps = fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications", isDirectory: true).path

        // Try /Applications; on any write failure (non-admin, managed Mac) fall back to ~/Applications.
        var usedUser = false
        let dest: String
        do {
            dest = try place(src: src, intoDir: systemApps)
        } catch {
            usedUser = true
            try? fm.createDirectory(atPath: userApps, withIntermediateDirectories: true)
            dest = try place(src: src, intoDir: userApps)
        }

        try bakeIconAndResign(into: dest)
        return Result(installedPath: dest, usedUserApplications: usedUser)
    }

    private static func place(src: String, intoDir dir: String) throws -> String {
        let fm = FileManager.default
        let dest = "\(dir)/\(appName)"
        // Never operate *through* a planted symlink. attributesOfItem doesn't follow the final
        // component, so a symlink at dest reads as .typeSymbolicLink; removeItem then unlinks the
        // link itself (not its target), and we write a fresh bundle in its place.
        if isSymlink(dest) || fm.fileExists(atPath: dest) {
            try fm.removeItem(atPath: dest)   // link OR a real prior install (idempotent reinstall)
        }
        try fm.copyItem(atPath: src, toPath: dest)
        return dest
    }

    /// True if the final path component is a symlink (does not follow it).
    private static func isSymlink(_ path: String) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeSymbolicLink
    }

    /// True if the path is a regular file (not a directory, symlink, or device).
    private static func isRegularFile(_ path: String) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeRegular
    }

    /// Seal the extracted QSC icon (DataDir.icon, written at provision time) into the launcher's
    /// Resources as CFBundleIconFile=AppIcon, then ad-hoc re-sign. If no icon was extracted, leave
    /// the Developer-ID signature intact (cosmetic generic icon). Always clear quarantine.
    private static func bakeIconAndResign(into appPath: String) throws {
        let fm = FileManager.default
        // DataDir.icon was extracted from the user's OWN installer — only seal it in if it's a real
        // file, never follow a symlink the extraction might have produced into the signed bundle.
        if isRegularFile(DataDir.icon) {
            let resDir = "\(appPath)/Contents/Resources"
            try? fm.createDirectory(atPath: resDir, withIntermediateDirectories: true)
            let iconDest = "\(resDir)/AppIcon.icns"
            try? fm.removeItem(atPath: iconDest)
            try fm.copyItem(atPath: DataDir.icon, toPath: iconDest)
            // Modifying Contents invalidated the Developer-ID seal → ad-hoc re-sign to reseal.
            guard run("/usr/bin/codesign", ["--force", "-s", "-", appPath]) == 0 else {
                throw EmitError.resignFailed
            }
        }
        run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath])   // belt-and-suspenders
    }

    @discardableResult
    private static func run(_ tool: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
    }
}
