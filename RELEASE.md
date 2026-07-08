# Release Process

This repository is a monorepo. GitHub Releases are repo-level, so release tags are
package-scoped.

## Tag Names

- `qsys-qrc-vX.Y.Z` for `packages/qsys-qrc`
- `qsys-cli-vX.Y.Z` for `packages/qsys`
- `qsys-mcp-vX.Y.Z` for `packages/qsys-mcp`
- `qsys-mac-vX.Y.Z` for the npm bootstrapper in `packages/qsys-mac`
- `qsys-mac-installer-vX.Y.Z` for the signed DMG from `packages/qsys-mac-installer`

Use release titles without the `v` prefix, for example `qsys-mcp 0.3.2`.

## GitHub Release Notes

Write release notes as real Markdown files and pass them with `gh release create
--notes-file <file>` or `gh release edit --notes-file <file>`. Do not pass
escaped newline strings through `--notes`; GitHub will save literal `\n` text
instead of rendered Markdown line breaks.

## Npm Packages

This is a **pnpm workspace**. Internal deps use the `workspace:^` protocol, which
**pnpm rewrites to a real version at publish time** — so publish with `pnpm publish`,
**not** `npm publish` (npm cannot resolve `workspace:`). `qsys-mock-core` is
`private` and is never published.

Publish in dependency order (each `--filter` builds via `prepack` and rewrites its
`workspace:^` dep on qsys-qrc):

```sh
pnpm --filter qsys-qrc publish --access public
pnpm --filter qsys-cli publish --access public
pnpm --filter qsys-mcp publish --access public
pnpm --filter qsys-mac publish --access public
```

If npm asks for 2FA, pass the current OTP (and `--no-git-checks` if publishing from a
non-release working state):

```sh
pnpm --filter <package> publish --access public --otp="$OTP"
```

Before publishing:

```sh
pnpm run typecheck
pnpm test
pnpm --filter qsys-qrc pack   # inspect the tarball; confirm workspace:^ became a real range
pnpm --filter qsys-cli pack
pnpm --filter qsys-mcp pack
pnpm --filter qsys-mac pack
```

After publishing, verify:

```sh
npm view qsys-qrc version
npm view qsys-cli version
npm view qsys-mcp version
npm view qsys-mac version
```

Create source-only GitHub Releases for npm packages after npm is live. Attach no
assets; link to the npm package and package directory in the release notes.

## MCP Registry

`qsys-mcp` is registered as `io.github.reowens/qsys-mcp`.

The npm package version and `packages/qsys-mcp/server.json` version must match.
The npm package must also include:

```json
"mcpName": "io.github.reowens/qsys-mcp"
```

After publishing `qsys-mcp` to npm, run the manual GitHub Actions workflow:

```sh
gh workflow run "Publish qsys-mcp to MCP Registry" --repo reowens/qsys-tools --ref main
```

Verify the registry entry:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.reowens/qsys-mcp"
```

## qsys-mac npm bootstrapper

`qsys-mac` is an npm package that downloads and verifies the signed
`qsys-mac-installer` DMG, mounts it, runs the bundled `qsys-mac` helper, and
detaches the DMG. It does not contain the app payload.

Before publishing `qsys-mac`:

- Build, notarize, staple, and upload the matching `qsys-mac-installer` DMG.
- Update `packages/qsys-mac/src/index.ts` so `DEFAULT_RELEASE` points at the
  final `qsys-mac-installer-vX.Y.Z/qsys-mac-installer.dmg` URL.
- Replace `DEFAULT_RELEASE.sha256` with the exact uploaded DMG SHA-256.
- Run `pnpm --filter qsys-mac pack` and inspect the tarball contents.
- Confirm `npx qsys-mac --dmg packages/qsys-mac-installer/dist/qsys-mac-installer.dmg status`
  mounts the local DMG, delegates to the bundled helper, and detaches cleanly.

Create a source-only GitHub Release for `qsys-mac-vX.Y.Z` after npm is live.
Attach no assets; link to the npm package, the package directory, and the
installer release it bootstraps.

## qsys-mac-installer

`qsys-mac-installer` is the native macOS app/DMG distribution.

### Bundled msiinfo Checklist

The installer bundles `msiinfo` so first-run setup no longer requires users to
install Homebrew `msitools`. When updating this bundle:

- Run `packages/qsys-mac-installer/scripts/bundle-deps.sh` on Apple Silicon.
- Confirm `app/Resources/bin/msiinfo --version` works.
- Confirm every non-system `msiinfo`/dylib load path is rewritten to `@loader_path`.
- Confirm `packages/qsys-mac-installer/THIRD-PARTY-NOTICES.md` lists `msiinfo`,
  `libmsi`, GLib/GIO/GObject/GModule, libgsf, libintl, and PCRE2.
- Confirm `packages/qsys-mac-installer/licenses/` carries required full license texts.
- Run a clean install using the packaged helper with `Resources/bin` first in `PATH`
  and no `QSYS_USE_PYTHON_HELPERS`, then verify the MSI assembly reports all `.luax`
  component definitions.
- If changing the native MSI assembler, run
  `packages/qsys-mac-installer/scripts/compare-assemble-msi.sh <installer.exe>` and
  verify its manifest comparison passes.
- If changing the native font renamer, run
  `packages/qsys-mac-installer/scripts/compare-rename-font-family.sh` and verify all
  bundled Selawik outputs match the Python helper.

Before building the DMG:

- Update both bundle plists in `packages/qsys-mac-installer/app/`.
- Update generated plist version text in `packages/qsys-mac-installer/lib/recipe.sh`.
- Ensure the shipped headless helper is `qsys-mac`.

Build and notarize from `packages/qsys-mac-installer`:

```sh
DEV_ID="Developer ID Application: Robert Owens (7GSPYYN5X8)" \
  NOTARY_PROFILE=qsys-notary \
  scripts/package.sh 2>&1 | tee dist/package-rebuild.log
```

Validate the artifact:

```sh
shasum -a 256 "dist/qsys-mac-installer.dmg"
xcrun stapler validate "dist/qsys-mac-installer.dmg"
spctl -a -t open --context context:primary-signature -vv "dist/qsys-mac-installer.dmg"
codesign -dv --verbose=4 "dist/qsys-mac-installer.dmg"
```

Mount the DMG read-only and verify:

- `Q-SYS Mac Installer.app` is present.
- `LICENSE`, `THIRD-PARTY-NOTICES.md`, and `licenses/` are present.
- `Contents/Resources/qsys-mac` exists and is executable.
- `Contents/Resources/bin/msiinfo`, `qsys-assemble-msi`, and
  `qsys-rename-font-family` exist and are executable.
- No `qsys-designer-mac` helper remains.
- Installer and embedded launcher bundle versions match the release version.
- `codesign --verify --deep --strict` and `spctl` pass for the app.

End-to-end smoke after release publishing:

- Install via Homebrew from `reowens/qsys/qsys-mac-installer`, then verify the app version,
  signature, stapled ticket, bundled helpers, and `qsys-mac status`.
- Uninstall/zap the Homebrew cask, install from the signed DMG, and verify Homebrew no longer
  tracks the app.
- Run a clean temp provision from the installed app resources with no `QSYS_USE_PYTHON_HELPERS`
  and with `PYTHONHOME` set to a bogus path.
- Launch the existing `/Applications/Q-SYS Designer.app` and confirm the main window appears.

Create the `qsys-mac-installer-vX.Y.Z` GitHub Release with the DMG asset attached.

After publishing a new installer DMG, update the external Homebrew tap at
`reowens/homebrew-qsys`:

```sh
brew tap reowens/qsys
brew trust reowens/qsys
brew audit --cask --online reowens/qsys/qsys-mac-installer
brew install --cask qsys-mac-installer
brew uninstall --cask qsys-mac-installer
```

## Old Repositories

The canonical repository is `reowens/qsys-tools`.

The old standalone `reowens/qsys-mcp` repository should remain archived rather
than deleted because historical changelog links still point at it.
