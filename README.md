# Project Skills for Paseo

Project Skills is a standalone Paseo plugin for selecting and installing project skills with user approval. Choose a directory on a Paseo host, scan for project fit, and select skills and target providers for a later installation review.

## Foundation

- The client entry registers the **Project Skills** screen and sidebar item. The screen lists project roots and workspaces through the Paseo SDK, accepts an absolute path, and keeps selections scoped to the active host and target.
- Shared Zod contracts define the connection check, directory validation and catalog settings. The server entry runs on the daemon host and validates directories with `realpath`, `stat` and `access`.
- The canonical directory becomes the `cwd` for provider discovery. Provider availability reflects what Paseo can discover on that host. Agent Skills support and read-only execution require separate verification.
- Paseo stores catalog settings per host installation. SLP and Kanbanly are independent of this plugin.

## Development and local installation

The SDK remains pinned to **0.17.4**. Use Paseo Desktop and daemon **0.17.5** for the Scan UI smoke test. Use Node.js **22.15 or later** for the test runner and its module hooks. On macOS, use the CLI packaged with Desktop and adjust the app location if needed.

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

Project-Skills is the single source of skill templates. The host setting starts empty. Enter a tag name or a full 40-character commit SHA. A bare name is treated as a tag candidate. Catalog resolution must use the tag namespace or an explicit SHA, with no fallback to branches, `main` or a floating latest revision. Saving settings validates syntax. On demand, the daemon-side `catalog.load` RPC reads the active host’s saved revision and returns the resolved commit SHA, skill metadata and file descriptors. It discovers `skills/<name>/SKILL.md` in the pinned Git tree and rejects a malformed catalog as a whole. The existing screen saves the revision. The screen loads catalog descriptors when you request a scan. [Project-Skills repository](https://github.com/anmeo2204/project-skills)

The loader requires Git on the daemon host and non-interactive SSH read access to `git@github.com:anmeo2204/project-skills.git` with its host key already trusted. It uses the host SSH identity or agent, an isolated temporary bare repo, and an in-memory cache of two resolved snapshots. For a runtime check, use the Paseo SDK settings RPC to save a known SHA, call `catalog.load` with `{}` twice, compare commit, IDs and descriptors, try an unavailable revision and restore the saved ref.

The plugin validates existing directories without creating workspaces or writing target files. Native folder picking and application remain outside the current milestone. The canonical skill location is `.agents/skills/`.

## Project evidence

The daemon-side `target.scan` subscription accepts a request ID and the canonical directory returned by `target.validate-directory` for the active host. Revalidation happens on the daemon. Each connected request emits one result. Release the subscription on receipt, target change, or unmount. Treat the request ID as part of the selection identity even when returning to the same path.

The scanner reads bounded metadata and collects relative evidence references, application and workspace boundaries, technology declarations and inferences, and existing project skill/rule paths. Partial results carry warnings and coverage limits. It does not need a catalog ref or provider. M2.2 exposes this subscription for SDK use.

The scanner is intended for local projects managed by the user. It excludes dependency trees, secret files, symlinks and special files, and never runs project commands. Node pathname checks can detect the tested replacement races, but do not provide an adversarial filesystem sandbox. See [the completion report](M2.2-completion-report.md) for the evidence policy and runtime checks.

## Deterministic recommendations

Subscribe to `recommendation.evaluate` with a `requestId` and the validated `canonicalDirectory`. Pass `expectedCatalogSha` and `expectedSettingsRevision` when continuing from a previously loaded catalog. The daemon resolves the host's saved catalog ref once, scans the target again, and emits a single `ready`, `partial`, or typed `error` event. Release the subscription on receipt or when the host or target selection changes.

The engine reads `applicability.json` beside each skill's `SKILL.md` at the resolved commit. It evaluates project scope and scanner-assigned boundaries, returns evidence references for matches, and lists observed skill installations independently. Partial scans can still produce positive matches. Older catalog revisions load normally and report `unknown` for skills without a sidecar. Invalid or unsupported sidecars produce skill-level diagnostics. Task applicability is always `not_assessed`.

Run `npm run typecheck` and `npm test` for the contract, scanner, engine, and subscription fixtures. Remote acceptance of the migrated catalog requires a published revision containing the sidecars. See the [applicability contract](M2.4-applicability-contract.md).

## Scan & Recommend in Desktop

Open **Project Skills**, choose a project or enter a host path, then save a catalog tag or SHA. Target Providers are optional installation destinations. Choose **Scan & Recommend** to review the pinned result. Open a skill’s details for boundary evidence and existing installations. Open **Unknown** to review skills with insufficient evidence or missing rules.

Select skills manually or use **Select Recommended**. **Clear Selection** preserves provider choices. Rescanning or changing the target or saved catalog discards the previous skill selection. Select **Preview Changes** to review proposed files for the current intent. The screen does not write files.

## Canonical Preview Planner

M3.2 exposes the typed daemon RPC `preview.canonical`. Its input is the existing `SelectionIntentV1`, now runtime-validated in `shared/selection-intent.ts`. The daemon checks the intent's host ID against `paseo.hosts.list().self.serverId`, revalidates the canonical target, checks the saved settings revision, resolves the saved catalog ref and requires the resolved source/SHA to match the intent. Every selected Skill ID must belong to that snapshot. An empty provider selection is valid. The recommendation request ID is a correlation field, not a stored scan receipt or permission to write.

The planner inspects current destinations under **the selected target's** `.agents/skills/<id>/`, including `SKILL.md` and every supporting file. It returns stable path ordering and `create`, `unchanged`, `conflict` or `blocked` per file. Both bytes and POSIX permission bits must match for `unchanged`; proposed modes are `0644` or `0755` from Git mode. Unrelated existing files are preserved and no deletions are planned. Legacy catalogs work without applicability metadata, and sidecars are planned as ordinary package files.

Changed UTF-8 text receives a unified diff with three lines of context around one contiguous change hunk. Mode-only changes have mode headers. Binary changes carry before/after byte size, SHA-256 and mode, without raw binary bytes. Unsafe paths, symlinks, hardlinks, special files, child mounts, unreadable files and observed replacements block affected entries. The planner shares filesystem identity/path guards with the scanner, while using a separate reader for complete package destinations; scanner metadata allowlists remain unchanged.

Limits: 2,048 files, 1,024 bytes/32 segments per destination, 1 MiB per existing file, 8 MiB total destination reads, 32,768 filesystem `lstat` checks, 128 KiB per text diff, and 1 MiB for the complete JSON response. Files exceeding read/diff budgets are `blocked`; complete-plan or response-budget failures return `limit_exceeded` without truncating a plan. The filesystem phase has an 8-second cooperative deadline; catalog loading retains its separate 20-second limit. One preview runs per installation. Plugin disposal cancels the active preview and waits for its work to settle.

Preview rechecks observed destinations after the final settings read. It describes current filesystem observations, not an atomic snapshot: same-path directory replacement before the request cannot be compared with a prior scan because the intent has no inode receipt. As with the scanner, Node pathname guards are intended for local-first projects, not an adversarial filesystem sandbox. Safe Apply must revalidate independently. This endpoint does not call agents/models or write target files. See [the M3.2 completion report](M3.2-completion-report.md).

## Provider Adapter Preview

M3.3 adds **`preview.providers`** with the same validated `SelectionIntentV1` input. `preview.canonical` keeps its strict M3.2 wire contract and canonical-only behavior, even when provider IDs are selected. The new response retains canonical `entries` and adds `providers`, `derivedEntries` and `diagnostics`. Both endpoints share one active-preview slot, disposal, CatalogLoader, destination reader, fingerprint/diff logic and budgets. Limits apply to the combined canonical and derived work and the complete response; no truncated plan is returned.

Codex, Cursor ACP and Antigravity are `canonical_only`, with zero extra files. Provider status records **historical M3.1 verification**, not a new binary/version/session attestation: Codex 0.167.0 in `auto` with read-only options; Cursor 2026.10.22-27dcf5f through `cursor-agent acp` in `ask`; Antigravity 1.5.18 through its ACP connector in `plan`. Root/nested coverage is recorded, including Antigravity's existing permission flow for reading canonical skills at an ancestor. Preview does not discover models, start agents, alter permissions, or change session CWD/provider configuration.

Kiro proposes a complete derived copy at `.kiro/skills/<id>/` only when the **selected target itself** has safe `.git` metadata and a bounded local `git rev-parse` confirms it as the work-tree root. A directory marker alone is insufficient; linked worktree gitfiles are supported. Git probes are read-only, have a 2-second timeout/16 KiB output cap each, and disable optional locks, hooks, fsmonitor and inherited/global configuration overrides. Root proof is rechecked before publish. Nested workspaces, non-Git directories, unsafe markers or unavailable Git retain canonical preview with `limited` Kiro status and no derived entries. The historical Kiro 2.34.2 evidence covers `kiro_default` with session CWD at root; the planner does not move a session to meet that condition.

Derived entries use the exact canonical package bytes/modes, including supporting files, and carry `providerId` plus `canonicalDestination` lineage. If any canonical file of a skill is `conflict` or `blocked`, its entire Kiro package is `deferred` with diagnostics, while unaffected skills can still plan. Late canonical changes withdraw affected derived packages. Existing Kiro destinations are compared directly with `create/unchanged/conflict/blocked` semantics. Kiro status is `ready` for a generated plan without destination issues, `partial` for a mixed/degraded plan, `deferred` when all selected skills are held, or `limited` when root compatibility is unconfirmed; none of these statuses authorizes Apply.

Duplicate diagnostics inspect only selected directory IDs at target-root `.agents/skills/`, `.cursor/skills/` and `.kiro/skills/`. `duplicate_skill_id` carries `basis: directory_id` and observed paths; these are candidate copies, not proof of matching frontmatter, provenance, activation or precedence. Unsafe/changed observations report `inventory_unverified`. No provider-home or exhaustive recursive inventory is claimed. See [M3.1 evidence](M3.1-completion-report.md) and [the M3.3 completion report](M3.3-completion-report.md).

## Preview Changes in Desktop

After scanning and selecting at least one skill, choose **Preview Changes**. Providers are optional. Each click makes one `preview.providers` request using the current `SelectionIntentV1`. Review the target, pinned catalog SHA, canonical files and any Kiro derived files. Each file shows Create, Unchanged, Conflict or Blocked; open its details for the text diff or before/after size, SHA-256 and permission mode. When every planned file matches, the screen explicitly reports no file changes.

Kiro compatibility explains root requirements and package deferral. Canonical-only providers show zero additional files. Expand **M3.1 historical verification** for version, mode and CWD evidence; this does not verify the current provider session. Duplicate diagnostics show observed paths and leave precedence/activation unverified.

Rescanning, changing host/target/saved settings or skill/provider selection discards the previous preview. Selection generations also invalidate A → B → A changes, including batched updates. Offline or missing hosts clear the current intent. Saving catalog settings temporarily disables Preview. Responses are checked against the request's full intent and obsolete replies are ignored; reconnect never retries automatically.

**Cancel Preview** stops waiting on the UI and ignores late replies. The SDK RPC cannot be cancelled through this control, so the daemon may still finish and a quick retry can return Busy. Retry explicitly in the current scope. There is no Apply action, target write, model call or provider execution in Preview. See [the M3.4 completion report](M3.4-completion-report.md).

M4.2 adds the separate read-only **`preview.providers.v2`** RPC, accepting `{ intent, viewNonce }`. Its strict versioned response contains an immutable-plan manifest and daemon-retained receipt. The manifest binds the M3 provider projection, pinned source fingerprints, proposed directory effects, exact bigint filesystem observations, Git/worktree proof, installation-instance/epoch scope and policy/budgets. The M3 endpoints and UI keep their existing contracts.

Receipts expire after 10 minutes using the daemon's monotonic clock. The installation retains at most 8 receipts and 32 MiB of source bytes, with an 8 MiB combined canonical/derived source limit per receipt; oldest receipts are evicted first. No source bytes travel in the response. On the main `paseo-project-skills` installation, all v2 responses explicitly report **write capability unavailable** and **Apply ineligible**, including no-op plans; there is no Apply/status RPC or Apply button on the main daemon. Receipt integrity/lifetime checks do not replace filesystem/settings/catalog revalidation. See [the M4.2 report](M4.2-completion-report.md) for runtime-spike findings.

## Safe Apply — Single-Project Pilot

The limited **Single-Project Safe Apply Pilot** (`paseo-project-skills-single-project-pilot`) has passed acceptance on an isolated Paseo Desktop profile and daemon (**PASS 10/10** on `giz` for `debug-regression` + `Codex`, macOS arm64, local APFS case-insensitive, Paseo 0.17.5 / SDK 0.17.4).

- **Main daemon remains Preview-only:** The default `paseo-project-skills` plugin (`index.server.ts` / `index.client.tsx`) does not expose `apply.*` RPCs or mutate target files.
- **Pilot isolation & opt-in:** The pilot candidate (`release/single-project-pilot/`) runs in a separate daemon home with opt-in **OFF** by default, binds exactly one canonical project root via native `--enroll-root` (`scripts/enroll-single-project-pilot.mjs`), and enforces create-only / no-clobber writes with durable admission, `fsync` completion, and read-only `apply.status.v1` recovery even after opt-in is disabled.
- **Evidence & next phase:** See [the pilot design](docs/safe-apply-pilot/SAFE-APPLY-single-project-pilot-design.md), [isolated copy acceptance](docs/safe-apply-pilot/SAFE-APPLY-single-project-pilot-acceptance-report.md), [giz final acceptance (PASS 10/10)](docs/safe-apply-pilot/SAFE-APPLY-giz-final-acceptance-report.md), and [Production Readiness Analysis](docs/safe-apply-pilot/SAFE-APPLY-production-readiness-report.md).

## Optional AI capability

M2.3 provides a server-side structured agent executor through the public Paseo SDK. It ships with no verified execution profiles, so provider availability alone cannot start a run. The executor is internal to the plugin and will be connected to the optional AI-assisted recommendation flow separately. Catalog and project evidence remain available independently. See [the M2.3 completion report](M2.3-completion-report.md) for the local preflight and provider limitations.

## Roadmap & Milestone Status

| Milestone | Scope | Status |
| --- | --- | --- |
| **M1 — Foundation** | Plugin shell, directory validation, host/workspace selection, catalog settings | **Completed** |
| **M2 — Read-only scan & recommendation** | Pinned Git catalog loader, bounded project scanner, deterministic recommendation engine, Scan UI | **Completed** |
| **M3 — Preview & provider adapters** | Canonical preview planner, provider adapters (Codex, Cursor ACP, Antigravity `canonical_only`; Kiro `.kiro/skills/` derived), Preview UI | **Completed** |
| **M4 — Safe Apply (Pilot)** | Immutable preview receipts (`v2`), native anchored create-only writer, durable journal, single-project enrollment pilot on isolated daemon | **Pilot Completed (PASS 10/10)** |
| **M4.P1 — Multi-Root Policy, Version Compat & Multi-Skill/Kiro Acceptance** | Multi-root allowlist (`enrollments.json`), per-target approval receipts, semver/trust-boundary compatibility policy, AT-1/2/3/5 & 4-provider live discovery on isolated copies | **Completed (PASS)** |
| **M4.P2 — Main Plugin Integration & Production Release Gate** | Direct Scan → Recommend → Select → Preview → Approve → Apply on main plugin (`~/.paseo`, Preview-only for unenrolled roots, Relay fail-closed) | **Pending Approval** |
| **M5 — SLP integration pilot** | Validate optional integration while keeping the standalone plugin usable | **Planned** |

[Paseo 0.17.4 plugin guide](https://github.com/getpaseo/paseo/blob/v0.17.4/docs/plugins.md)
