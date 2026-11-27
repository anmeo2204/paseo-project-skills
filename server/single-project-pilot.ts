import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { catalogSettings } from "../shared/catalog-settings";
import { applyCreateRpc, applyStatusRpc, localApplyCapabilityRpc } from "../shared/apply";
import { canonicalPreviewRpc, providerPreviewRpc, providerPreviewV2Rpc, catalogLoadRpc,
  foundationStatusRpc, recommendationEvaluateSubscription, targetScanSubscription, validateDirectoryRpc } from "../shared/rpc";
import { CatalogLoader } from "./catalog-loader";
import { loadCatalogForHost } from "./catalog-rpc";
import { ProjectScanner } from "./project-scanner";
import { createRecommendationHandler } from "./recommendation-rpc";
import { validateDirectory } from "./validate-directory";
import { createCanonicalPreviewHandler } from "./canonical-preview";
import { createSingleProjectApply } from "./fixture-apply";
import { PreviewReceiptStore } from "./preview-receipts";
import { runSingleProjectWriter } from "./native-writer";
import { nativeWriterVersion } from "./native-writer-contract";
import { readActiveSingleProjectPolicy, toEnrollmentBinding, type ActiveSingleProjectPolicy } from "./single-project-policy";
import { pilotProfile, type SingleProjectPilotProfile } from "./single-project-pilot-profile";

const installation = "paseo-project-skills-single-project-pilot";
const environment = { paseoVersion: "0.17.5", sdkVersion: "0.17.4" };

export async function probeSingleProjectRoot(policy: ActiveSingleProjectPolicy, root: string) {
  try {
    if (root !== policy.canonicalRoot) return false;
    const node = await lstat(root, { bigint: true });
    if (!node.isDirectory() || await realpath(root) !== root) return false;
    const result = await runSingleProjectWriter({
      protocol: 1,
      helperVersion: nativeWriterVersion,
      enrollment: policy,
      root,
      expectedParentPid: process.pid,
      environment,
      files: [],
      directories: [],
      observations: [{
        scope: "target",
        path: root,
        observation: {
          state: "present",
          kind: "directory",
          dev: String(node.dev),
          ino: String(node.ino),
          mode: String(node.mode),
          uid: String(node.uid),
          gid: String(node.gid),
        },
      }],
    });
    return result.result.phase === "completed" &&
      result.result.targetMutated === false &&
      result.events.some(event => event.event === "environment" && event.caseMode === "insensitive" && event.fixtureOnly === false);
  } catch {
    return false;
  }
}

function supported(config: SingleProjectPilotProfile | undefined) {
  try {
    if (!config || process.platform !== "darwin" || process.arch !== "arm64" ||
        config.sdkVersions.length !== 3 || config.sdkVersions.some(version => version !== environment.sdkVersion)) return false;
    const home = realpathSync(config.daemonHome);
    const stat = lstatSync(home);
    if (process.env.PASEO_HOME !== home || !stat.isDirectory() || stat.uid !== process.getuid?.()) return false;
    const version = (file: string, ...args: string[]) =>
      execFileSync(file, args, { timeout: 3000, maxBuffer: 1024, encoding: "utf8" }).trim();
    return version(config.cli, "--version") === environment.paseoVersion &&
      version("/usr/bin/sw_vers", "-productVersion") === "27.2.1";
  } catch {
    return false;
  }
}

export default function contribute(server: PluginServerContext) {
  const config = pilotProfile as SingleProjectPilotProfile | undefined;
  const settings = server.registerSettings(catalogSettings);
  const loader = new CatalogLoader();
  const catalog = config?.catalog ?? loader;
  const scanner = new ProjectScanner();
  const readPolicy = () => config ? readActiveSingleProjectPolicy(config.daemonHome) : undefined;
  let receipts = new PreviewReceiptStore();
  let apply: ReturnType<typeof createSingleProjectApply> | undefined;
  if (config && supported(config)) {
    const writable = new PreviewReceiptStore({
      singleProject: () => {
        const active = readPolicy();
        return active ? toEnrollmentBinding(active) : undefined;
      },
    });
    try {
      apply = createSingleProjectApply({
        daemonHome: config.daemonHome,
        installation,
        readPolicy,
        receipts: writable,
        settings,
        catalog,
        environment,
        test: config.test,
      });
      receipts = writable;
    } catch { /* Missing or unsafe coordinator leaves the installation Preview-only. */ }
  }
  const preview = createCanonicalPreviewHandler(settings, catalog, { receiptStore: receipts });

  server.handle(foundationStatusRpc, () => ({ status: "ready" as const }));
  server.handle(validateDirectoryRpc, validateDirectory);
  server.handle(catalogLoadRpc, () => loadCatalogForHost(settings, catalog));
  server.handle(targetScanSubscription, async (input, { signal, push }) => {
    const result = await scanner.scan(input, signal);
    if (result && !signal.aborted) await push(result);
  });
  server.handle(recommendationEvaluateSubscription, createRecommendationHandler(settings, catalog, scanner));
  server.handle(canonicalPreviewRpc, preview.handle);
  server.handle(providerPreviewRpc, preview.handleProviders);
  server.handle(providerPreviewV2Rpc, async (input, context) => {
    const result = await preview.handleProvidersV2(input, context);
    if (result.status === "ready" && result.applyEligibility.status === "eligible") {
      const active = readPolicy();
      if (!active || !await probeSingleProjectRoot(active, result.manifest.plan.intent.canonicalDirectory)) {
        return { ...result, applyEligibility: { status: "ineligible" as const, reasons: ["write_capability_unavailable" as const] } };
      }
    }
    return result;
  });

  server.handle(localApplyCapabilityRpc, async () => {
    if (!apply) return { enabled: false };
    const active = readPolicy();
    if (!active) return { enabled: false };
    return { enabled: await probeSingleProjectRoot(active, active.canonicalRoot) };
  });

  if (apply) {
    const service = apply;
    server.handle(applyCreateRpc, (input, context) => {
      config?.trace?.("apply", input.operationId);
      return service.create(input, context);
    });
    server.handle(applyStatusRpc, async (input, context) => {
      config?.trace?.("status", input.operationId);
      const result = await service.status(input, context);
      await config?.afterStatus?.(input.operationId, result.status === "operation" ? result.phase : result.code);
      return result;
    });
  }
  return async () => { await apply?.dispose(); await Promise.all([preview.dispose(), loader.dispose(), scanner.dispose()]); };
}
