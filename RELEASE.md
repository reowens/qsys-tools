# Release Process

This repository is a monorepo. GitHub Releases are repo-level, so release tags are
package-scoped.

## Tag Names

- `qsys-qrc-vX.Y.Z` for `packages/qsys-qrc`
- `qsys-cli-vX.Y.Z` for `packages/qsys`
- `qsys-mcp-vX.Y.Z` for `packages/qsys-mcp`
- `qsys-mac-vX.Y.Z` for `packages/qsys-mac`

Use release titles without the `v` prefix, for example `qsys-mcp 0.3.2`.

## Npm Packages

Publish npm packages in dependency order:

```sh
npm publish --workspace=qsys-qrc --access public
npm publish --workspace=qsys-cli --access public
npm publish --workspace=qsys-mcp --access public
```

If npm asks for 2FA, pass the current OTP:

```sh
npm publish --workspace=qsys-mcp --access public --otp="$OTP"
```

Before publishing:

```sh
npm run typecheck
npm test
npm pack --workspace=qsys-qrc --dry-run --json
npm pack --workspace=qsys-cli --dry-run --json
npm pack --workspace=qsys-mcp --dry-run --json
```

After publishing, verify:

```sh
npm view qsys-qrc version
npm view qsys-cli version
npm view qsys-mcp version
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

## qsys-mac

`qsys-mac` is a native macOS app distribution, not an npm package.

Before building the DMG:

- Update both bundle plists in `packages/qsys-mac/app/`.
- Update generated plist version text in `packages/qsys-mac/lib/recipe.sh`.
- Ensure the shipped headless helper is `qsys-mac`.

Build and notarize from `packages/qsys-mac`:

```sh
DEV_ID="Developer ID Application: Robert Owens (7GSPYYN5X8)" \
  NOTARY_PROFILE=qsys-notary \
  scripts/package.sh 2>&1 | tee dist/package-rebuild.log
```

Validate the artifact:

```sh
shasum -a 256 "dist/Install Q-SYS Designer.dmg"
xcrun stapler validate "dist/Install Q-SYS Designer.dmg"
spctl -a -t open --context context:primary-signature -vv "dist/Install Q-SYS Designer.dmg"
codesign -dv --verbose=4 "dist/Install Q-SYS Designer.dmg"
```

Mount the DMG read-only and verify:

- `Install Q-SYS Designer.app` is present.
- `LICENSE`, `THIRD-PARTY-NOTICES.md`, and `licenses/` are present.
- `Contents/Resources/qsys-mac` exists and is executable.
- No `qsys-designer-mac` helper remains.
- Installer and embedded launcher bundle versions match the release version.
- `codesign --verify --deep --strict` and `spctl` pass for the app.

Create the GitHub Release with the DMG asset attached.

## Old Repositories

The canonical repository is `reowens/qsys-tools`.

The old standalone `reowens/qsys-mcp` repository should remain archived rather
than deleted because historical changelog links still point at it.
