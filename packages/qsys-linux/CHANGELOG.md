# Changelog

## [Unreleased]

### Fixed

- Closing the design opened first no longer ends the other open designs. Designer opens each
  design in its own process, and `launch` stopped Wine as soon as its own design closed, so the
  others ended with no save prompt and lost unsaved work. Wine now stops after the last design
  closes.
- `qsys-linux launch` works while another design is open. Install and remove still refuse.
- `qsys-linux launch <design>` with a missing file now says `Design file not found` and names the
  path, in place of a raw system error. It still exits 1.

## [0.1.0] - 2026-11-02

- Initial Ubuntu 26.04 x86-64 installer and launcher for Q-SYS Designer 10.5.1.
- Checksum-pinned Wine 11.20 and Windows .NET 10.0.14, installed per-user without sudo.
- Provision .NET from verified x64 runtime ZIPs without executing 32-bit installer bootstrappers.
- Desktop launcher, diagnostics, persistent UI scaling, and guarded lifecycle operations.
- The npm package contains the recipe, public helpers, and licensed fonts; the QSC installer is user-supplied.
