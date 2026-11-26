# Project Skills for Paseo

Open **Project Skills** to choose a target project or workspace, or enter an absolute directory path on the current Paseo host. The plugin validates the directory on that host and uses the canonical path for provider discovery. Select any of the providers shown as ready. The Skill Catalog section saves a tag name or full commit SHA on the host for future use. An empty value leaves the revision unset.

## Development and local installation

Use Paseo Desktop and its daemon at version 0.17.4. On macOS, point to the CLI inside the Desktop app bundle. Adjust the app location if it was installed elsewhere.

```sh
PASEO_DESKTOP="/Applications/Paseo.app/Contents/Resources/bin/paseo"
"$PASEO_DESKTOP" --version
npm ci
npm run typecheck
"$PASEO_DESKTOP" plugin install "$PWD"
"$PASEO_DESKTOP" plugin ls paseo-project-skills
```

Run these commands from the checkout root. Installing from this directory registers the checkout as trusted plugin code on the local daemon. Paseo compiles both TypeScript entrypoints. Open **Project Skills** in the sidebar and select **Check connection**. A successful call displays **Connected to the plugin server.**

## Reload and lifecycle

```sh
npm run typecheck
"$PASEO_DESKTOP" plugin reload paseo-project-skills
"$PASEO_DESKTOP" plugin logs paseo-project-skills
```

Use `plugin disable paseo-project-skills` and `plugin enable paseo-project-skills` with the same CLI to exercise teardown and startup. Disable removes the sidebar item. Enable restores it. The daemon can stay running throughout development.

## Troubleshooting

- **CLI or daemon version mismatch.** Use the bundled CLI above. Compare its `--version` with the daemon version reported by `"$PASEO_DESKTOP" status`.
- **Plugin is missing or failed to load.** Check its state with `plugin ls paseo-project-skills` and inspect `plugin logs paseo-project-skills` for compilation or startup errors. Fix the error, then reload this plugin.
- **Sidebar item is missing.** Verify the installation is enabled and running on the host shown in Desktop. Check Paseo's sidebar settings if the item is hidden.
- **Connection check failed.** Verify the host is connected and the plugin is running, inspect the plugin logs, then select **Check connection** again.

RPC contracts live in `shared/rpc.ts`. The server entrypoint registers the connection check, directory validation and catalog settings. The screen lives in `client/foundation-screen.tsx`. Keep shared code independent of the client and server runtimes. [Paseo 0.17.4 plugin guide](https://github.com/getpaseo/paseo/blob/v0.17.4/docs/plugins.md)
