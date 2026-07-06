// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// appmenu.m — in-process macOS app-menu shim for the Q-SYS Designer BYO wrapper.
//
// Problem: under Wine, the bold app menu opens an EMPTY dropdown — no About/Hide/Quit and no
// Window menu. winemac.drv DOES build a menu, but only inside
// `if ([NSApp activationPolicy] != NSApplicationActivationPolicyRegular)`
// (cocoa_app.m: transformProcessToForeground). Once the loose loader carries a real
// CFBundleName/CFBundleIdentifier (we set that for the menu-bar NAME), macOS can start it
// Regular, so winemac skips the build → empty dropdown. We install a complete menu instead.
// (The bold name shown is the FIRST menu item's title — winemac titles it WineAppMenuName()
// = "wine"; replacing the menu is also how we control that name per process.)
//
// BLAST RADIUS: DYLD_INSERT_LIBRARIES injects this into EVERY wine process in the prefix
// (the main app, CefSharp.BrowserSubprocess helpers, winedevice, explorer, winecfg…). If
// each one forced itself to be a Regular foreground app, they'd fight the main app for the
// foreground (a Wine tile keeps popping in the Dock, child windows land behind). So we detect
// this process's ROLE from argv and act narrowly:
//   • MAIN    (…/Q-Sys Designer.exe)      → menu "Q-SYS Designer": About / Preferences…(→
//                                            winecfg) / Hide / Hide Others / Show All / Quit
//                                            + Window menu.
//   • WINECFG (wine winecfg, from Prefs…) → pull to the front + menu "Wine Settings": Hide /
//                                            Hide Others / Show All / Quit + Window menu.
//   • OTHER   (subprocess/helper/etc.)    → do nothing at all.
//
// Quit→terminate:, Hide→hide:, etc. resolve up the responder chain to NSApp, exactly as
// winemac's own menu does; ⌘Q works regardless. Contains zero QSC code.
//
// Build:  clang -arch x86_64 -arch arm64 -dynamiclib -framework Cocoa -fobjc-arc \
//               -mmacosx-version-min=11.0 -o appmenu.dylib appmenu.m
// Inject: DYLD_INSERT_LIBRARIES=<path>/appmenu.dylib  (survives Wine's loader re-exec
//         because the loaders are ad-hoc signed without library-validation).

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <crt_externs.h>   // _NSGetArgv / _NSGetArgc — this process's unix argv
#import <sys/stat.h>      // lstat / struct stat / S_ISLNK / mkdir — user-dir link toggle
#import <unistd.h>        // symlink / unlink / rmdir — user-dir link toggle

typedef enum { ROLE_OTHER = 0, ROLE_MAIN, ROLE_WINECFG } QSYSRole;

// Sentinel tag on the application-menu item so we tell "ours" from a clobbered menu and
// skip needless rebuilds. 'QSYS'.
static const NSInteger kQSYSMenuTag = 0x51535953;

static QSYSRole gRole = ROLE_OTHER;
static BOOL gBuilding = NO;          // re-entrancy guard (our own setMainMenu: call)
static BOOL gActivated = NO;         // WINECFG: pulled to the front yet?
static NSString *gMenuName = nil;    // bold app-menu name for THIS process
static BOOL gFullMenu = NO;          // include About + Preferences… (MAIN only)
static NSImage *gOurIcon = nil;      // cached desired Dock icon (QSYS_ICON), loaded once
static BOOL gSettingIcon = NO;       // re-entrancy guard (our own setApplicationIconImage: call)
static NSMenuItem *gLinkItem = nil;  // the single Link⇄Unlink item (MAIN); title set by menu delegate

static void qsyslog(const char *msg) {
    const char *p = getenv("QSYS_MENU_LOG");   // unset in production → silent
    if (!p || !*p) return;
    FILE *f = fopen(p, "a");
    if (!f) return;
    fprintf(f, "[appmenu] %s (pid %d)\n", msg, getpid());
    fclose(f);
}

// User-commanded home-folder linking — the "Link to User Directories" menu item. By default the
// prefix is sandboxed: the Windows profile's Desktop/Documents/Downloads/Music/Pictures/Videos are
// empty, prefix-local dirs, so Designer never reaches the Mac home unprompted (lib/recipe.sh
// init_prefix). This makes the convenience opt-in — on command, swap each empty local dir for a
// symlink to the real Mac folder. Creating a symlink does NOT read through it, so this triggers no
// TCC prompt itself; macOS asks the first time Designer actually opens one, by then clearly
// user-initiated. We only ever replace an EMPTY local dir (rmdir fails on a non-empty one, then
// symlink no-ops on the still-present path), so locally-saved files are never clobbered. Wine maps
// the Windows "Videos" folder to ~/Movies.
static void qsysApplyUserDirLinks(BOOL link) {
    const char *prefix = getenv("WINEPREFIX");
    const char *home   = getenv("HOME");
    if (!prefix || !*prefix || !home || !*home) { NSBeep(); return; }
    NSString *base = [NSString stringWithFormat:@"%s/drive_c/users/%@", prefix, NSUserName()];
    NSArray<NSArray<NSString *> *> *pairs = @[
        @[ @"Desktop", @"Desktop" ], @[ @"Documents", @"Documents" ], @[ @"Downloads", @"Downloads" ],
        @[ @"Music", @"Music" ], @[ @"Pictures", @"Pictures" ], @[ @"Videos", @"Movies" ],
    ];
    for (NSArray<NSString *> *pr in pairs) {
        NSString *path   = [base stringByAppendingPathComponent:pr[0]];
        NSString *target = [NSString stringWithFormat:@"%s/%@", home, pr[1]];
        const char *cpath = path.fileSystemRepresentation;
        struct stat st;
        BOOL isLink = (lstat(cpath, &st) == 0) && S_ISLNK(st.st_mode);
        if (link) {
            if (isLink) continue;                               // already linked
            rmdir(cpath);                                       // only removes our empty local dir
            symlink(target.fileSystemRepresentation, cpath);    // no-op if a non-empty dir remains
        } else {
            if (!isLink) continue;                              // not a link we made — leave it
            unlink(cpath);                                      // drop the link; never touches the Mac folder
            mkdir(cpath, 0755);                                 // restore an empty local dir
        }
    }
    qsyslog(link ? "user dirs linked" : "user dirs unlinked");
}

static void qsysAlert(NSString *title, NSString *info) {
    NSAlert *a = [[NSAlert alloc] init];
    a.messageText = title;
    a.informativeText = info;
    [a addButtonWithTitle:@"OK"];
    [a runModal];
}

// True iff the user has linked their Mac home dirs (we probe the representative Downloads folder).
static BOOL qsysUserDirsLinked(void) {
    const char *prefix = getenv("WINEPREFIX");
    if (!prefix || !*prefix) return NO;
    NSString *p = [NSString stringWithFormat:@"%s/drive_c/users/%@/Downloads", prefix, NSUserName()];
    struct stat st;
    return (lstat(p.fileSystemRepresentation, &st) == 0) && S_ISLNK(st.st_mode);
}

// Classify this process from its argv. Wine launches the main app as `wine ".../Q-Sys
// Designer.exe"` and helpers as `wine ".../CefSharp.BrowserSubprocess.exe" …` etc., so the
// exe path is right there in argv even after the loader re-exec (verified). Check
// BrowserSubprocess first: a CEF helper's argv can also reference the main exe path.
static QSYSRole detectRole(void) {
    int argc = *_NSGetArgc();
    char **argv = *_NSGetArgv();
    BOOL hasDesigner = NO, hasWinecfg = NO;
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (!a) continue;
        if (strcasestr(a, "BrowserSubprocess")) return ROLE_OTHER;
        if (strcasestr(a, "Q-Sys Designer.exe")) hasDesigner = YES;
        if (strcasestr(a, "winecfg")) hasWinecfg = YES;
    }
    if (hasWinecfg) return ROLE_WINECFG;   // winecfg never carries the Designer exe
    if (hasDesigner) return ROLE_MAIN;
    return ROLE_OTHER;
}

static NSString *resolveAppName(void) {
    const char *e = getenv("QSYS_MENU_NAME");
    if (e && *e) return [NSString stringWithUTF8String:e];
    NSString *n = [[NSBundle mainBundle] objectForInfoDictionaryKey:(NSString *)kCFBundleNameKey];
    if (n.length) return n;
    return @"Q-SYS Designer";
}

@interface QSYSMenuShim : NSObject <NSMenuDelegate>
+ (instancetype)shared;
- (void)qsysOpenPreferences:(id)sender;
- (void)qsysShowAbout:(id)sender;
- (void)qsysToggleDirs:(id)sender;
- (void)qsysRebuild:(NSNotification *)note;
- (void)qsysActivate:(NSNotification *)note;
@end

// Build (or re-assert) the app menu. MAIN only. Idempotent: a no-op when our menu is already
// installed (sentinel present). Must run on the main thread (AppKit). Never recurses because
// the nested setMainMenu: it triggers is guarded by gBuilding.
//
// We deliberately do NOT install or replace a menu for WINECFG: that process starts as a Prohibited
// app and winemac only sets its Dock ICON inside transformProcessToForeground (gated on
// activationPolicy != Regular); forcing Regular to swap the menu skips that block and the icon
// vanishes. For winecfg we instead RELABEL winemac's existing item 0 + window title in place
// (fixWinecfgChrome) — no activation-policy change, so the Dock icon stays.
// Force the Dock/app icon to the bundle's .icns (path via QSYS_ICON). winemac sets its own
// edge-to-edge icon from the exe during launch — and can re-set it later — so this is NOT a
// one-shot: it's re-asserted from the setApplicationIconImage: swizzle after any foreign set,
// the same way the menu is re-asserted from the setMainMenu: swizzle. MAIN only. Idempotent.
static NSImage *ourIcon(void) {
    if (gOurIcon) return gOurIcon;
    const char *p = getenv("QSYS_ICON");
    if (!p || !*p) return nil;
    gOurIcon = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:p]];
    return gOurIcon;
}

static void reassertAppIcon(void) {
    if (gRole != ROLE_MAIN || !NSApp) return;
    NSImage *mine = ourIcon();
    if (!mine) return;
    if ([NSApp applicationIconImage] == mine) return;   // already ours — nothing to do
    gSettingIcon = YES;
    [NSApp setApplicationIconImage:mine];
    gSettingIcon = NO;
    qsyslog("icon set");
}

static void buildMenu(void) {
    if (gRole != ROLE_MAIN) return;
    NSApplication *app = NSApp;
    if (!app || gBuilding) return;

    reassertAppIcon();

    NSMenu *cur = [app mainMenu];
    if (cur.numberOfItems > 0 && [[cur itemAtIndex:0] tag] == kQSYSMenuTag)
        return;  // already ours

    gBuilding = YES;

    // Only nudge the activation policy if winemac left us as an Accessory — never re-assert
    // it (that's what made helper processes fight for the foreground).
    if ([app activationPolicy] != NSApplicationActivationPolicyRegular)
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];

    NSString *name = gMenuName.length ? gMenuName : @"Q-SYS Designer";
    QSYSMenuShim *helper = [QSYSMenuShim shared];

    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];

    // --- Application menu (its first-item title IS the bold app-menu name macOS shows) ---
    NSMenuItem *appItem = [[NSMenuItem alloc] initWithTitle:name action:NULL keyEquivalent:@""];
    appItem.tag = kQSYSMenuTag;
    [mainMenu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:name];
    appItem.submenu = appMenu;

    if (gFullMenu) {   // MAIN only — About/Preferences are Designer-specific
        NSMenuItem *about = [appMenu addItemWithTitle:[NSString stringWithFormat:@"About %@", name]
                                               action:@selector(qsysShowAbout:)
                                        keyEquivalent:@""];
        about.target = helper;   // our handler → explicit options, not Wine's mainBundle (A3)
        [appMenu addItem:[NSMenuItem separatorItem]];
        NSMenuItem *prefs = [appMenu addItemWithTitle:@"Preferences…"
                                               action:@selector(qsysOpenPreferences:)
                                        keyEquivalent:@","];
        prefs.target = helper;   // our own handler → spawns winecfg
        [appMenu addItem:[NSMenuItem separatorItem]];

        // User-commanded home-folder linking — ONE state-aware item (Link ⇄ Unlink). The menu
        // delegate (menuNeedsUpdate:) sets its title from the live prefix state before it draws.
        gLinkItem = [appMenu addItemWithTitle:@"Link to User Directories"
                                       action:@selector(qsysToggleDirs:) keyEquivalent:@""];
        gLinkItem.target = helper;
        appMenu.delegate = helper;
        [appMenu addItem:[NSMenuItem separatorItem]];
    }

    [appMenu addItemWithTitle:[NSString stringWithFormat:@"Hide %@", name]
                       action:@selector(hide:) keyEquivalent:@"h"];
    NSMenuItem *hideOthers = [appMenu addItemWithTitle:@"Hide Others"
                                                action:@selector(hideOtherApplications:)
                                         keyEquivalent:@"h"];
    hideOthers.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
    [appMenu addItemWithTitle:@"Show All"
                       action:@selector(unhideAllApplications:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:[NSString stringWithFormat:@"Quit %@", name]
                       action:@selector(terminate:) keyEquivalent:@"q"];

    // --- Window menu ---
    NSMenuItem *winItem = [[NSMenuItem alloc] initWithTitle:@"Window" action:NULL keyEquivalent:@""];
    [mainMenu addItem:winItem];
    NSMenu *winMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    winItem.submenu = winMenu;
    [winMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [winMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
    [winMenu addItem:[NSMenuItem separatorItem]];
    [winMenu addItemWithTitle:@"Bring All to Front" action:@selector(arrangeInFront:) keyEquivalent:@""];

    [app setMainMenu:mainMenu];
    [app setWindowsMenu:winMenu];

    gBuilding = NO;
    qsyslog("menu installed");
}

// WINECFG: relabel winemac's bold app-menu item 0 and the window caption to "Wine Configuration"
// in place. Cosmetic only — no menu replacement, no activation-policy change, so winemac keeps its
// Dock icon. Re-asserted after late winemac rebuilds (via the setMainMenu: swizzle + activation).
static void fixWinecfgChrome(void) {
    if (gRole != ROLE_WINECFG || !NSApp) return;
    NSMenu *main = [NSApp mainMenu];
    if (main.numberOfItems > 0) {
        NSMenuItem *appItem = [main itemAtIndex:0];
        if (![appItem.title isEqualToString:@"Wine Configuration"]) appItem.title = @"Wine Configuration";
        appItem.submenu.title = @"Wine Configuration";
    }
    for (NSWindow *w in [NSApp windows]) {   // retitle only the config window, not stray panels
        NSString *t = w.title;
        if (t.length && [t rangeOfString:@"onfiguration"].location != NSNotFound &&
            ![t isEqualToString:@"Wine Configuration"])
            w.title = @"Wine Configuration";
    }
}

// Swizzled -[NSApplication setMainMenu:]: after anyone installs a menu, re-assert our chrome.
static void (*gOrigSetMainMenu)(id, SEL, NSMenu *) = NULL;
static void qsys_setMainMenu(id self, SEL _cmd, NSMenu *menu) {
    if (gOrigSetMainMenu) gOrigSetMainMenu(self, _cmd, menu);
    if (gBuilding) return;                          // our own buildMenu: setMainMenu — ignore
    dispatch_async(dispatch_get_main_queue(), ^{    // deferred + coalesced
        if (gRole == ROLE_MAIN)         buildMenu();
        else if (gRole == ROLE_WINECFG) fixWinecfgChrome();
    });
}

// Swizzled -[NSApplication setApplicationIconImage:]: winemac sets the exe's edge-to-edge icon
// during launch (and can re-set it later), clobbering ours. After any set that isn't ours,
// re-impose the padded .icns. Bounded: our own re-impose runs under gSettingIcon → no re-dispatch.
static void (*gOrigSetAppIcon)(id, SEL, NSImage *) = NULL;
static void qsys_setApplicationIconImage(id self, SEL _cmd, NSImage *image) {
    if (gOrigSetAppIcon) gOrigSetAppIcon(self, _cmd, image);
    if (gSettingIcon) return;                    // our own set — let it stand
    if (gOurIcon && image == gOurIcon) return;   // already ours
    dispatch_async(dispatch_get_main_queue(), ^{ reassertAppIcon(); });  // deferred + coalesced
}

@implementation QSYSMenuShim

+ (instancetype)shared {
    static QSYSMenuShim *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [[QSYSMenuShim alloc] init]; });
    return s;
}

// Install at image load. Role-scoped so helper processes stay untouched. We do NOT touch
// NSApp here (it may be nil this early); observers + the swizzle drive the work later.
+ (void)load {
    @autoreleasepool {
        gRole = detectRole();
        if (gRole == ROLE_OTHER) { qsyslog("other — inert"); return; }

        NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
        QSYSMenuShim *h = [QSYSMenuShim shared];

        if (gRole == ROLE_WINECFG) {
            // winecfg: pull to the front, and relabel the bold app-menu + window title to
            // "Wine Configuration" (it otherwise inherits the loader's patched "Q-SYS Designer"
            // name and a lowercase "configuration" caption). We RELABEL in place, never replace the
            // menu or touch the activation policy — so winemac's Dock icon survives. Re-asserted
            // after any late winemac menu rebuild via the setMainMenu: swizzle.
            [nc addObserver:h selector:@selector(qsysActivate:)
                       name:NSApplicationDidFinishLaunchingNotification object:nil];
            [nc addObserver:h selector:@selector(qsysActivate:)
                       name:NSApplicationDidBecomeActiveNotification object:nil];
            Class cls = objc_getClass("NSApplication");
            Method m = cls ? class_getInstanceMethod(cls, @selector(setMainMenu:)) : NULL;
            if (m) {
                gOrigSetMainMenu = (void (*)(id, SEL, NSMenu *))method_getImplementation(m);
                method_setImplementation(m, (IMP)qsys_setMainMenu);
            }
            qsyslog("winecfg — will relabel");
            return;
        }

        // ROLE_MAIN: own the app menu.
        gMenuName = resolveAppName();
        gFullMenu = YES;
        Class cls = objc_getClass("NSApplication");
        Method m = cls ? class_getInstanceMethod(cls, @selector(setMainMenu:)) : NULL;
        if (m) {
            gOrigSetMainMenu = (void (*)(id, SEL, NSMenu *))method_getImplementation(m);
            method_setImplementation(m, (IMP)qsys_setMainMenu);
        }
        Method mi = cls ? class_getInstanceMethod(cls, @selector(setApplicationIconImage:)) : NULL;
        if (mi) {
            gOrigSetAppIcon = (void (*)(id, SEL, NSImage *))method_getImplementation(mi);
            method_setImplementation(mi, (IMP)qsys_setApplicationIconImage);
        }
        [nc addObserver:h selector:@selector(qsysRebuild:)
                   name:NSApplicationDidFinishLaunchingNotification object:nil];
        [nc addObserver:h selector:@selector(qsysRebuild:)
                   name:NSApplicationDidBecomeActiveNotification object:nil];
        qsyslog("main — menu armed");
    }
}

// MAIN: build the menu. The delayed re-assert beats late clobbering (e.g. winemac/CEF
// building their own menu after us); a no-op once our sentinel is in place.
- (void)qsysRebuild:(NSNotification *)note {
    buildMenu();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.7 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ buildMenu(); });
}

// WINECFG: pull our window to the front the first time — Preferences… spawned us behind the
// main app. We leave winemac's menu + Dock icon untouched (so the icon stays).
- (void)qsysActivate:(NSNotification *)note {
    if (!gActivated) { gActivated = YES; [NSApp activateIgnoringOtherApps:YES]; }
    fixWinecfgChrome();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.7 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ fixWinecfgChrome(); });
    qsyslog("winecfg activated + relabeled");
}

// Custom About (audit A3): the standard panel pulls its content from [NSBundle mainBundle],
// which in this injected-into-Wine process is Wine's own bundle — so pass everything
// explicitly. Credits carries the nominative-use trademark / non-affiliation notice.
- (void)qsysShowAbout:(id)sender {
    NSString *name = gMenuName ?: @"Q-SYS Designer";
    NSString *notice = @"Unofficial community wrapper — not affiliated with, endorsed by, or "
                        "sponsored by QSC, LLC.\n“Q-SYS” and “Q-SYS Designer” are "
                        "trademarks of QSC, LLC, used nominatively to name the software you supplied.\n"
                        "Wrapper: GPL-3.0-or-later · github.com/reowens/qsys-tools";
    NSMutableParagraphStyle *center = [[NSMutableParagraphStyle alloc] init];
    center.alignment = NSTextAlignmentCenter;
    NSAttributedString *credits = [[NSAttributedString alloc] initWithString:notice attributes:@{
        NSFontAttributeName: [NSFont systemFontOfSize:[NSFont smallSystemFontSize]],
        NSForegroundColorAttributeName: [NSColor secondaryLabelColor],
        NSParagraphStyleAttributeName: center,
    }];
    NSDictionary *opts = @{
        NSAboutPanelOptionApplicationName: name,
        NSAboutPanelOptionCredits: credits,
        NSAboutPanelOptionApplicationIcon: ourIcon() ?: [NSApp applicationIconImage] ?: [NSImage new],
    };
    [NSApp orderFrontStandardAboutPanelWithOptions:opts];
}

- (void)qsysOpenPreferences:(id)sender {
    const char *loader = getenv("WINELOADER");
    if (!loader || !*loader) loader = getenv("WINE");
    if (!loader || !*loader) { NSBeep(); return; }
    NSTask *t = [[NSTask alloc] init];
    t.launchPath = [NSString stringWithUTF8String:loader];
    t.arguments = @[ @"winecfg" ];   // inherits WINEPREFIX from the environment
    @try { [t launch]; }
    @catch (NSException *e) { NSBeep(); }
}

// One menu item, state-aware. menuNeedsUpdate: runs right before the app menu draws, so the title
// always matches reality even if the prefix changed since the menu was built.
- (void)menuNeedsUpdate:(NSMenu *)menu {
    if (gLinkItem)
        gLinkItem.title = qsysUserDirsLinked() ? @"Unlink User Directories"
                                               : @"Link to User Directories";
}

- (void)qsysToggleDirs:(id)sender {
    if (qsysUserDirsLinked()) {
        qsysApplyUserDirLinks(NO);
        qsysAlert(@"Unlinked from your user directories",
                  @"Designer no longer has a path into your Mac home folders. Reach your files "
                  @"through the Z: drive instead (Z:\\Users\\<your-name>).");
    } else {
        qsysApplyUserDirLinks(YES);
        qsysAlert(@"Linked to your user directories",
                  @"Your Mac Desktop, Documents, Downloads, Music, Pictures and Movies now appear "
                  @"in Designer's File ▸ Open / Save dialogs. macOS will ask your permission the "
                  @"first time Designer opens each one — that's expected, and only because you asked.");
    }
}

@end
