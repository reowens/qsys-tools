// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// AppDelegate — hosts the first-run setup window (the not-provisioned branch).

import AppKit
import SwiftUI

/// Hosting controller that pins its window's content size to the SwiftUI content's TRUE height on every
/// layout, so the window always fits exactly (no clipping) and re-fits on every content change (state
/// transitions, notice cards appearing/clearing). Grows/shrinks from the TOP edge.
///
/// Height is measured with `sizeThatFits(in:)` proposing our fixed width and unbounded height — that
/// forces wrapping text to its real multi-line height. `view.fittingSize` / the `.intrinsicContentSize`
/// option under-report (they measured ~45pt short and clipped the bottom button), so we don't use them.
final class AutoFitHostingController<Content: View>: NSHostingController<Content> {
    static var fixedWidth: CGFloat { 520 }

    func desiredContentSize() -> NSSize {
        sizeThatFits(in: NSSize(width: Self.fixedWidth, height: 100_000))
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        guard let window = view.window else { return }
        let target = desiredContentSize()
        guard target.width > 0, target.height > 0 else { return }
        let chrome = window.frame.height - window.contentLayoutRect.height   // title bar height
        let newHeight = target.height + chrome
        guard abs(newHeight - window.frame.height) > 0.5
                || abs(target.width - window.frame.width) > 0.5 else { return }   // already fits → no loop
        var f = window.frame
        f.origin.y += f.size.height - newHeight   // keep the top edge fixed as height changes
        f.size.height = newHeight
        f.size.width = target.width
        window.setFrame(f, display: true)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let provisioner = Provisioner()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Probe the environment once, before the window exists, so any blocker/advisory cards are in
        // the first paint and the window opens already sized to fit them.
        let host = AutoFitHostingController(rootView: SetupView(
            provisioner: provisioner, initialNotices: EnvChecks.notices))
        host.sizingOptions = []   // we drive the window size ourselves; no AppKit auto-constraints to fight

        let window = NSWindow(contentViewController: host)
        window.title = "Install Q-SYS Designer"
        window.styleMask.remove(.resizable)   // fixed installer window — auto-fit only, no user resize
        // Initial fit before showing so the first paint isn't clipped (viewDidLayout owns it thereafter).
        host.view.layoutSubtreeIfNeeded()
        window.setContentSize(host.desiredContentSize())
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
