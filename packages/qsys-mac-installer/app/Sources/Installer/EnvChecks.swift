// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// EnvChecks — pre-provision environment advisories shown in the first-run setup UI.
//
// Detect setup blockers/advisories before the user drops their installer: Rosetta for the
// x86_64 Wine stack and Little Snitch loopback blocking. Shown only in the .idle setup state,
// so it's inherently one-time — no persistence needed. Zero QSC code.

import Foundation

struct EnvNotice: Identifiable {
    enum Kind { case blocker, advisory }
    enum Action: Equatable { case none, installRosetta }
    let id = UUID()
    let kind: Kind
    let title: String
    let detail: String

    // Rosetta can be installed in-app; blockers always also show Re-check.
    let action: Action

    init(kind: Kind, title: String, detail: String, action: Action = .none) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.action = action
    }
}

enum EnvChecks {
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

    /// Can this process actually use TCP loopback? Bind an ephemeral listener on 127.0.0.1 and
    /// connect to it. Presence of a firewall app says nothing about whether loopback is *blocked*,
    /// and loopback can equally be blocked by LuLu, Radio Silence, pf rules, or an MDM profile —
    /// so probe the capability itself rather than inferring from an installed bundle.
    ///
    /// Fails SAFE: every inconclusive outcome (socket/bind/listen unavailable) returns false, so a
    /// probe that cannot run never accuses the user's firewall. Only a bound listener plus a failed
    /// connect counts as blocked.
    ///
    /// Port 0 lets the kernel pick a free port, so this cannot collide with anything in use.
    ///
    /// CAVEAT: these filters are per-process. A pass proves only that *the installer* may use
    /// loopback — Designer is a different binary and can still be prompted for separately.
    static var loopbackBlocked: Bool {
        let listenFd = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFd >= 0 else { return false }
        defer { close(listenFd) }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0                                   // kernel-assigned
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        guard bound, listen(listenFd, 1) == 0 else { return false }

        // Read back the kernel-assigned port.
        var live = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &live) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(listenFd, $0, &len) == 0
            }
        }
        guard named else { return false }

        let clientFd = socket(AF_INET, SOCK_STREAM, 0)
        guard clientFd >= 0 else { return false }
        defer { close(clientFd) }
        let connected = withUnsafePointer(to: &live) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(clientFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        return !connected
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
        // A measured block is a real finding — lead with it, and don't name a vendor we haven't
        // confirmed. Stays an advisory, not a blocker: provisioning and launching still work,
        // only the web panes break, so this must not gate the install.
        if loopbackBlocked {
            out.append(EnvNotice(
                kind: .advisory,
                title: "Loopback (127.0.0.1) is blocked",
                detail: "A firewall is blocking local connections. Q-SYS Designer installs and runs, but the script-editor, help, and splash panes will be blank until you allow 127.0.0.1 for it."))
        } else if littleSnitchPresent {
            // Loopback works for *us*, but these rules are per-app — Designer will be asked about
            // separately, so this stays a heads-up rather than a claim that something is broken.
            out.append(EnvNotice(
                kind: .advisory,
                title: "Little Snitch detected",
                detail: "Loopback works for this installer, but rules are per-app. Allow Q-SYS Designer's 127.0.0.1 (loopback) connection when prompted, or the script-editor and help panes stay blank."))
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
