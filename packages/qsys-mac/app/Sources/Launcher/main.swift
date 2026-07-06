// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// Launcher entry — this IS "/Applications/Q-SYS Designer.app". The installer already
// provisioned Wine+Designer into ~/Library/Application Support, so this app only launches
// it: become wine and run Designer (no UI, instant handoff). Zero QSC code.

import AppKit

// Hidden reaper mode, spawned by the launch path below just before it execve's into wine. Watches
// the launcher pid (which becomes wine) and runs `wineserver -k` when it exits — clean quit OR
// crash — so nothing orphans to PPID 1. Never touches AppKit ⇒ invisible (no Dock tile / menu),
// so the visible identity stays with the execve'd wine.
// The reaper is spawned ONLY by DataDir.spawnReaper (a detached posix_spawn of ourselves), which
// sets QSYS_REAPER=1 in the child env and always passes our own positive pid. Honor `--reap` only
// with that token + a positive pid; otherwise decline without tearing anything down. Without this,
// `open "Q-SYS Designer.app" --args --reap 0` would call reapAfter(0) → immediate `wineserver -k`,
// killing a RUNNING Designer.
if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--reap" {
    let isInternal = ProcessInfo.processInfo.environment["QSYS_REAPER"] == "1"
    let watched = pid_t(CommandLine.arguments[2]) ?? 0
    if isInternal, watched > 0 {
        DataDir.reapAfter(pid: watched)   // -> Never
    }
    exit(0)   // external/malformed --reap: never teardown, never launch a fresh instance
}

if DataDir.isProvisioned {
    DataDir.spawnReaper(watching: getpid())   // invisible sidecar; reaps when we (→ wine) exit
    DataDir.launchDesigner()                  // -> Never; THIS process becomes wine (identity kept)
}

// Not set up — the App Support data dir was removed, this ran before the installer, or the
// data dir was provisioned by an OLDER recipe this build refuses to boot (schema gate,
// a stale layout looks installed but is missing components and NREs in use).
// There is no setup UI here (that lives in "Install Q-SYS Designer"); point the user at it.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)

let alert = NSAlert()
if DataDir.isStaleProvision {
    alert.messageText = "Q-SYS Designer needs to be updated"
    alert.informativeText = "This install was set up by an older version of the installer and is missing components. Run “Install Q-SYS Designer” again with your Designer installer to update it, then open it again. Your designs are not affected."
} else {
    alert.messageText = "Q-SYS Designer isn’t set up yet"
    alert.informativeText = "Run “Install Q-SYS Designer” to set up Q-SYS Designer on this Mac, then open it again."
}
alert.alertStyle = .warning
alert.addButton(withTitle: "OK")
alert.runModal()
exit(1)
