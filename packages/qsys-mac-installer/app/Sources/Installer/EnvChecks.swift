// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// EnvChecks — pre-provision environment advisories shown in the first-run setup UI.
//
// Detect setup blockers/advisories before the user drops their installer: Rosetta for the
// x86_64 Wine stack, python3 for MSI layout assembly, and Little Snitch loopback
// blocking. Shown only in the .idle setup state, so it's inherently one-time — no persistence
// needed. Zero QSC code.

import Foundation

struct EnvNotice: Identifiable {
    enum Kind { case blocker, advisory }
    enum Action: Equatable { case none, installRosetta, recheck }
    let id = UUID()
    let kind: Kind
    let title: String
    let detail: String

    // Rosetta can be installed in-app; external tool blockers can only be re-checked after
    // the user installs them with Homebrew/CLT.
    let action: Action

    init(kind: Kind, title: String, detail: String, action: Action = .none) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.action = action
    }
}

enum EnvChecks {
    private static let provisionPathDirs = [
        "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"
    ]

    /// Apple Silicon needs Rosetta 2 to run the x86_64 Wine stack (provisioning *and* launch).
    /// Intel runs x86_64 natively → never a blocker. Probe by actually exec'ing an x86_64
    /// binary under Rosetta; a non-zero exit (or a throw) means Rosetta is absent.
    static var rosettaMissing: Bool {
        // Test hook: macOS 26 removed `softwareupdate --uninstall-rosetta` and SIP blocks deleting
        // the runtime, so there's no way to get a Rosetta-absent Mac to exercise this path on demand.
        // QSYS_FORCE_ROSETTA_MISSING=1 forces it (off by default) so the blocker notice + gating can
        // be validated on any machine.
        if ProcessInfo.processInfo.environment["QSYS_FORCE_ROSETTA_MISSING"] == "1" { return true }
        #if arch(arm64)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/arch")
        p.arguments = ["-x86_64", "/usr/bin/true"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus != 0 }
        catch { return true }
        #else
        return false
        #endif
    }

    /// Little Snitch present (app bundle or its support dir). If it holds the 127.0.0.1
    /// loopback the embedded web server uses, the editor/help panes blank.
    static var littleSnitchPresent: Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: "/Applications/Little Snitch.app")
            || fm.fileExists(atPath: "/Library/Little Snitch")
    }

    static var python3Missing: Bool {
        if ProcessInfo.processInfo.environment["QSYS_FORCE_PYTHON3_MISSING"] == "1" { return true }
        return !commandExists("python3")
    }

    private static func commandExists(_ name: String) -> Bool {
        let fm = FileManager.default
        let envPath = ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":")
            .map(String.init) ?? []
        var seen = Set<String>()
        for dir in provisionPathDirs + envPath where seen.insert(dir).inserted {
            if fm.isExecutableFile(atPath: "\(dir)/\(name)") { return true }
        }
        return false
    }

    /// Resolve the live notices. Spawns a subprocess (the Rosetta probe) — call once, off the
    /// render path (the view caches the result).
    static var notices: [EnvNotice] {
        var out: [EnvNotice] = []
        if rosettaMissing {
            out.append(EnvNotice(
                kind: .blocker,
                title: "Rosetta 2 required",
                detail: "Q-SYS Designer runs x86_64 Wine under Rosetta 2, which isn’t installed yet. Install it to continue.",
                action: .installRosetta))
        }
        if python3Missing {
            out.append(EnvNotice(
                kind: .blocker,
                title: "python3 required",
                detail: "Setup uses local Python scripts to assemble the app layout. Install Xcode Command Line Tools (xcode-select --install) or Homebrew Python (brew install python), then Re-check.",
                action: .recheck))
        }
        if littleSnitchPresent {
            out.append(EnvNotice(
                kind: .advisory,
                title: "Little Snitch detected",
                detail: "Allow Q-SYS Designer's 127.0.0.1 (loopback) connection in Little Snitch, or the script-editor and help panes stay blank."))
        }
        return out
    }
}

/// Installs Rosetta 2 with a single admin prompt, so the user doesn't have to drop to Terminal.
/// `softwareupdate --install-rosetta --agree-to-license` requires root (the license flag does) and
/// runs non-interactively to completion, so we drive it via osascript's `with administrator
/// privileges` (one native auth dialog) on a background queue and report the outcome to the UI.
enum RosettaInstaller {
    enum Outcome { case installed, canceled, failed(String) }

    static func install(completion: @escaping (Outcome) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            // `2>&1` so softwareupdate's progress/result (it writes to stderr) comes back as the shell
            // result we can show the user — otherwise the install is silent and unverifiable.
            p.arguments = ["-e",
                "do shell script \"/usr/sbin/softwareupdate --install-rosetta --agree-to-license 2>&1\" with administrator privileges"]
            let outPipe = Pipe(), errPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = errPipe
            do { try p.run() } catch {
                DispatchQueue.main.async { completion(.failed(error.localizedDescription)) }
                return
            }
            p.waitUntilExit()
            let out = read(outPipe), err = read(errPipe)
            let status = p.terminationStatus
            // One diagnostic line (Console / stderr) so a silent install is still auditable after the fact.
            FileHandle.standardError.write(Data("[rosetta] status=\(status) out=\(out.isEmpty ? "-" : out) err=\(err.isEmpty ? "-" : err)\n".utf8))
            DispatchQueue.main.async {
                if status == 0 {
                    completion(.installed)   // raw softwareupdate output stays in the log line above, not the UI
                } else if err.contains("-128") || err.localizedCaseInsensitiveContains("cancel") {
                    completion(.canceled)   // user dismissed the auth dialog
                } else {
                    completion(.failed(!err.isEmpty ? err : (!out.isEmpty ? out : "Rosetta installation failed (exit \(status)).")))
                }
            }
        }
    }

    private static func read(_ pipe: Pipe) -> String {
        String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}
