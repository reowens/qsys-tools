// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// Provisioner — runs the bundled provision.sh (which drives lib/recipe.sh) into the
// data dir, streaming its progress to the UI. Zero QSC code.
//
// provision.sh emits two line kinds on its merged stdout/stderr:
//   • human   — the recipe's "[qsys] …" lines → shown in the log pane (ANSI stripped).
//   • machine — "@@QSYS:STEP n total label@@" / "@@QSYS:EXTRACT pct@@" → drive the
//               determinate progress bar + step label, and are kept out of the log.
// On failure we surface the recipe's real "[qsys] ERROR:" line, not a bare exit code.

import Foundation

final class Provisioner: ObservableObject {
    enum State: Equatable { case idle, running, succeeded, failed(String) }

    @Published var state: State = .idle
    @Published var log: String = ""
    @Published var progress: Double? = nil   // nil until the first step; 0…1 overall fraction
    @Published var stepLabel: String = ""    // e.g. "Extracting your installer"
    @Published var stepIndex: Int = 0
    @Published var stepTotal: Int = 0

    private var proc: Process?
    private var wasCancelled = false
    private var lineBuffer = ""
    private var stepBase = 0.0                // fraction at the current step's start
    private var stepSpan = 0.0                // 1 / total — how much this step is worth

    func provision(installer: String) {
        guard state != .running else { return }
        state = .running
        log = ""; progress = nil; stepLabel = ""; stepIndex = 0; stepTotal = 0
        lineBuffer = ""; stepBase = 0; stepSpan = 0; wasCancelled = false

        guard let resources = Bundle.main.resourcePath else {
            state = .failed("bundle Resources not found"); return
        }
        let proc = Process()
        self.proc = proc
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["\(resources)/provision.sh", installer]
        var env = ProcessInfo.processInfo.environment
        env["WRAP_HOME"] = DataDir.root
        // Point the recipe at bundled deps so first-run avoids Wine/.NET downloads and uses
        // our 7z/icoutils/msiinfo/native-helper binaries instead of host package-manager tools.
        let bin = "\(resources)/bin"
        env["CACHE"] = "\(resources)/cache"                       // Wine tarball + .NET installers (offline)
        env["QSYS_PREBUILT_APPMENU"] = "\(bin)/appmenu.dylib"     // pre-compiled (no clang)
        env["QSYS_PREBUILT_ICONPAD"] = "\(bin)/iconpad"           // pre-compiled (no clang)
        env["QSYS_PREPATCHED_LOADER"] = "\(bin)/wine-loader-prepatched"  // pre-patched (no python3/otool)
        // Security-ordered PATH, built explicitly rather than inheriting the ambient order (a dev
        // shell leads with Homebrew): bundled Tier-B tools first (7z + icoutils + msiinfo must win), then the
        // system dirs, then the Homebrew prefixes LAST as a harmless fallback. System-before-Homebrew
        // is load-bearing — it stops a poisoned /opt/homebrew/bin/{curl,shasum,tar,bash} from
        // shadowing the real tools the recipe shells out to during provisioning.
        let systemDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let fallbackDirs = ["/opt/homebrew/bin", "/usr/local/bin"]
        env["PATH"] = ([bin] + systemDirs + fallbackDirs).joined(separator: ":")
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.ingest(chunk) }
        }
        proc.terminationHandler = { [weak self] p in
            let status = p.terminationStatus
            DispatchQueue.main.async {
                pipe.fileHandleForReading.readabilityHandler = nil
                self?.finish(status: status)
            }
        }

        do {
            try proc.run()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Cancel an in-flight provision. SIGTERM lets provision.sh's trap kill the running 7z and
    /// scrub the in-flight step's partial state, so the next attempt resumes clean. If the script
    /// ignores TERM (a wedged 7z, say) and is still up after a short grace, escalate to SIGKILL so
    /// a cancel can never hang the UI.
    func cancel() {
        guard state == .running, let proc = proc else { return }
        wasCancelled = true
        proc.terminate()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 3) { [weak proc] in
            guard let proc, proc.isRunning else { return }
            kill(proc.processIdentifier, SIGKILL)
        }
    }

    func reset() { state = .idle; log = ""; progress = nil; stepLabel = ""; stepIndex = 0; stepTotal = 0 }

    // MARK: - Stream handling (main queue)

    private func ingest(_ chunk: String) {
        lineBuffer += chunk
        while let nl = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<nl])
            lineBuffer = String(lineBuffer[lineBuffer.index(after: nl)...])
            handle(line: line)
        }
    }

    private func handle(line raw: String) {
        let line = Self.stripANSI(raw)
        if let body = token(line, "@@QSYS:STEP ") {
            let parts = body.split(separator: " ", maxSplits: 2)
            if parts.count == 3, let n = Int(parts[0]), let total = Int(parts[1]), total > 0 {
                stepIndex = n; stepTotal = total; stepLabel = String(parts[2])
                stepBase = Double(n - 1) / Double(total)
                stepSpan = 1.0 / Double(total)
                progress = stepBase
            }
        } else if let body = token(line, "@@QSYS:EXTRACT "), let pct = Int(body) {
            progress = min(1.0, max(0.0, stepBase + (Double(pct) / 100.0) * stepSpan))
        } else if !line.isEmpty {
            log += line + "\n"
        }
    }

    private func finish(status: Int32) {
        if !lineBuffer.isEmpty { handle(line: lineBuffer); lineBuffer = "" }
        proc = nil
        if wasCancelled {
            reset(); return
        }
        if status == 0 {
            progress = 1.0
            state = .succeeded
        } else {
            state = .failed(lastError() ?? "exit code \(status)")
        }
    }

    /// The most recent "[qsys] ERROR: <msg>" the recipe printed, if any.
    private func lastError() -> String? {
        for line in log.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            if let r = line.range(of: "ERROR:") {
                let msg = line[r.upperBound...].trimmingCharacters(in: .whitespaces)
                if !msg.isEmpty { return msg }
            }
        }
        return nil
    }

    private func token(_ line: String, _ prefix: String) -> String? {
        guard line.hasPrefix(prefix), line.hasSuffix("@@") else { return nil }
        return String(line.dropFirst(prefix.count).dropLast(2))
    }

    private static let ansi = try! NSRegularExpression(pattern: "\u{1B}\\[[0-9;]*m")
    private static func stripANSI(_ s: String) -> String {
        let r = NSRange(s.startIndex..., in: s)
        return ansi.stringByReplacingMatches(in: s, range: r, withTemplate: "")
            .replacingOccurrences(of: "\r", with: "")
    }
}
