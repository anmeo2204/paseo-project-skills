# Project Skills for Paseo

Project Skills is a standalone Paseo plugin for selecting and installing project skills with user approval. The current Foundation release lets you choose a directory on a Paseo host, discover providers for that directory, and save the catalog revision for future use.

## Foundation

- The client entry registers the **Project Skills** screen and sidebar item. The screen lists project roots and workspaces through the Paseo SDK, accepts an absolute path, and keeps selections scoped to the active host and target.
- Shared Zod contracts define the connection check, directory validation and catalog settings. The server entry runs on the daemon host and validates directories with `realpath`, `stat` and `access`.
- The canonical directory becomes the `cwd` for provider discovery. Provider availability reflects what Paseo can discover on that host. Agent Skills support and read-only execution require separate verification.
- Paseo stores catalog settings per host installation. SLP and Kanbanly are independent of this plugin.

## Development and local installation

Use Paseo Desktop and daemon **0.17.4** for the verified baseline. Use Node.js **22.15 or later** for the test runner and its module hooks. On macOS, use the CLI packaged with Desktop and adjust the app location if needed.

From the repository root:

```sh
PASEO_DESKTOP="/Applications/Paseo.app/Contents/Resources/bin/paseo"
"$PASEO_DESKTOP" --version
"$PASEO_DESKTOP" status
npm ci
npm run typecheck
npm test
"$PASEO_DESKTOP" plugin install "$PWD"
"$PASEO_DESKTOP" plugin ls paseo-project-skills
```

Directory installation registers your checkout as trusted plugin code. Paseo compiles and runs the entrypoints. For a smoke test, open **Project Skills**, choose a project root and a workspace, check the canonical directory and provider states, then select **Check connection**. Save a temporary catalog revision and reload to verify persistence, then restore the previous revision.

`npm test` runs Node's built-in test runner. It uses temporary directories for filesystem assertions and a React renderer for the production screen with mocked Paseo host data and transport. The permission fixture requires a non-root POSIX user. Tests do not require a daemon.

## Reload and troubleshooting

```sh
"$PASEO_DESKTOP" plugin reload paseo-project-skills
"$PASEO_DESKTOP" plugin logs paseo-project-skills
```

- If the plugin fails to load, check the installed CLI and daemon versions, inspect plugin logs, fix the issue and reload this installation.
- If the sidebar item is missing, verify the plugin is enabled and running on the active host and check Paseo's sidebar settings.
- If validation or discovery fails, verify the host is connected and that the daemon can access the absolute directory. **Check connection** verifies the plugin RPC independently.
- Use `plugin disable paseo-project-skills` and `plugin enable paseo-project-skills` with the bundled CLI to verify sidebar cleanup and restoration.

## Catalog and scope

Project-Skills is the single source of skill templates. The host setting starts empty. Enter a tag name or a full 40-character commit SHA. A bare name is treated as a tag candidate. Catalog resolution must use the tag namespace or an explicit SHA, with no fallback to branches, `main` or a floating latest revision. Saving settings validates syntax. On demand, the daemon-side `catalog.load` RPC reads the active host’s saved revision and returns the resolved commit SHA, skill metadata and file descriptors. It discovers `skills/<name>/SKILL.md` in the pinned Git tree and rejects a malformed catalog as a whole. The existing screen saves the revision. Loading is exercised through the RPC. [Project-Skills repository](https://github.com/anmeo2204/project-skills)

The loader requires Git on the daemon host and non-interactive SSH read access to `git@github.com:anmeo2204/project-skills.git` with its host key already trusted. It uses the host SSH identity or agent, an isolated temporary bare repo, and an in-memory cache of two resolved snapshots. For a runtime check, use the Paseo SDK settings RPC to save a known SHA, call `catalog.load` with `{}` twice, compare commit, IDs and descriptors, try an unavailable revision and restore the saved ref.

The plugin validates existing directories without creating workspaces or writing target files. Native folder picking, agent sessions, previews and application remain outside the current milestone. The intended canonical skill location is `.agents/skills/`.

## Project evidence

The daemon-side `target.scan` subscription accepts a request ID and the canonical directory returned by `target.validate-directory` for the active host. Revalidation happens on the daemon. Each connected request emits one result. Release the subscription on receipt, target change, or unmount. Treat the request ID as part of the selection identity even when returning to the same path.

The scanner reads bounded metadata and collects relative evidence references, application and workspace boundaries, technology declarations and inferences, and existing project skill/rule paths. Partial results carry warnings and coverage limits. It does not need a catalog ref or provider. M2.2 exposes the subscription for SDK use. The scan UI is planned for M2.5.

The scanner is intended for local projects managed by the user. It excludes dependency trees, secret files, symlinks and special files, and never runs project commands. Node pathname checks can detect the tested replacement races, but do not provide an adversarial filesystem sandbox. See [the completion report](M2.2-completion-report.md) for the evidence policy and runtime checks.

## Deterministic recommendations

Subscribe to `recommendation.evaluate` with a `requestId` and the validated `canonicalDirectory`. Pass `expectedCatalogSha` and `expectedSettingsRevision` when continuing from a previously loaded catalog. The daemon resolves the host's saved catalog ref once, scans the target again, and emits a single `ready`, `partial`, or typed `error` event. Release the subscription on receipt or when the host or target selection changes.

The engine reads `applicability.json` beside each skill's `SKILL.md` at the resolved commit. It evaluates project scope and scanner-assigned boundaries, returns evidence references for matches, and lists observed skill installations independently. Partial scans can still produce positive matches. Older catalog revisions load normally and report `unknown` for skills without a sidecar. Invalid or unsupported sidecars produce skill-level diagnostics. Task applicability is always `not_assessed`.

Run `npm run typecheck` and `npm test` for the contract, scanner, engine, and subscription fixtures. Remote acceptance of the migrated catalog requires a published revision containing the sidecars. See the [applicability contract](M2.4-applicability-contract.md).

## Optional AI capability

M2.3 provides a server-side structured agent executor through the public Paseo SDK. It ships with no verified execution profiles, so provider availability alone cannot start a run. The executor is internal to the plugin and will be connected to the optional AI-assisted recommendation flow separately. Catalog and project evidence remain available independently. See [the M2.3 completion report](M2.3-completion-report.md) for the local preflight and provider limitations.

## Roadmap

- **M2 — Read-only scan and recommendation.** Resolve the catalog to a commit SHA, then read it and recommend skills.
- **M3 — Preview and provider adapters.** Compute and show proposed changes. Generate provider-specific rules or derived skills where required.
- **M4 — Safe apply.** Write the approved diff to the target project.
- **M5 — SLP integration pilot.** Validate optional integration while keeping the standalone plugin usable.

[Paseo 0.17.4 plugin guide](https://github.com/getpaseo/paseo/blob/v0.17.4/docs/plugins.md)
