// Operator CLI for managing multi-root Safe Apply enrollments (out-of-band host/CLI).
// Reuses server/multi-root-policy.ts and server/compatibility-policy.ts without relaxing any safety guard.
import {
  enrollMultiRoot,
  inspectLegacyPilotMigrationStatus,
  listMultiRootEnrollments,
  multiRootPolicyPath,
  revokeMultiRoot,
  setMultiRootOptIn,
} from '../server/multi-root-policy.ts';
import {
  checkDaemonTrustBoundary,
  resolveSafeDaemonHome,
  safeApplyCompatibilityPolicy,
} from '../server/compatibility-policy.ts';

const environment = {
  paseoVersion: safeApplyCompatibilityPolicy.minPaseoVersion,
  sdkVersion: safeApplyCompatibilityPolicy.minSdkVersion,
};

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function usage() {
  console.error([
    'Usage:',
    '  node --import ./tests/register.mjs scripts/enroll-project-skills.mjs list [--home <daemonHome>]',
    '  node --import ./tests/register.mjs scripts/enroll-project-skills.mjs enroll --root <canonicalRoot> [--home <daemonHome>] [--disabled]',
    '  node --import ./tests/register.mjs scripts/enroll-project-skills.mjs enable --root <canonicalRoot> [--home <daemonHome>] [--rotate]',
    '  node --import ./tests/register.mjs scripts/enroll-project-skills.mjs disable --root <canonicalRoot> [--home <daemonHome>]',
    '  node --import ./tests/register.mjs scripts/enroll-project-skills.mjs revoke --root <canonicalRoot> [--home <daemonHome>]',
  ].join('\n'));
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();

const homeResolution = resolveSafeDaemonHome(argValue(rest, '--home'));
if (!homeResolution.ok) {
  console.log(JSON.stringify({ command, status: 'error', code: homeResolution.reason }, null, 2));
  process.exit(1);
}
const { daemonHome, source: daemonHomeSource } = homeResolution;
const trustBoundary = checkDaemonTrustBoundary(daemonHome);
const legacyPilot = inspectLegacyPilotMigrationStatus(daemonHome);

if (command === 'list') {
  const listed = listMultiRootEnrollments(daemonHome);
  if (listed.status !== 'ok') {
    console.log(JSON.stringify({ command: 'list', status: 'error', code: 'unsafe_policy_file', daemonHome }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    command: 'list',
    status: 'ok',
    daemonHome,
    daemonHomeSource,
    policyPath: multiRootPolicyPath(daemonHome),
    trustBoundary,
    legacyPilot,
    count: listed.roots.length,
    roots: listed.roots.map(item => ({
      canonicalRoot: item.enrollment.canonicalRoot,
      enabled: item.enabled,
      policyRevision: item.enrollment.policyRevision,
      volume: item.enrollment.volume,
      ancestorCount: item.enrollment.ancestors.length,
      rootIdentity: item.enrollment.ancestors[item.enrollment.ancestors.length - 1],
      enrolledAt: item.enrolledAt,
      updatedAt: item.updatedAt,
    })),
  }, null, 2));
} else if (command === 'enroll') {
  const root = argValue(rest, '--root');
  if (!root) usage();
  const enabled = !rest.includes('--disabled');
  const result = await enrollMultiRoot({ daemonHome, root, environment, enabled });
  if (result.status !== 'enrolled') {
    console.log(JSON.stringify({ command: 'enroll', status: 'error', code: result.code }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    command: 'enroll',
    status: 'enrolled',
    daemonHome,
    daemonHomeSource,
    policyPath: result.path,
    trustBoundary,
    enabled: result.entry.enabled,
    canonicalRoot: result.entry.enrollment.canonicalRoot,
    policyRevision: result.entry.enrollment.policyRevision,
    volume: result.entry.enrollment.volume,
    ancestorCount: result.entry.enrollment.ancestors.length,
    rootIdentity: result.entry.enrollment.ancestors[result.entry.enrollment.ancestors.length - 1],
  }, null, 2));
} else if (command === 'enable' || command === 'disable') {
  const root = argValue(rest, '--root');
  if (!root) usage();
  const enabled = command === 'enable';
  const rotate = rest.includes('--rotate');
  const result = setMultiRootOptIn(daemonHome, root, enabled, rotate);
  if (result.status !== 'updated') {
    console.log(JSON.stringify({ command, status: 'error', code: result.code }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    command,
    status: 'updated',
    daemonHome,
    policyPath: result.path,
    enabled: result.entry.enabled,
    canonicalRoot: result.entry.enrollment.canonicalRoot,
    policyRevision: result.entry.enrollment.policyRevision,
  }, null, 2));
} else if (command === 'revoke') {
  const root = argValue(rest, '--root');
  if (!root) usage();
  const result = revokeMultiRoot(daemonHome, root);
  if (result.status !== 'revoked') {
    console.log(JSON.stringify({ command: 'revoke', status: 'error', code: result.code }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    command: 'revoke',
    status: 'revoked',
    daemonHome,
    policyPath: result.path,
    canonicalRoot: result.canonicalRoot,
  }, null, 2));
} else {
  usage();
}
