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

## Npm Packages

Publish npm packages in dependency order:

```sh
npm publish --workspace=qsys-qrc --access public
npm publish --workspace=qsys-cli --access public
npm publish --workspace=qsys-mcp --access public
npm publish --workspace=qsys-mac --access public
```

If npm asks for 2FA, pass the current OTP:

```sh
npm publish --workspace=<package> --access public --otp="$OTP"
```

Before publishing:

```sh
npm run typecheck
npm test
npm pack --workspace=qsys-qrc --dry-run --json
npm pack --workspace=qsys-cli --dry-run --json
npm pack --workspace=qsys-mcp --dry-run --json
npm pack --workspace=qsys-mac --dry-run --json
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
- Run `npm pack --workspace=qsys-mac --dry-run --json` and inspect the tarball contents.
- Confirm `npx qsys-mac --dmg packages/qsys-mac-installer/dist/qsys-mac-installer.dmg status`
  mounts the local DMG, delegates to the bundled helper, and detaches cleanly.

Create a source-only GitHub Release for `qsys-mac-vX.Y.Z` after npm is live.
Attach no assets; link to the npm package, the package directory, and the
installer release it bootstraps.

## qsys-mac-installer

`qsys-mac-installer` is the native macOS app/DMG distribution.

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
- No `qsys-designer-mac` helper remains.
- Installer and embedded launcher bundle versions match the release version.
- `codesign --verify --deep --strict` and `spctl` pass for the app.

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
