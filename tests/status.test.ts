/**
 * Pure-function tests for status-overview / client-issues / client-history
 * helpers. Same shape as tests/lib.test.ts — runs with tsx, bails on first
 * assertion failure.
 *
 *   npx tsx tests/status.test.ts
 */
import { classifyClientStatus } from '../src/lib/status-overview';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
}

function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------- classifyClientStatus ----------

eq(
  'classify: no suggestions → all set',
  classifyClientStatus([]),
  { hasActionableIssues: false, issueCount: 0 },
);

eq(
  'classify: watch + adherence only → all set (informational)',
  classifyClientStatus(['watch', 'adherence']),
  { hasActionableIssues: false, issueCount: 0 },
);

eq(
  'classify: single adjust → issues count 1',
  classifyClientStatus(['adjust']),
  { hasActionableIssues: true, issueCount: 1 },
);

eq(
  'classify: mix of watch + adjust + pain → issues count 2',
  classifyClientStatus(['watch', 'adjust', 'pain']),
  { hasActionableIssues: true, issueCount: 2 },
);

eq(
  'classify: swap_candidate + skipped_day → issues count 2',
  classifyClientStatus(['swap_candidate', 'skipped_day']),
  { hasActionableIssues: true, issueCount: 2 },
);

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
