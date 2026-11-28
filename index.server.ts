import type { PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSettings } from "./shared/catalog-settings";
import { applyCreateRpc, applyStatusRpc, applyTargetStatusRpc, type ApplyTargetStatusOutput } from "./shared/apply";
import { canonicalPreviewRpc, providerPreviewRpc, providerPreviewV2Rpc, catalogLoadRpc, foundationStatusRpc, recommendationEvaluateSubscription, targetScanSubscription, validateDirectoryRpc } from "./shared/rpc";
import { CatalogLoader } from "./server/catalog-loader";
import { loadCatalogForHost } from "./server/catalog-rpc";
import { ProjectScanner } from "./server/project-scanner";
import { createRecommendationHandler } from "./server/recommendation-rpc";
import { validateDirectory } from "./server/validate-directory";
import { createCanonicalPreviewHandler } from "./server/canonical-preview";
import { createMultiRootApply } from "./server/fixture-apply";
import { PreviewReceiptStore } from "./server/preview-receipts";
import { ApplyJournal } from "./server/apply-journal";
import {
  listMultiRootEnrollments,
  multiRootRuntimeDirectory,
  readActiveMultiRootBinding,
  readActiveMultiRootEnrollment,
} from "./server/multi-root-policy";
import {
  checkDaemonTrustBoundary,
  detectDefaultPaseoCli,
  evaluateHostCompatibility,
  readInstalledSdkVersions,
  resolveSafeDaemonHome,
  verifyEmbeddedSdkManifest,
} from "./server/compatibility-policy";
import { probeSingleProjectRoot } from "./server/single-project-pilot";

export const mainPluginInstallationId = "paseo-project-skills";

/**
 * Resolves the plugin root safely across ESM and bundled CJS runtimes.
 * Never throws at module initialization and never falls back to process.cwd().
 * Returns undefined when the runtime does not expose a verifiable module path
 * (e.g. Paseo's bundled plugin runner), causing host compatibility to fail-closed
 * to Preview-only unless verified SDK versions are supplied explicitly.
 */
export function resolveDefaultPluginRoot(metaUrl?: unknown, dirnameValue?: unknown): string | undefined {
  if (typeof metaUrl === "string" && metaUrl.length > 0) {
    try {
      return dirname(fileURLToPath(metaUrl));
    } catch {
      return undefined;
    }
  }
  if (typeof dirnameValue === "string" && dirnameValue.length > 0) {
    return dirnameValue;
  }
  return undefined;
}

const defaultPluginRoot = resolveDefaultPluginRoot(
  typeof import.meta !== "undefined" ? (import.meta as { url?: unknown }).url : undefined,
  typeof __dirname === "string" ? __dirname : undefined,
);

export type MainPluginServerOptions = {
  daemonHome?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  paseoVersion?: string;
  sdkVersions?: readonly string[];
  sdkManifest?: unknown;
  macOsVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pluginRoot?: string;
  catalog?: Pick<CatalogLoader, "load" | "dispose">;
};

export function createMainPluginServer(server: PluginServerContext, options: MainPluginServerOptions = {}) {
  server.handle(foundationStatusRpc, () => ({ status: "ready" as const }));
  server.handle(validateDirectoryRpc, validateDirectory);

  const settings = server.registerSettings(catalogSettings);
  const ownedLoader = new CatalogLoader();
  const catalog = options.catalog ?? ownedLoader;
  server.handle(catalogLoadRpc, () => loadCatalogForHost(settings, catalog));

  const scanner = new ProjectScanner();
  server.handle(targetScanSubscription, async (input, { signal, push }) => {
    const result = await scanner.scan(input, signal);
    if (result && !signal.aborted) await push(targetScanSubscription.event.parse(result));
  });
  server.handle(recommendationEvaluateSubscription, createRecommendationHandler(settings, catalog, scanner));

  const env = options.env ?? process.env;
  const pluginRoot = options.pluginRoot ?? defaultPluginRoot;
  // Build-time SDK manifest verification is independent of runtime module paths (bundled CJS/ESM).
  // When an unbundled pluginRoot with node_modules/@getpaseo/* is also present, cross-check for drift.
  let sdkVersions: readonly string[] | undefined = options.sdkVersions;
  if (sdkVersions === undefined && pluginRoot) {
    const installed = readInstalledSdkVersions(pluginRoot);
    if (installed.length > 0) {
      const manifestCheck = verifyEmbeddedSdkManifest(
        "sdkManifest" in options ? options.sdkManifest : undefined,
      );
      if (!manifestCheck.ok || installed.some(v => v !== manifestCheck.version)) {
        sdkVersions = [];
      }
    }
  }
  const cliPath = options.cliPath ?? detectDefaultPaseoCli(env);
  const homeResolution = resolveSafeDaemonHome(options.daemonHome, { env, homeDir: options.homeDir });
  const compat = evaluateHostCompatibility({
    daemonHome: options.daemonHome,
    homeDir: options.homeDir,
    env,
    cliPath,
    paseoVersion: options.paseoVersion,
    ...(sdkVersions !== undefined ? { sdkVersions } : {}),
    ...("sdkManifest" in options ? { sdkManifest: options.sdkManifest } : {}),
    macOsVersion: options.macOsVersion,
    platform: options.platform,
    arch: options.arch,
  });

  const daemonHome = homeResolution.ok ? homeResolution.daemonHome : undefined;
  const verifyTrust = () => daemonHome ? checkDaemonTrustBoundary(daemonHome, { env }) : { ok: false as const, reason: "unsafe_daemon_home" as const };

  let receipts = new PreviewReceiptStore();
  let apply: ReturnType<typeof createMultiRootApply> | undefined;

  if (compat.compatible && daemonHome) {
    const writableReceipts = new PreviewReceiptStore({
      multiRoot: (target) => {
        if (!verifyTrust().ok) return undefined;
        return readActiveMultiRootBinding(daemonHome, target);
      },
    });
    try {
      apply = createMultiRootApply({
        daemonHome,
        installation: mainPluginInstallationId,
        readPolicy: (target) => readActiveMultiRootEnrollment(daemonHome, target),
        checkTrustBoundary: (home) => checkDaemonTrustBoundary(home, { env }),
        receipts: writableReceipts,
        settings,
        catalog,
        environment: { paseoVersion: compat.paseoVersion, sdkVersion: compat.sdkVersion },
      });
      receipts = writableReceipts;
    } catch {
      // Missing or unsafe coordinator keeps the installation Preview-only.
    }
  }

  const preview = createCanonicalPreviewHandler(settings, catalog, { receiptStore: receipts });
  server.handle(canonicalPreviewRpc, preview.handle);
  server.handle(providerPreviewRpc, preview.handleProviders);
  server.handle(providerPreviewV2Rpc, async (input, context) => {
    const result = await preview.handleProvidersV2(input, context);
    if (result.status === "ready" && result.applyEligibility.status === "eligible") {
      if (!compat.compatible || !daemonHome || !verifyTrust().ok) {
        return { ...result, applyEligibility: { status: "ineligible" as const, reasons: ["write_capability_unavailable" as const] } };
      }
      const target = result.manifest.plan.intent.canonicalDirectory;
      const active = readActiveMultiRootEnrollment(daemonHome, target);
      if (!active || !await probeSingleProjectRoot(active, target)) {
        return { ...result, applyEligibility: { status: "ineligible" as const, reasons: ["write_capability_unavailable" as const] } };
      }
    }
    return result;
  });

  server.handle(applyTargetStatusRpc, async (input): Promise<ApplyTargetStatusOutput> => {
    const trust = verifyTrust();
    const reasons: string[] = [];
    if (!compat.compatible) {
      for (const r of compat.reasons) if (!reasons.includes(r)) reasons.push(r);
    }
    if (!trust.ok && !reasons.includes(trust.reason)) reasons.push(trust.reason);

    const listed = daemonHome ? listMultiRootEnrollments(daemonHome) : { status: "ok" as const, roots: [] };
    const enrolledCount = listed.status === "ok" ? listed.roots.filter(r => r.enabled).length : 0;
    const hostReady = Boolean(compat.compatible && apply && trust.ok && listed.status === "ok");
    if (listed.status === "unsafe" && !reasons.includes("unsafe_policy_file")) reasons.push("unsafe_policy_file");

    if (!input.canonicalDirectory) {
      return {
        hostCompatible: compat.compatible,
        trustBoundaryOk: trust.ok,
        reasons,
        enrolledCount,
        targetState: hostReady ? "none" : "host_unavailable",
      };
    }
    if (!hostReady || !daemonHome) {
      return {
        hostCompatible: compat.compatible,
        trustBoundaryOk: trust.ok,
        reasons,
        enrolledCount,
        targetState: "host_unavailable",
      };
    }
    const entry = listed.roots.find(r => r.enrollment.canonicalRoot === input.canonicalDirectory);
    if (!entry) {
      return { hostCompatible: true, trustBoundaryOk: true, reasons, enrolledCount, targetState: "not_enrolled" };
    }
    if (!entry.enabled) {
      return {
        hostCompatible: true,
        trustBoundaryOk: true,
        reasons,
        enrolledCount,
        targetState: "enrolled_disabled",
        policyRevision: entry.enrollment.policyRevision,
      };
    }
    const verified = await probeSingleProjectRoot(entry.enrollment, input.canonicalDirectory);
    return {
      hostCompatible: true,
      trustBoundaryOk: true,
      reasons,
      enrolledCount,
      targetState: verified ? "enrolled_enabled" : "root_identity_mismatch",
      policyRevision: entry.enrollment.policyRevision,
    };
  });

  if (apply) {
    const service = apply;
    server.handle(applyCreateRpc, (input, context) => service.create(input, context));
    server.handle(applyStatusRpc, (input, context) => service.status(input, context));
  } else if (daemonHome) {
    // Even when Apply is inactive (e.g. Relay enabled), keep read-only status lookup available for recovery.
    server.handle(applyStatusRpc, async (input, context) => {
      try {
        const coordinator = join(multiRootRuntimeDirectory(daemonHome), "coordinator");
        if (!existsSync(coordinator)) return { status: "error" as const, code: "outcome_unknown" as const };
        const journal = new ApplyJournal(coordinator);
        const hostId = (await context.paseo.hosts.list()).self.serverId;
        const record = journal.read(input.operationId);
        if (!record || record.hostId !== hostId || record.installation !== mainPluginInstallationId) {
          return { status: "error" as const, code: "outcome_unknown" as const };
        }
        const op = record.operation;
        if (op.phase === "accepted" || op.phase === "preflight" || op.phase === "writing") {
          return {
            ...op,
            phase: "recovery_required" as const,
            code: "terminal_record_missing",
            targetMutated: "unknown" as const,
            durability: "not_confirmed" as const,
            requiresPreview: true,
          };
        }
        return op;
      } catch {
        return { status: "error" as const, code: "outcome_unknown" as const };
      }
    });
  }

  return async () => {
    await apply?.dispose();
    await Promise.all([preview.dispose(), ownedLoader.dispose(), scanner.dispose()]);
  };
}

export default function contribute(server: PluginServerContext) {
  return createMainPluginServer(server);
}
