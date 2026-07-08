// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// Installer entry — this IS "Q-SYS Mac Installer.app" (lives on the dmg). It always shows
// the first-run setup UI: drop your installer, provision Wine+Designer into App Support, then
// emit "Q-SYS Designer.app" into /Applications carrying the extracted QSC icon (see Emit.swift).
// Zero QSC code.

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
