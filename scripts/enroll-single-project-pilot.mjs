// Operator CLI for managing single-project Safe Apply enrollment in an isolated daemon home.
// Reuses server/single-project-policy.ts without relaxing any safety guard.
import { realpathSync } from 'node:fs';
import {
  enrollSingleProjectRoot,
  pilotPolicyPath,
  readActiveSingleProjectPolicy,
  setSingleProjectOptIn,
} from '../server/single-project-policy.ts';

const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function usage() {
  console.error([
    'Usage:',
    '  node --import ./tests/register.mjs scripts/enroll-single-project-pilot.mjs status --home <daemonHome>',
    '  node --import ./tests/register.mjs scripts/enroll-single-project-pilot.mjs enroll --home <daemonHome> --root <canonicalRoot> [--disabled]',
    '  node --import ./tests/register.mjs scripts/enroll-single-project-pilot.mjs enable --home <daemonHome> [--rotate]',
    '  node --import ./tests/register.mjs scripts/enroll-single-project-pilot.mjs disable --home <daemonHome>',
  ].join('\n'));
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const homeArg = argValue(rest, '--home');
if (!command || !homeArg) usage();
const daemonHome = realpathSync(homeArg);

if (command === 'status') {
  const active = readActiveSingleProjectPolicy(daemonHome);
  console.log(JSON.stringify({
    command: 'status',
    daemonHome,
    policyPath: pilotPolicyPath(daemonHome),
    active: Boolean(active),
    ...(active ? {
      canonicalRoot: active.canonicalRoot,
      policyRevision: active.policyRevision,
      volume: active.volume,
      ancestorCount: active.ancestors.length,
      rootIdentity: active.ancestors[active.ancestors.length - 1],
    } : {}),
  }, null, 2));
} else if (command === 'enroll') {
  const root = argValue(rest, '--root');
  if (!root) usage();
  const enabled = !rest.includes('--disabled');
  const result = await enrollSingleProjectRoot({ daemonHome, root, environment, enabled });
  if (result.status !== 'enrolled') {
    console.log(JSON.stringify({ command: 'enroll', status: 'error', code: result.code }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    command: 'enroll',
    status: 'enrolled',
    daemonHome,
    policyPath: result.path,
    enabled: result.policy.enabled,
    canonicalRoot: result.policy.enrollment.canonicalRoot,
    policyRevision: result.policy.enrollment.policyRevision,
    volume: result.policy.enrollment.volume,
    ancestorCount: result.policy.enrollment.ancestors.length,
    rootIdentity: result.policy.enrollment.ancestors[result.policy.enrollment.ancestors.length - 1],
  }, null, 2));
} else if (command === 'enable' || command === 'disable') {
  const enabled = command === 'enable';
  const rotate = rest.includes('--rotate');
  const updated = setSingleProjectOptIn(daemonHome, enabled, rotate);
  console.log(JSON.stringify({
    command,
    status: 'updated',
    daemonHome,
    policyPath: pilotPolicyPath(daemonHome),
    enabled: updated.enabled,
    canonicalRoot: updated.enrollment.canonicalRoot,
    policyRevision: updated.enrollment.policyRevision,
  }, null, 2));
} else {
  usage();
}
