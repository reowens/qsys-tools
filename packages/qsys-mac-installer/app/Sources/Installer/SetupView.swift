// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// SetupView — native first-run UI: drop your installer, watch provisioning, then launch.

import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct SetupView: View {
    @ObservedObject var provisioner: Provisioner
    @State private var dropTargeted = false
    @State private var notices: [EnvNotice]
    @State private var emit: EmitPhase = .pending
    @State private var selectedInstaller: String? = nil   // picked, not yet started

    private enum EmitPhase { case pending, installing, done(Emitter.Result), failed(String) }

    @State private var removing = false
    @State private var removeMsg: String? = nil
    @State private var installingRosetta = false
    @State private var rosettaError: String? = nil
    @State private var rosettaNote: String? = nil

    // Notices are probed once in AppDelegate (before the window exists) and seeded here, so the
    // window sizes to fit any blocker/advisory cards on first paint instead of clipping the content
    // below them after an async probe. The didBecomeActive re-probe keeps them fresh.
    init(provisioner: Provisioner, initialNotices: [EnvNotice]) {
        _provisioner = ObservedObject(wrappedValue: provisioner)
        _notices = State(initialValue: initialNotices)
    }

    private var hasBlocker: Bool { notices.contains { $0.kind == .blocker } }

    var body: some View {
        VStack(spacing: 16) {
            Text("Q-SYS Mac Installer").font(.title2).bold()

            switch provisioner.state {
            case .idle:            idleContent
            case .running:         running
            case .succeeded:       success
            case .failed(let why): failure(why)
            }

            disclaimer
        }
        .padding(24)
        // Fixed width (no jump between states); height is the content's ideal. NSHostingController's
        // default .standardBounds sizing (see AppDelegate) drives the window's contentMin/MaxSize so
        // the window fits this exactly — no manual measurement, no clipping. Keep the content free of
        // greedy vertical frames (maxHeight: .infinity); they make the max size unbounded and break the fit.
        .frame(minWidth: 520, maxWidth: 520, minHeight: 320, alignment: .top)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Re-probe when the user tabs back — e.g. after installing Rosetta — so the blocker
            // clears on its own without an app restart.
            if case .idle = provisioner.state { notices = EnvChecks.notices }
        }
    }

    // Nominative-use trademark + non-affiliation notice, shown on every state (audit A3).
    private var disclaimer: some View {
        Text("Unofficial — not affiliated with, endorsed by, or sponsored by QSC, LLC. “Q-SYS” and “Q-SYS Designer” are trademarks of QSC, LLC. You supply your own Designer download.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var idleContent: some View {
        VStack(spacing: 16) {
            Text("Drop your own Q-SYS Designer installer (.exe). Nothing is uploaded — setup runs entirely on your Mac.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)   // wrap, don't truncate
            noticesBanner
            if let exe = selectedInstaller {
                chosenInstaller(exe)
            } else {
                dropZone
            }
            removeRow
        }
    }

    // Picked-but-not-started: show the chosen file + an explicit Install button (disabled while a
    // blocker like missing Rosetta is unresolved, so the user can't kick off a doomed provision).
    private func chosenInstaller(_ exe: String) -> some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "doc.fill").foregroundStyle(.secondary)
                Text((exe as NSString).lastPathComponent)
                    .font(.callout).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                Button("Change…") { selectedInstaller = nil }.buttonStyle(.link).controlSize(.small)
            }
            .padding(10)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            Button("Install Q-SYS Designer") { provisioner.provision(installer: exe) }
                .keyboardShortcut(.defaultAction)
                .disabled(hasBlocker)
            if hasBlocker {
                Text("Resolve the requirement above to continue.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var removeRow: some View {
        if removing {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Removing…").font(.caption).foregroundStyle(.secondary)
            }
        } else if let m = removeMsg {
            Text(m).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        } else if Uninstaller.isInstalled {
            HStack(spacing: 4) {
                Text("Q-SYS Designer is already installed.").font(.caption).foregroundStyle(.secondary)
                Button("Remove…") { confirmRemove() }.controlSize(.small).buttonStyle(.link)
            }
        }
    }

    private func confirmRemove() {
        let alert = NSAlert()
        alert.messageText = "Remove Q-SYS Designer?"
        alert.informativeText = "Deletes the app and its setup data (~2 GB). If Q-SYS Designer is open, it will be closed. Your own installer file is not touched."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        removing = true; removeMsg = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let s = Uninstaller.remove()
            DispatchQueue.main.async {
                removing = false
                removeMsg = s.failures.isEmpty
                    ? "Removed Q-SYS Designer."
                    : "Removed what I could — couldn’t delete: \(s.failures.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))."
            }
        }
    }

    private func installRosetta() {
        installingRosetta = true
        rosettaError = nil
        rosettaNote = nil
        RosettaInstaller.install { outcome in
            installingRosetta = false
            switch outcome {
            case .installed:
                notices = EnvChecks.notices                          // re-probe; clears the card once Rosetta is present
                if hasBlocker { rosettaNote = "Rosetta 2 installed." } // still blocking (e.g. the test override) → confirm it ran
            case .canceled: break                                     // user dismissed the auth dialog — nothing to report
            case .failed(let msg): rosettaError = msg
            }
        }
    }

    @ViewBuilder private var noticesBanner: some View {
        if !notices.isEmpty {
            VStack(spacing: 8) {
                ForEach(notices) { n in
                    // .center so the trailing buttons sit vertically centered against the text block.
                    HStack(alignment: .center, spacing: 8) {
                        Image(systemName: n.kind == .blocker ? "exclamationmark.triangle.fill" : "info.circle.fill")
                            .foregroundStyle(n.kind == .blocker ? Color.orange : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(n.title).font(.callout).bold()
                            Text(n.detail).font(.caption).foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if n.action == .installRosetta, let rosettaError {
                                Text(rosettaError).font(.caption).foregroundStyle(.red)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if n.action == .installRosetta, let rosettaNote {
                                Label(rosettaNote, systemImage: "checkmark.circle.fill")
                                    .font(.caption).foregroundStyle(.green)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                        if n.kind == .blocker {
                            if n.action == .installRosetta && installingRosetta {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.small)
                                    Text("Installing…").font(.caption).foregroundStyle(.secondary)
                                }
                            } else {
                                HStack(spacing: 8) {
                                    if n.action == .installRosetta {
                                        Button("Install Rosetta", action: installRosetta).controlSize(.small)
                                    }
                                    Button("Re-check") { notices = EnvChecks.notices }.controlSize(.small)
                                }
                            }
                        }
                    }
                    .padding(10)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private var dropZone: some View {
        VStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8]))
                .foregroundStyle(dropTargeted ? Color.accentColor : Color.secondary)
                .frame(height: 150)
                .overlay(
                    VStack(spacing: 10) {
                        Image(systemName: "arrow.down.doc")
                            .font(.system(size: 34, weight: .regular))
                            .foregroundStyle(dropTargeted ? Color.accentColor : Color.secondary)
                        Text(dropTargeted ? "Release to use this installer" : "Drag installer .exe here")
                            .foregroundStyle(.secondary)
                    }
                )
                .onDrop(of: [.fileURL], isTargeted: $dropTargeted, perform: handleDrop)
            Button("Choose Installer…", action: chooseInstaller)
        }
    }

    private var running: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(stepHeadline).font(.callout).bold()
                Spacer()
                if let p = provisioner.progress {
                    Text("\(Int(p * 100))%").font(.callout).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            if let p = provisioner.progress {
                ProgressView(value: p).progressViewStyle(.linear)
            } else {
                ProgressView().progressViewStyle(.linear)   // indeterminate until the first step lands
            }
            logView
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { provisioner.cancel() }
            }
        }
    }

    private var stepHeadline: String {
        if provisioner.stepTotal > 0 {
            return "Step \(provisioner.stepIndex) of \(provisioner.stepTotal) — \(provisioner.stepLabel)"
        }
        return provisioner.stepLabel.isEmpty ? "Setting up… this takes a few minutes" : provisioner.stepLabel
    }

    private var success: some View {
        VStack(spacing: 12) {
            switch emit {
            case .pending, .installing:
                ProgressView()
                Text("Installing Q-SYS Designer into Applications…").font(.headline)
            case .done(let r):
                Image(systemName: "checkmark.circle.fill").font(.largeTitle).foregroundStyle(.green)
                Text("Q-SYS Designer is in your Applications folder.").font(.headline)
                if r.usedUserApplications {
                    Text("Placed in your Home Applications folder (no admin access to /Applications).")
                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                VStack(spacing: 10) {
                    Button("Launch Q-SYS Designer") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: r.installedPath))
                        NSApp.terminate(nil)
                    }.keyboardShortcut(.defaultAction)
                    HStack(spacing: 18) {
                        Button("Reveal in Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: r.installedPath)])
                            NSApp.terminate(nil)
                        }.buttonStyle(.link)
                        Button("Done") { NSApp.terminate(nil) }.buttonStyle(.link)
                    }
                }
                Text("You can eject this installer.").font(.caption).foregroundStyle(.secondary)
            case .failed(let why):
                Image(systemName: "xmark.octagon.fill").font(.largeTitle).foregroundStyle(.red)
                Text("Couldn’t place Q-SYS Designer").font(.headline)
                Text(why).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Try Again") { runEmit() }
            }
        }
        .onAppear { if case .pending = emit { runEmit() } }
    }

    private func runEmit() {
        emit = .installing
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let r = try Emitter.install()
                DispatchQueue.main.async { emit = .done(r) }
            } catch {
                DispatchQueue.main.async { emit = .failed(error.localizedDescription) }
            }
        }
    }

    private func failure(_ why: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Setup failed", systemImage: "xmark.octagon.fill").foregroundStyle(.red).font(.headline)
            Text(why)
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            logView
            Button("Try Again") { provisioner.reset() }
        }
    }

    private var logView: some View {
        ScrollView {
            Text(provisioner.log.isEmpty ? "…" : provisioner.log)
                .font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .frame(height: 170)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        _ = provider.loadObject(ofClass: URL.self) { url, _ in
            guard let url, url.pathExtension.lowercased() == "exe" else { return }
            // Accept only a real file — not a directory or symlink that merely ends in ".exe".
            guard (try? FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType) == .typeRegular
            else { return }
            Task { @MainActor in selectedInstaller = url.path }   // show it + an Install button; don't auto-start
        }
        return true
    }

    private func chooseInstaller() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "exe") ?? .data]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            selectedInstaller = url.path
        }
    }
}
