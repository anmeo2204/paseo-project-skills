# Project Skills for Paseo

Project Skills is a standalone Paseo plugin for selecting and installing project skills with user approval. Choose a directory on a Paseo host, scan for project fit, and select skills and target providers for a later installation review.

## Foundation

- The client entry registers the **Project Skills** screen and sidebar item. The screen lists project roots and workspaces through the Paseo SDK, accepts an absolute path, and keeps selections scoped to the active host and target.
- Shared Zod contracts define the connection check, directory validation and catalog settings. The server entry runs on the daemon host and validates directories with `realpath`, `stat` and `access`.
- The canonical directory becomes the `cwd` for provider discovery. Provider availability reflects what Paseo can discover on that host. Agent Skills support and read-only execution require separate verification.
- Paseo stores catalog settings per host installation. SLP and Kanbanly are independent of this plugin.

## Development and local installation

The SDK remains pinned to **0.17.4** and is verified at build time via `server/native/sdk-manifest-payload.ts` (derived from `package.json`, `package-lock.json`, installed `node_modules/@getpaseo/*/package.json`, and bound to `paseo-plugin.json`, `native/anchored-writer.m`, and `server/native/writer-payload.ts`). Compatibility policy supports Paseo CLI/daemon **0.17.5–0.17.x** and **0.18.0** (runtime-verified on **0.17.5** and **0.18.0**; unverified versions such as `0.18.1+` or `0.19.0+` fail closed to Preview-only). Use Node.js **22.15 or later** for the test runner and its module hooks. On macOS, use the CLI packaged with Desktop and adjust the app location if needed.

From the repository root:

```sh
PASEO_DESKTOP="/Applications/Paseo.app/Contents/Resources/bin/paseo"
"$PASEO_DESKTOP" --version
"$PASEO_DESKTOP" status
npm ci
npm run verify:sdk-manifest
npm run typecheck
npm test
"$PASEO_DESKTOP" plugin install "$PWD"
"$PASEO_DESKTOP" plugin ls paseo-project-skills
```

When rebuilding the native writer (`native/anchored-writer.m`) or updating pinned `@getpaseo/*` dependencies, regenerate both build-time artifacts together:

```sh
npm run build:artifacts
npm run verify:sdk-manifest
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

Directory validation and catalog loading are strictly read-only without creating workspaces or modifying target files. Native folder picking remains outside the current milestone; opt-in create-only skill installation is handled separately via Safe Apply below. The canonical skill location is `.agents/skills/`.

## Project evidence

The daemon-side `target.scan` subscription accepts a request ID and the canonical directory returned by `target.validate-directory` for the active host. Revalidation happens on the daemon. Each connected request emits one result. Release the subscription on receipt, target change, or unmount. Treat the request ID as part of the selection identity even when returning to the same path.

The scanner reads bounded metadata and collects relative evidence references, application and workspace boundaries, technology declarations and inferences, and existing project skill/rule paths. Partial results carry warnings and coverage limits. It does not need a catalog ref or provider. M2.2 exposes this subscription for SDK use.

The scanner is intended for local projects managed by the user. It excludes dependency trees, secret files, symlinks and special files, and never runs project commands. Node pathname checks can detect the tested replacement races, but do not provide an adversarial filesystem sandbox. See [the completion report](docs/reports/M2.2-completion-report.md) for the evidence policy and runtime checks.

## Deterministic recommendations

Subscribe to `recommendation.evaluate` with a `requestId` and the validated `canonicalDirectory`. Pass `expectedCatalogSha` and `expectedSettingsRevision` when continuing from a previously loaded catalog. The daemon resolves the host's saved catalog ref once, scans the target again, and emits a single `ready`, `partial`, or typed `error` event. Release the subscription on receipt or when the host or target selection changes.

The engine reads `applicability.json` beside each skill's `SKILL.md` at the resolved commit. It evaluates project scope and scanner-assigned boundaries, returns evidence references for matches, and lists observed skill installations independently. Partial scans can still produce positive matches. Older catalog revisions load normally and report `unknown` for skills without a sidecar. Invalid or unsupported sidecars produce skill-level diagnostics. Task applicability is always `not_assessed`.

Run `npm run typecheck` and `npm test` for the contract, scanner, engine, and subscription fixtures. Remote acceptance of the migrated catalog requires a published revision containing the sidecars. See the [applicability contract](docs/reports/M2.4-applicability-contract.md).

## Scan & Recommend in Desktop

Open **Project Skills**, choose a project or enter a host path, then save a catalog tag or SHA. Target Providers are optional installation destinations. Choose **Scan & Recommend** to review the pinned result. Open a skill’s details for boundary evidence and existing installations. Open **Unknown** to review skills with insufficient evidence or missing rules.

Select skills manually or use **Select Recommended**. **Clear Selection** preserves provider choices. Rescanning or changing the target or saved catalog discards the previous skill selection. Select **Preview Changes** to review proposed files for the current intent. Scanning, recommending, and previewing never write files; target writes occur only after explicit create-only approval on an enrolled root when Safe Apply is active.

## Canonical Preview Planner

M3.2 exposes the typed daemon RPC `preview.canonical`. Its input is the existing `SelectionIntentV1`, now runtime-validated in `shared/selection-intent.ts`. The daemon checks the intent's host ID against `paseo.hosts.list().self.serverId`, revalidates the canonical target, checks the saved settings revision, resolves the saved catalog ref and requires the resolved source/SHA to match the intent. Every selected Skill ID must belong to that snapshot. An empty provider selection is valid. The recommendation request ID is a correlation field, not a stored scan receipt or permission to write.

The planner inspects current destinations under **the selected target's** `.agents/skills/<id>/`, including `SKILL.md` and every supporting file. It returns stable path ordering and `create`, `unchanged`, `conflict` or `blocked` per file. Both bytes and POSIX permission bits must match for `unchanged`; proposed modes are `0644` or `0755` from Git mode. Unrelated existing files are preserved and no deletions are planned. Legacy catalogs work without applicability metadata, and sidecars are planned as ordinary package files.

Changed UTF-8 text receives a unified diff with three lines of context around one contiguous change hunk. Mode-only changes have mode headers. Binary changes carry before/after byte size, SHA-256 and mode, without raw binary bytes. Unsafe paths, symlinks, hardlinks, special files, child mounts, unreadable files and observed replacements block affected entries. The planner shares filesystem identity/path guards with the scanner, while using a separate reader for complete package destinations; scanner metadata allowlists remain unchanged.

Limits: 2,048 files, 1,024 bytes/32 segments per destination, 1 MiB per existing file, 8 MiB total destination reads, 32,768 filesystem `lstat` checks, 128 KiB per text diff, and 1 MiB for the complete JSON response. Files exceeding read/diff budgets are `blocked`; complete-plan or response-budget failures return `limit_exceeded` without truncating a plan. The filesystem phase has an 8-second cooperative deadline; catalog loading retains its separate 20-second limit. One preview runs per installation. Plugin disposal cancels the active preview and waits for its work to settle.

Preview rechecks observed destinations after the final settings read. It describes current filesystem observations, not an atomic snapshot: same-path directory replacement before the request cannot be compared with a prior scan because the intent has no inode receipt. As with the scanner, Node pathname guards are intended for local-first projects, not an adversarial filesystem sandbox. Safe Apply must revalidate independently. This endpoint does not call agents/models or write target files. See [the M3.2 completion report](docs/reports/M3.2-completion-report.md).

## Provider Adapter Preview

M3.3 adds **`preview.providers`** with the same validated `SelectionIntentV1` input. `preview.canonical` keeps its strict M3.2 wire contract and canonical-only behavior, even when provider IDs are selected. The new response retains canonical `entries` and adds `providers`, `derivedEntries` and `diagnostics`. Both endpoints share one active-preview slot, disposal, CatalogLoader, destination reader, fingerprint/diff logic and budgets. Limits apply to the combined canonical and derived work and the complete response; no truncated plan is returned.

Codex, Cursor ACP and Antigravity are `canonical_only`, with zero extra files. Provider status records **historical M3.1 verification**, not a new binary/version/session attestation: Codex 0.167.0 in `auto` with read-only options; Cursor 2026.10.22-27dcf5f through `cursor-agent acp` in `ask`; Antigravity 1.5.18 through its ACP connector in `plan`. Root/nested coverage is recorded, including Antigravity's existing permission flow for reading canonical skills at an ancestor. Preview does not discover models, start agents, alter permissions, or change session CWD/provider configuration.

Kiro proposes a complete derived copy at `.kiro/skills/<id>/` only when the **selected target itself** has safe `.git` metadata and a bounded local `git rev-parse` confirms it as the work-tree root. A directory marker alone is insufficient; linked worktree gitfiles are supported. Git probes are read-only, have a 2-second timeout/16 KiB output cap each, and disable optional locks, hooks, fsmonitor and inherited/global configuration overrides. Root proof is rechecked before publish. Nested workspaces, non-Git directories, unsafe markers or unavailable Git retain canonical preview with `limited` Kiro status and no derived entries. The historical Kiro 2.34.2 evidence covers `kiro_default` with session CWD at root; the planner does not move a session to meet that condition.

Derived entries use the exact canonical package bytes/modes, including supporting files, and carry `providerId` plus `canonicalDestination` lineage. If any canonical file of a skill is `conflict` or `blocked`, its entire Kiro package is `deferred` with diagnostics, while unaffected skills can still plan. Late canonical changes withdraw affected derived packages. Existing Kiro destinations are compared directly with `create/unchanged/conflict/blocked` semantics. Kiro status is `ready` for a generated plan without destination issues, `partial` for a mixed/degraded plan, `deferred` when all selected skills are held, or `limited` when root compatibility is unconfirmed; none of these statuses authorizes Apply.

Duplicate diagnostics inspect only selected directory IDs at target-root `.agents/skills/`, `.cursor/skills/` and `.kiro/skills/`. `duplicate_skill_id` carries `basis: directory_id` and observed paths; these are candidate copies, not proof of matching frontmatter, provenance, activation or precedence. Unsafe/changed observations report `inventory_unverified`. No provider-home or exhaustive recursive inventory is claimed. See [M3.1 evidence](docs/reports/M3.1-completion-report.md) and [the M3.3 completion report](docs/reports/M3.3-completion-report.md).

## Preview Changes in Desktop

After scanning and selecting at least one skill, choose **Preview Changes**. Providers are optional. Each click makes one `preview.providers.v2` request (while `preview.canonical` and `preview.providers` remain available read-only) using the current `SelectionIntentV1`. Review the target, pinned catalog SHA, canonical files and any Kiro derived files. Each file shows Create, Unchanged, Conflict or Blocked; open its details for the text diff or before/after size, SHA-256 and permission mode. When every planned file matches, the screen explicitly reports no file changes.

Kiro compatibility explains root requirements and package deferral. Canonical-only providers show zero additional files. Expand **M3.1 historical verification** for version, mode and CWD evidence; this does not verify the current provider session. Duplicate diagnostics show observed paths and leave precedence/activation unverified.

Rescanning, changing host/target/saved settings or skill/provider selection discards the previous preview. Selection generations also invalidate A → B → A changes, including batched updates. Offline or missing hosts clear the current intent. Saving catalog settings temporarily disables Preview. Responses are checked against the request's full intent and obsolete replies are ignored; reconnect never retries automatically.

**Cancel Preview** stops waiting on the UI and ignores late replies. The SDK RPC cannot be cancelled through this control, so the daemon may still finish and a quick retry can return Busy. Retry explicitly in the current scope. Preview itself never writes target files, calls models, or executes providers; when host compatibility, trust boundary, and target enrollment all pass, the screen exposes an explicit create-only approval flow after Preview. See [the M3.4 completion report](docs/reports/M3.4-completion-report.md).

M4.2 added the read-only **`preview.providers.v2`** RPC, accepting `{ intent, viewNonce }`. Its strict versioned response contains an immutable-plan manifest and daemon-retained receipt. The manifest binds the M3 provider projection, pinned source fingerprints, proposed directory effects, exact bigint filesystem observations, Git/worktree proof, installation-instance/epoch scope and policy/budgets. The M3 endpoints keep their existing contracts.

Receipts expire after 10 minutes using the daemon's monotonic clock. The installation retains at most 8 receipts and 32 MiB of source bytes, with an 8 MiB combined canonical/derived source limit per receipt; oldest receipts are evicted first. No source bytes travel in the response. Historically, M4.2 shipped Preview-only with no Apply RPC on the main daemon; starting in M4.P2/M4.P3, `preview.providers.v2` on `paseo-project-skills` reports `eligible` (or `no_changes`) only when host compatibility, build-time SDK manifest, local-only trust boundary (Relay OFF), and exact target enrollment all pass, and otherwise fails closed (`ineligible` / `write_capability_unavailable`) in Preview-only mode. Receipt integrity/lifetime checks do not replace filesystem/settings/catalog revalidation. See [the M4.2 report](docs/reports/M4.2-completion-report.md) for runtime-spike findings.

## Safe Apply (Create-Only v1)

Safe Apply enables **Select Project → Scan → Recommend → Select Skills & Providers → Preview → Approve → Apply → Verify** directly on the main `paseo-project-skills` plugin while remaining **Preview-only by default** for unenrolled, disabled, or unsupported environments.

### Compatibility Matrix & Trust Boundary (Single-User Local Host)

| Dimension | Policy-Supported (Fail-Closed Outside) | Runtime-Verified |
| --- | --- | --- |
| **OS / Arch / FS** | `darwin` · `arm64` · `macOS >= 14.0.0` · local APFS read-write · case-insensitive | macOS `27.2.1` arm64 local APFS |
| **Paseo CLI / Daemon** | `0.17.5 <= v < 0.18.0` and `0.18.0` (blocks `< 0.17.5`, `0.18.1+`, `0.19.0+`) | Paseo `0.17.5` (M4.P2), Paseo `0.18.0` (M4.P3) |
| **Paseo Plugin SDK** | `@getpaseo/{client,plugin,protocol}` `0.17.4 <= v < 0.18.0` (all 3 identical, verified via build-time SDK manifest) | SDK `0.17.4` (`manifestSha256` verified at build & runtime) |
| **Native Writer Helper** | Embedded arm64 Mach-O (`SHA-256` + strict `0700` extraction + `codesign --verify --strict` + protocol v1) | Rebuilt & verified (`1e0351cc...`) |
| **Trust Boundary** | Single-user Local Host: loopback `listen`, Relay/remote OFF, out-of-band CLI enrollment | Verified Relay ON/OFF on Paseo `0.17.5` & `0.18.0` |

- **Build-time SDK manifest scope:** `scripts/build-sdk-manifest.mjs` verifies exact semver pins in `package.json`, matching versions and SRI integrity strings in `package-lock.json`, installed `node_modules/@getpaseo/*/package.json` SHA-256/versions, and binds them to `paseo-plugin.json`, `native/anchored-writer.m`, and `writerArtifacts.{standard,testing}.sha256` via a canonical `manifestSha256`. At runtime (including Paseo's bundled plugin runner where `import.meta.url` is unavailable), `verifyEmbeddedSdkManifest()` checks schema, SRI format, semver policy, `manifestSha256`, and native writer SHA-256 binding; it does not re-hash full `node_modules` JS file trees at runtime.
- **Local-only fail-closed (with optional host CLI Relay opt-in):** Safe Apply defaults to **Preview-only** if Paseo Relay (`daemon.relay.enabled` / `PASEO_RELAY_ENABLED`), remote exposure, or a non-loopback `listen` address is active, or if daemon config cannot be verified. For a single-owner personal host where only your own paired devices use Paseo Relay, you may explicitly opt in out-of-band via host CLI (`scripts/enroll-project-skills.mjs relay-policy --allow`) and reload `paseo-project-skills`; non-loopback `listen`, `remote.enabled`, per-project enrollment, and create-only native guards remain strictly enforced, and `relay-policy --deny` revokes immediately.
- **No caller principal in SDK 0.17.4 / Paseo 0.18.0:** Approval receipts bind the exact plan digest, target root identity, and `policyRevision`, but do **not** cryptographically attest human approver identity. Enrollment is strictly out-of-band via host CLI; no enrollment RPC is exposed.

### Enrollment & Opt-In CLI (Out-of-Band Host Operation)
By default the CLI targets `~/.paseo` (or `$PASEO_HOME` / `--home <daemonHome>`):

```sh
# List enrolled project roots and trust-boundary status
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs list

# Enroll an exact canonical project root (no wildcards, symlinks, or parent grants)
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs enroll --root /abs/path/to/project

# Temporarily disable or re-enable (with optional policyRevision rotation)
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs disable --root /abs/path/to/project
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs enable --root /abs/path/to/project --rotate

# Permanently revoke enrollment for a project root
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs revoke --root /abs/path/to/project

# Optional (single-owner paired Relay): allow or deny Safe Apply while Paseo Relay is enabled
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs relay-policy --allow
node --import ./tests/register.mjs scripts/enroll-project-skills.mjs relay-policy --deny
```

### Usage & Recovery
1. Open **Project Skills**, choose an enrolled project, select providers, and pin a catalog tag/SHA.
2. Run **Scan & Recommend**, select skills, and click **Preview Changes**.
3. Review planned creates (`.agents/skills/<id>/*` and, for Kiro at a confirmed Git root, `.kiro/skills/<id>/*`). Any `conflict` or `blocked` file blocks the entire plan.
4. Click **Review create-only approval → Confirm create-only**. Existing files are never overwritten or deleted (`O_CREAT | O_EXCL`).
5. **Recovery after crash, partial write, or lost mobile tracking:** Safe Apply never auto-retries or rolls back. Keep the `operationId` shown under **Apply Operations** (still readable via `apply.status.v1` even after disabling/revoking enrollment or revoking `allowRelay`). On Paseo Mobile (React Native), client operation tracking uses session memory (because `globalThis.localStorage` is absent) and does not survive a force-kill or app restart; if client tracking is lost, locate the authoritative durable record on the daemon host at `~/.paseo/runtime/project-skills/coordinator/<operationId>.json` (`ls -lt ~/.paseo/runtime/project-skills/coordinator/*.json`), inspect any `created_incomplete` / `ownership_unknown` entries against disk, clean up incomplete files manually outside Safe Apply, and run a fresh **Preview Changes**.

### Residual Risks & Known Limitations (M4 v1)
- **No caller principal in SDK `0.17.4` / Paseo `0.18.0`:** Receipts bind exact plan digest, target root identity, and `policyRevision`, not cryptographic human approver identity. Enrollment and Relay opt-in are strictly out-of-band host CLI operations.
- **Optional Paired Relay (`relay-policy --allow`):** Default is fail-closed (`allowRelay: false`). When explicitly opted in on a single-owner host, any device paired to your Paseo daemon over Relay can trigger `apply.create.v1` on enrolled roots (loopback `listen`, `remote.enabled: false`, enrollment, and create-only guards remain enforced).
- **Create-only without auto-rollback:** Crash or `ENOSPC` mid-write can leave an incomplete `0600` file requiring manual reconciliation against the durable daemon journal.
- **Mobile client tracking:** Session-memory fallback on React Native does not persist `operationId` across app kill/reload; host-side daemon journal recovery (`~/.paseo/runtime/project-skills/coordinator/*.json`) is authoritative. Persistent mobile operation tracking is tracked in the post-M4 backlog.

See [the M4.P1 report](docs/safe-apply-pilot/M4.P1-completion-report.md), [the M4.P2 report](docs/safe-apply-pilot/M4.P2-completion-report.md), [the M4.P3 report](docs/safe-apply-pilot/M4.P3-completion-report.md), [the Final M4 Production Relay Apply report](docs/safe-apply-pilot/FINAL-M4-production-relay-apply-acceptance-report.md), and [the M4 Closure Summary](docs/safe-apply-pilot/M4-closure-summary.md).

## Optional AI capability

M2.3 provides a server-side structured agent executor through the public Paseo SDK. It ships with no verified execution profiles, so provider availability alone cannot start a run. The executor is internal to the plugin and will be connected to the optional AI-assisted recommendation flow separately. Catalog and project evidence remain available independently. See [the M2.3 completion report](docs/reports/M2.3-completion-report.md) for the local preflight and provider limitations.

## Roadmap & Milestone Status

| Milestone | Scope | Status |
| --- | --- | --- |
| **M1 — Foundation** | Plugin shell, directory validation, host/workspace selection, catalog settings | **Completed** |
| **M2 — Read-only scan & recommendation** | Pinned Git catalog loader, bounded project scanner, deterministic recommendation engine, Scan UI | **Completed** |
| **M3 — Preview & provider adapters** | Canonical preview planner, provider adapters (Codex, Cursor ACP, Antigravity `canonical_only`; Kiro `.kiro/skills/` derived), Preview UI | **Completed** |
| **M4 — Safe Apply (Create-Only v1)** | Immutable preview receipts (`v2`), native anchored create-only writer, durable journal, multi-root out-of-band enrollment, build-time SDK manifest, Paseo `0.18.0` compatibility, optional host CLI `relay-policy`, Production Desktop & Mobile/Relay Acceptance | **Completed (Production Desktop/Mobile Acceptance: PASS)** |
| **M5 — SLP integration pilot & post-M4 backlog** | Optional SLP integration while keeping standalone plugin usable; post-M4 backlog: persistent mobile operation tracking | **Planned** |

[Paseo 0.17.4 plugin guide](https://github.com/getpaseo/paseo/blob/v0.17.4/docs/plugins.md)
