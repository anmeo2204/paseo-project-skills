import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { applyCreateRpc, applyListOutputSchema, applyListRpc, applyStatusRpc, operationIdSchema } from "../shared/apply";
import { providerPreviewV2ResultSchema, receiptLimits, type ProviderPreviewV2Result } from "../shared/preview-receipt";
import { providerPreviewV2Rpc } from "../shared/rpc";
import type { SelectionIntentV1 } from "../shared/selection-intent";
import { type OperationTracker, type TrackedOperation } from "./apply-tracker";
import { Action, Detail, Disclosure, Input, Section } from "./controls";
import { PagedEffects } from "./paged-effects";
import { previewErrors, previewIntentKey, invalidResult } from "./preview-presentation";
import { PreviewResults } from "./preview-results";

const Context = createContext<{ tracker: OperationTracker; slot: string } | null>(null);
export const useFixtureApproval = () => useContext(Context);
export function FixtureApprovalScope({ tracker, slot, children }: {
  tracker: OperationTracker; slot: string; children: ReactNode;
}) {
  return <Context.Provider value={{ tracker, slot }}>{children}</Context.Provider>;
}

type Ready = Extract<ProviderPreviewV2Result, { status: "ready" }>;
type Attempt = { scope: object; nonce: string; deadline: number };
type Review = { attempt: Attempt; result: Ready; used: boolean };
function secureHex() {
  const crypto = (globalThis as unknown as { crypto?: { getRandomValues(value: Uint8Array): Uint8Array } }).crypto;
  if (!crypto) throw new Error("secure_random_unavailable");
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}
function eligible(result: Ready) {
  const { manifest, applyEligibility, plannedEffect } = result;
  const entries = [...manifest.plan.entries, ...manifest.plan.derivedEntries];
  return (manifest.policy.writeCapability === "fixture_m4_5" || manifest.policy.writeCapability === "single_project_v1" || manifest.policy.writeCapability === "multi_root_v1") && applyEligibility.status === "eligible" &&
    plannedEffect === "create_only" && entries.some(entry => entry.status === "create") &&
    entries.every(entry => entry.status === "create" || entry.status === "unchanged") &&
    manifest.readSet.every(({ observation }) => observation.state !== "unverified" &&
      (observation.state !== "present" || observation.kind !== "unsafe"));
}
const reasonLabels = {
  write_capability_unavailable: "Writes are unavailable on this host.",
  plan_conflict: "A file conflict blocks the entire plan.",
  plan_blocked: "A blocked file prevents applying the entire plan.",
  observations_unverified: "Some filesystem observations could not be verified.",
};

export function FixtureApprovalPreview({ theme, intent, generation, disabled = false }: {
  theme: PluginTheme; intent: SelectionIntentV1; generation: string; disabled?: boolean;
}) {
  const { tracker, slot } = useFixtureApproval()!;
  const preview = useRpc(providerPreviewV2Rpc);
  const apply = useRpc(applyCreateRpc);
  const scopeKey = JSON.stringify([slot, generation, previewIntentKey(intent), disabled]);
  const scope = useRef<{ key: string } | null>(null);
  const active = useRef<Attempt | null>(null);
  const reviewed = useRef<Review | null>(null);
  const confirming = useRef<Review | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "confirming" | "submitted">("idle");
  const [message, setMessage] = useState("");
  const [expired, setExpired] = useState(false);

  useLayoutEffect(() => {
    scope.current = { key: scopeKey };
    setReview(null);
    setState("idle");
    setMessage("");
    return () => {
      scope.current = null;
      active.current = null;
      reviewed.current = null;
      confirming.current = null;
    };
  }, [scopeKey]);

  const visible = review && review.attempt.scope === scope.current && scope.current?.key === scopeKey ? review : null;
  const expiresIn = (item: Review) => Math.min(item.result.receipt.expiresAt - Date.now(), item.attempt.deadline - performance.now());
  useEffect(() => {
    if (!visible) return;
    const expire = () => {
      setExpired(true);
      confirming.current = null;
      setState(current => current === "confirming" ? "idle" : current);
    };
    const remaining = expiresIn(visible);
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [visible]);

  async function start() {
    const current = scope.current;
    if (disabled || !intent.selectedSkillIds.length || !current || current.key !== scopeKey || active.current) return;
    reviewed.current = null;
    confirming.current = null;
    setReview(null);
    setExpired(false);
    setMessage("");
    let nonce: string;
    try { nonce = secureHex(); } catch { setMessage("Secure receipt binding is unavailable in this client."); return; }
    const attempt = { scope: current, nonce, deadline: performance.now() + receiptLimits.ttlMs };
    active.current = attempt;
    setState("pending");
    try {
      const raw = await preview({ intent, viewNonce: nonce });
      if (active.current !== attempt) return;
      const parsed = providerPreviewV2ResultSchema.safeParse(raw);
      if (!parsed.success) { setMessage(invalidResult); return; }
      if (parsed.data.status === "error") { setMessage(previewErrors[parsed.data.code]); return; }
      const { manifest, receipt } = parsed.data;
      if (previewIntentKey(manifest.plan.intent) !== previewIntentKey(intent) || manifest.hostId !== intent.hostId ||
          manifest.viewNonce !== nonce || receipt.viewNonce !== nonce || manifest.epoch !== receipt.epoch ||
          receipt.expiresAt <= receipt.issuedAt || receipt.expiresAt - receipt.issuedAt > receiptLimits.ttlMs) {
        setMessage(invalidResult);
        return;
      }
      const item = { attempt, result: parsed.data, used: false };
      reviewed.current = item;
      setReview(item);
    } catch {
      if (active.current === attempt) setMessage("Could not verify the preview on this host. Run Preview again.");
    } finally {
      if (active.current === attempt) { active.current = null; setState("idle"); }
    }
  }

  function canConfirm(item: Review) {
    return !disabled && scope.current?.key === scopeKey && scope.current === item.attempt.scope &&
      reviewed.current === item && !item.used && expiresIn(item) > 0 && eligible(item.result);
  }
  function submit(item: Review) {
    if (confirming.current !== item || !canConfirm(item)) return;
    let operationId: string;
    try { operationId = secureHex(); } catch { setMessage("Could not generate a secure operation ID."); return; }
    item.used = true;
    confirming.current = null;
    setState("submitted");
    const { manifest, receipt } = item.result;
    tracker.submit({ hostId: manifest.hostId, slot, target: manifest.plan.intent.canonicalDirectory,
      pinnedSha: manifest.plan.intent.catalogCommitSha, installationInstanceId: manifest.installationInstanceId }, {
      previewId: receipt.previewId, planDigest: receipt.planDigest, viewNonce: receipt.viewNonce, operationId, approval: "create_only_v1",
    }, apply);
  }

  return <>
    <Section theme={theme} title="Preview Changes">
      <Action theme={theme} primary label="Preview Changes" disabled={disabled || !intent.selectedSkillIds.length || state === "pending"}
        onPress={() => void start()} />
      <View accessibilityLiveRegion="polite">
        {state === "pending" && <Detail theme={theme}>Preparing read-only preview…</Detail>}
        {message !== "" && <Detail theme={theme} error>{message}</Detail>}
      </View>
      {state === "pending" && <Action theme={theme} label="Cancel Preview" onPress={() => {
        active.current = null;
        setState("idle");
      }} />}
    </Section>
    {visible && <ReviewPlan key={visible.attempt.nonce} theme={theme} result={visible.result} />}
    {visible && <Section theme={theme} title="Create-only Approval">
      {expired && state !== "submitted" && <Detail theme={theme} error>This preview expired. Run Preview again.</Detail>}
      {state === "submitted" && <Detail theme={theme}>Submitted. Follow the operation below. Closing this screen does not cancel it.</Detail>}
      {state === "confirming" ? <>
        <Detail theme={theme}>Create all proposed new files and directories on this host? Existing files will be left untouched. A failure can leave files partly created.</Detail>
        <PlanScope theme={theme} result={visible.result} />
        {visible.result.manifest.gitProof.status === "unconfirmed" && <Detail theme={theme}>Canonical files only. Kiro files are excluded from this plan.</Detail>}
        <Action theme={theme} label="Back to preview" onPress={() => { confirming.current = null; setState("idle"); }} />
        <Action theme={theme} primary label="Confirm create-only" disabled={expired} onPress={() => submit(visible)} />
      </> : <Action theme={theme} label="Review create-only approval" disabled={expired || state === "submitted" || !eligible(visible.result)}
        onPress={() => { if (canConfirm(visible)) { confirming.current = visible; setState("confirming"); } }} />}
    </Section>}
  </>;
}

function PlanScope({ theme, result }: { theme: PluginTheme; result: Ready }) {
  const { hostId, plan, directoryEffects } = result.manifest;
  const files = [...plan.entries, ...plan.derivedEntries];
  return <>
    <Text selectable style={{ color: theme.colors.foreground }}>Host: {hostId}</Text>
    <Text selectable style={{ color: theme.colors.foreground }}>Target: {plan.intent.canonicalDirectory}</Text>
    <Text selectable style={{ color: theme.colors.foreground }}>Pinned SHA: {plan.intent.catalogCommitSha}</Text>
    <Detail theme={theme}>Skills selected: {plan.intent.selectedSkillIds.join(", ")}</Detail>
    <Detail theme={theme}>Target providers: {plan.intent.targetProviderIds.join(", ") || "None"}</Detail>
    <Detail theme={theme}>{directoryEffects.length} directories to create · {files.filter(file => file.status === "create").length} files to create · {files.filter(file => file.status === "unchanged").length} unchanged</Detail>
  </>;
}

function ReviewPlan({ theme, result }: { theme: PluginTheme; result: Ready }) {
  return <>
    <Section theme={theme} title="Planned Changes">
      <PlanScope theme={theme} result={result} />
      <Detail theme={theme}>{
        eligible(result) ? "Eligible for create-only approval." : result.applyEligibility.status === "no_changes" ? "No changes to approve." : "This plan is ineligible for approval."
      }</Detail>
      {result.applyEligibility.status === "ineligible" && result.applyEligibility.reasons.map(reason =>
        <Detail key={reason} theme={theme} error>{reasonLabels[reason]}</Detail>)}
      <PagedEffects theme={theme} label="directories" items={result.manifest.directoryEffects} render={item =>
        <Text key={item.destination} selectable style={{ color: theme.colors.foreground }}>Create directory · {item.destination} · mode 0755</Text>} />
    </Section>
    <PreviewResults theme={theme} result={result.manifest.plan} paged hideHeaderScope />
  </>;
}

const rejectedReasonLabels: Record<string, string> = {
  tracking_unavailable: "Could not save the operation for recovery. No request was sent.",
  receipt_invalid: "Preview receipt is expired, evicted, or invalidated by a policy or trust-boundary change.",
  receipt_consumed: "This preview receipt was already used.",
  journal_full: "Apply operation journal is full (64 active records). Inspect pending recovery records or wait for terminal retention cleanup.",
  journal_unavailable: "Apply journal is unavailable on this daemon.",
  plan_not_applicable: "Plan is not applicable (conflict, blocked entry, or no files to create).",
  unsupported_environment: "Host environment or local-only trust boundary (e.g. Relay enabled) blocked this operation.",
  operation_mismatch: "Operation ID does not match the original request.",
  cancelled: "Operation was cancelled before admission.",
};
const phaseLabels = {
  accepted: "Accepted", preflight: "Checking the approved plan", writing: "Writing",
  completed: "Completed", failed_before_write: "Failed before writing",
  partial_failure: "Stopped after a partial write", recovery_required: "Recovery required",
};
const rowLabels = {
  not_attempted: "Not attempted", unchanged_verified: "Unchanged and verified", created_verified: "Created and verified",
  created_incomplete: "Created, incomplete", observation_changed: "Destination changed", ownership_unknown: "Ownership unverified",
};

export function summarizeHostOperations(
  operations: readonly TrackedOperation[],
  hostId: string,
  slot: string,
): { label: string; isRecovery: boolean } | null {
  const scoped = operations.filter((item) => item.scope.hostId === hostId && item.scope.slot === slot);
  if (scoped.length === 0) return null;
  const recovery = scoped.find((item) => {
    const phase = item.operation?.phase ?? item.summary?.phase;
    return item.state === "outcome_unknown" || phase === "recovery_required" || phase === "partial_failure";
  });
  if (recovery) {
    return {
      label: `Apply operation ${recovery.operationId.slice(0, 8)} requires review or recovery.`,
      isRecovery: true,
    };
  }
  const active = scoped.find((item) => {
    const phase = item.operation?.phase ?? item.summary?.phase;
    return item.state === "sending" || phase === "accepted" || phase === "preflight" || phase === "writing";
  });
  if (active) {
    return {
      label: `Apply operation ${active.operationId.slice(0, 8)} is in progress.`,
      isRecovery: false,
    };
  }
  return null;
}

export function FixtureOperations({ theme, host, online }: Pick<PluginScreenProps, "theme" | "host"> & { online: boolean }) {
  const { tracker, slot } = useFixtureApproval()!;
  const status = useRpc(applyStatusRpc);
  const listOps = useRpc(applyListRpc);
  const connection = useRef<object | null>(null);
  const listTokenRef = useRef<object | null>(null);
  const binding = useMemo(() => ({ hostId: host.id, slot, status, listOps, online }), [host.id, slot, status, listOps, online]);
  useLayoutEffect(() => {
    connection.current = binding;
    return () => {
      connection.current = null;
      listTokenRef.current = null;
    };
  }, [binding]);
  const operations = useSyncExternalStore(tracker.subscribe, tracker.snapshot);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [unreadableCount, setUnreadableCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupId, setLookupId] = useState("");
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const [lookupPending, setLookupPending] = useState(false);

  async function discover(cursor?: string) {
    if (!online || connection.current !== binding) return;
    const token = {};
    listTokenRef.current = token;
    setLoadingList(true);
    try {
      const raw = await listOps(cursor ? { limit: 20, cursor } : { limit: 20 });
      if (connection.current !== binding || listTokenRef.current !== token) return;
      const parsed = applyListOutputSchema.safeParse(raw);
      if (!parsed.success) {
        setListNotice("Could not verify operation list from this host.");
        return;
      }
      if (parsed.data.status === "error") {
        setNextCursor(undefined);
        setUnreadableCount(0);
        setTruncated(false);
        if (parsed.data.code === "unsupported_environment") {
          // P1: Clear discovery-only cached items when trust boundary / Relay policy denies discovery.
          tracker.clearDiscoveryOnly(host.id, slot);
          setListNotice("Operation discovery is unavailable under the current Relay or trust policy. Known Operation IDs can still be checked below.");
        } else if (parsed.data.code === "busy") {
          setListNotice("Operation discovery is temporarily busy on this host. Refresh again in a moment.");
        } else {
          setListNotice("Daemon operation journal is currently unavailable. Known Operation IDs can still be checked below.");
        }
        return;
      }
      setListNotice(null);
      setNextCursor(parsed.data.nextCursor);
      setUnreadableCount(parsed.data.unreadableCount);
      setTruncated(parsed.data.truncated);
      tracker.ingestDiscovered(host.id, slot, parsed.data.items);
    } catch {
      if (connection.current !== binding || listTokenRef.current !== token) return;
      // Transport errors leave existing tracked operations intact (P5).
    } finally {
      if (listTokenRef.current === token) setLoadingList(false);
    }
  }

  useEffect(() => {
    setNextCursor(undefined);
    setUnreadableCount(0);
    setTruncated(false);
    setListNotice(null);
    tracker.restore();
    if (online) {
      tracker.check(host.id, slot, status);
      void discover();
    } else {
      tracker.offline(host.id, slot);
    }
    return () => {
      listTokenRef.current = null;
      tracker.releaseStatus(host.id, slot);
    };
  }, [tracker, host.id, slot, online, status, listOps]);

  async function submitLookup() {
    const trimmed = lookupId.trim().toLowerCase();
    if (!online || lookupPending || !operationIdSchema.safeParse(trimmed).success) return;
    setLookupPending(true);
    setLookupMessage(null);
    try {
      const res = await tracker.lookup(host.id, slot, trimmed, status);
      if (connection.current !== binding) return;
      if (res.status === "found") {
        setLookupId("");
        setLookupMessage(`Loaded operation ${trimmed.slice(0, 8)}.`);
      } else {
        setLookupMessage("Operation not found or expired on this host.");
      }
    } finally {
      if (connection.current === binding) setLookupPending(false);
    }
  }

  const lookupValid = operationIdSchema.safeParse(lookupId.trim().toLowerCase()).success;
  if (!operations.length && !listNotice && unreadableCount === 0 && !lookupOpen) {
    return online ? (
      <View style={{ paddingHorizontal: 4 }}>
        <Disclosure
          theme={theme}
          label="Look up operation by ID"
          expanded={lookupOpen}
          onPress={() => setLookupOpen(true)}
        />
      </View>
    ) : null;
  }

  return <Section theme={theme} title="Apply Operations">
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Action theme={theme} label={loadingList ? "Refreshing…" : "Refresh operations"} disabled={!online || loadingList}
        onPress={() => void discover()} />
      {nextCursor && (
        <Action theme={theme} label="Load more" disabled={!online || loadingList}
          onPress={() => void discover(nextCursor)} />
      )}
    </View>
    {listNotice && <Detail theme={theme}>{listNotice}</Detail>}
    {nextCursor?.startsWith("0:") && (
      <Detail theme={theme} error>
        Additional active or recovery-required operations exist on later pages. Choose Load more to inspect them, or Refresh operations to reload from the top.
      </Detail>
    )}
    {unreadableCount > 0 && (
      <Detail theme={theme} error>
        {unreadableCount} journal {unreadableCount === 1 ? "record" : "records"} could not be read. Inspect ~/.paseo/runtime/project-skills/coordinator/ on the host.
      </Detail>
    )}
    {truncated && (
      <Detail theme={theme}>
        Discovery reached its bounded scan limit; absence from this list does not imply completion or deletion.
      </Detail>
    )}
    {operations.map(item => <OperationRow key={item.operationId} theme={theme} item={item}
      canCheck={online && item.scope.hostId === host.id && item.scope.slot === slot}
      check={() => { if (online && connection.current === binding) tracker.check(host.id, slot, status, item.operationId); }} />)}
    <Disclosure
      theme={theme}
      label="Look up operation by ID"
      expanded={lookupOpen}
      onPress={() => setLookupOpen((value) => !value)}
    />
    {lookupOpen && (
      <View style={{ gap: 6 }}>
        <Input
          theme={theme}
          accessibilityLabel="Operation ID"
          placeholder="32–64 hex operation ID"
          value={lookupId}
          onChangeText={setLookupId}
          editable={online && !lookupPending}
        />
        <Action
          theme={theme}
          label={lookupPending ? "Checking…" : "Check by ID"}
          disabled={!online || lookupPending || !lookupValid}
          onPress={() => void submitLookup()}
        />
        {lookupMessage && <Detail theme={theme}>{lookupMessage}</Detail>}
      </View>
    )}
  </Section>;
}

function OperationRow({ theme, item, canCheck, check }: {
  theme: PluginTheme; item: TrackedOperation; canCheck: boolean; check: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const effective = item.operation ?? item.summary;
  const phase = effective?.phase;
  const unknown = item.state === "outcome_unknown";
  const checkable = unknown || item.state === "sending" || phase === "accepted" || phase === "preflight" || phase === "writing";
  const title = item.state === "busy" ? "Busy before admission" : item.state === "rejected" ? "Request rejected" :
    unknown ? "Outcome unknown" : item.state === "sending" ? "Waiting for admission" : phase ? phaseLabels[phase] : "Outcome unknown";
  const ledgerLabel = unknown ? "Last known ledger" : "Operation ledger";

  function toggleLedger() {
    const next = !expanded;
    setExpanded(next);
    if (next && !item.operation && item.summary && canCheck) {
      check();
    }
  }

  return <View style={{ gap: 7 }}>
    <View accessibilityLiveRegion="polite"><Text accessibilityRole="header" style={{ color: theme.colors.foreground }}>{title}</Text></View>
    <Text selectable style={{ color: theme.colors.foregroundMuted }}>{item.scope.hostId}{item.scope.target ? " · " + item.scope.target : ""}</Text>
    <Text selectable style={{ color: theme.colors.foregroundMuted }}>Operation {item.operationId}</Text>
    {item.state === "busy" && <Detail theme={theme}>Another Apply operation is running on this daemon. No operation was admitted. Wait for it to finish and run Preview again before submitting.</Detail>}
    {item.state === "rejected" && <Detail theme={theme} error>{(item.code && rejectedReasonLabels[item.code]) ?? `${item.code}.`} Run Preview again before submitting.</Detail>}
    {phase === "recovery_required" && <Detail theme={theme} error>Recovery required: inspect the operation ledger below against disk before running Preview again. Safe Apply does not auto-retry or rollback.</Detail>}
    {checkable && <Detail theme={theme}>{canCheck ? "Check status to retrieve the result." : "Switch back to the original connected host to check status."}</Detail>}
    {checkable && <Action theme={theme} label="Check operation status" disabled={!canCheck} onPress={check} />}
    {unknown && <Detail theme={theme} error>Writes may have occurred. {item.operation ? "Compare the target with the last known ledger" : "Inspect the target for changes"}, then run Preview again.</Detail>}
    {effective?.requiresPreview && <Detail theme={theme} error>Check the files and directories below against the target, then run Preview again.</Detail>}
    {effective && <>
      {effective.code !== "none" && <Detail theme={theme}>Result code: {effective.code}</Detail>}
      <Detail theme={theme}>{effective.targetMutated === true ? "Target mutation recorded." : effective.targetMutated === false ? "No target mutation recorded." : "Target mutation is unknown."}</Detail>
      <Disclosure theme={theme} label={ledgerLabel} expanded={expanded} onPress={toggleLedger} />
      {expanded && (item.operation ? (
        <PagedEffects theme={theme} label="ledger entries" items={item.operation.ledger} render={row =>
          <Text key={row.destination} selectable style={{ color: theme.colors.foreground }}>{rowLabels[row.state]} · {row.kind} · {row.destination}
            {row.bytesWritten !== undefined ? ` · ${row.bytesWritten} bytes recorded` : ""}</Text>} />
      ) : (
        <Detail theme={theme}>
          {canCheck ? "Loading operation ledger from daemon…" : "Connect to the original host to load the operation ledger."}
        </Detail>
      ))}
    </>}
  </View>;
}
