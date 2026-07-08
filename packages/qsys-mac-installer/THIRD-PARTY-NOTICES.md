# Third-party notices

The Q-SYS Designer installer bundles the free, redistributable components below to set up
Q-SYS Designer on your Mac without downloading Wine/.NET/helper payloads at first run. It
bundles **no QSC / Q-SYS bytes** — Q-SYS Designer is your own BYO download and is never
redistributed here.

> **Unofficial — not affiliated with, endorsed, or sponsored by QSC, LLC.** "Q-SYS" and
> "Q-SYS Designer" are trademarks of QSC, LLC, used here only nominatively to name the
> software you supply. This project is an independent, community-built wrapper.

| Component | Version | Role in the installer | License |
|-----------|---------|-----------------|---------|
| **Wine** (gcenx `wine-staging` build) | 11.10 | the Windows compatibility layer Designer runs on | LGPL-2.1-or-later |
| **.NET Desktop Runtime** (Microsoft) | 8.0.28 | Designer is a .NET 8 WPF app | MS .NET Library License (redistributable binaries); source MIT |
| **ASP.NET Core Runtime** (Microsoft) | 8.0.28 | required by Designer's `runtimeconfig` | MS .NET Library License (redistributable binaries); source MIT |
| **p7zip** (`7z`) | 17.06 | unpacks your Q-SYS Designer download | LGPL-2.1-or-later / GPL |
| **libpng** (`libpng16`) | bundled | icon extraction dependency of icoutils | PNG Reference Library License (zlib-style) |
| **icoutils** (`wrestool`, `icotool`) | 0.32.3 | extracts Designer's app icon from the download | **GPL-3.0-or-later** |
| **msiinfo** (`msitools`) | 0.106 | reads the MSI layout tables from your Designer installer | **GPL-2.0-or-later** for the CLI tool; LGPL-2.1-or-later for libmsi |
| **GLib/GIO/GObject/GModule** | 2.88.x | runtime libraries used by `msiinfo`/`libmsi` | LGPL-2.1-or-later |
| **libgsf** | 1.14.58 | structured-file runtime library used by `libmsi` | LGPL-2.1-only |
| **GNU libintl** (`gettext`) | 1.0 | localization runtime used by GLib/libgsf | LGPL-2.1-or-later |
| **PCRE2** | 10.47 | regular expression runtime used by GLib | BSD-3-Clause WITH PCRE2-exception |

Each is invoked as a separate process during setup (mere aggregation). The installer's original
source code is licensed **MIT** (see the project `LICENSE` and README).

## Written offer of source code (GPL components)

icoutils is licensed under the GNU General Public License, version 3. The bundled
`msiinfo` CLI source carries GPL-2.0-or-later notices. p7zip also includes GPL-2.0-or-later
components. In accordance with the applicable GPL source-distribution terms, this
distribution accompanies those bundled binaries with the following **written offer, valid for
three (3) years** from the date you received this copy:

> We will provide, to anyone who possesses this object code, the complete corresponding
> machine-readable source code for the bundled GPL components, under their respective GPL
> terms, for a charge no more than our reasonable cost of physically performing the source
> distribution. Request it by emailing <robowens@me.com> or opening an issue at
> <https://github.com/reowens/qsys-tools/issues>.

## Corresponding source code

All bundled binaries are built from unmodified upstream source:

- **Wine** (gcenx `wine-staging` 11.10, LGPL-2.1-or-later) — binary from
  <https://github.com/Gcenx/macOS_Wine_builds>, built from WineHQ source
  <https://gitlab.winehq.org/wine/wine> (tag `wine-11.10`) plus the wine-staging patchset
  <https://gitlab.winehq.org/wine/wine-staging>.
- **p7zip** (`7z`, 17.06, LGPL-2.1-or-later / GPL) — packaged via Homebrew from the p7zip project
  <https://sourceforge.net/projects/p7zip/> (Homebrew tracks the maintained fork
  <https://github.com/jinfeihan57/p7zip>).
- **icoutils** (`wrestool`, `icotool`, 0.32.3, GPL-3.0-or-later) — <https://www.nongnu.org/icoutils/>.
- **libpng** (`libpng16`, PNG/zlib-style) — <http://www.libpng.org/pub/png/libpng.html>.
- **msitools / msiinfo** (0.106; `msiinfo` GPL-2.0-or-later, `libmsi` LGPL-2.1-or-later) —
  <https://download.gnome.org/sources/msitools/0.106/msitools-0.106.tar.xz>.
- **GLib/GIO/GObject/GModule** (2.88.x, LGPL-2.1-or-later) —
  <https://download.gnome.org/sources/glib/>.
- **libgsf** (1.14.58, LGPL-2.1-only) — <https://gitlab.gnome.org/GNOME/libgsf>.
- **GNU libintl / gettext runtime** (1.0, LGPL-2.1-or-later for libintl) —
  <https://www.gnu.org/software/gettext/>.
- **PCRE2** (10.47, BSD-3-Clause WITH PCRE2-exception) — <https://www.pcre.org/>.
- **.NET Desktop & ASP.NET Core Runtimes 8.0.28** — the `dotnet/runtime` *source* is MIT
  (<https://github.com/dotnet/runtime>, <https://github.com/dotnet/runtime/blob/main/LICENSE.TXT>),
  but the official Microsoft runtime *binaries / installers* bundled here are redistributed under
  Microsoft's **.NET Library License**, whose text ships as `LICENSE.TXT` inside each runtime
  installer and grants a royalty-free right to redistribute the unmodified runtime with an
  application. Installers from <https://dotnet.microsoft.com/download/dotnet/8.0>.
- **Selawik** (1.01, SIL OFL 1.1, Reserved Font Name "Selawik") — Microsoft's Segoe-metric-
  compatible font, <https://github.com/microsoft/Selawik>. Redistributed **unmodified** in
  `assets/fonts/selawik/` with its `LICENSE.txt`. At provision time the recipe derives a
  locally-renamed copy inside the user's own Wine prefix (dropping the reserved name, as the
  OFL requires of modified versions) so WPF can resolve the `Segoe UI` family — see
  `docs/wine-bug-dwrite-u002d/`. The renamed derivative is generated on-device and never
  redistributed.

Full license texts ship with this distribution under `licenses/` (carried inside the `.dmg`),
so this notice is complete without a network round-trip:

- **GPL-2.0** — `licenses/GPL-2.0.txt` (GPL-2.0-or-later components in p7zip and `msiinfo`).
- **GPL-3.0** — `licenses/GPL-3.0.txt` (icoutils).
- **LGPL-2.1** — `licenses/LGPL-2.1.txt` (Wine, p7zip, libmsi, GLib/GIO/GObject/GModule,
  libgsf, libintl).
- **MIT** — `licenses/MIT-dotnet.txt` (the .NET runtime *source* license; the bundled binaries are
  additionally covered by Microsoft's .NET Library License, carried as `LICENSE.TXT` inside each
  runtime installer).
- **PNG Reference Library / libpng** — `licenses/libpng-LICENSE.txt` (libpng16).
- **PCRE2** — `licenses/PCRE2-LICENCE.md` (PCRE2 runtime library).

> None of this is legal advice.
