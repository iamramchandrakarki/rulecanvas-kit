import { describe, expect, it } from 'vitest';
import { replayTrace, verifyModel, type TransitionSystemModel } from '@rulecanvas/core';

// 38-LOC third-domain model: CIReleaseGate (broken -> fixed)
function buildCIReleaseGate(requireFreshTestsOnDeploy: boolean): TransitionSystemModel {
  const eq = (name: string, value: string) => ({ op: 'eq' as const, left: { op: 'var' as const, name }, right: { op: 'lit' as const, value } });
  const not = (name: string) => ({ op: 'not' as const, arg: { op: 'var' as const, name } });
  const deployGuard = requireFreshTestsOnDeploy
    ? { op: 'and' as const, args: [{ op: 'var' as const, name: 'signed' }, eq('tests', 'passed'), not('deployed')] }
    : { op: 'and' as const, args: [{ op: 'var' as const, name: 'signed' }, not('deployed')] };

  return {
    id: requireFreshTestsOnDeploy ? 'ci-release-gate-fixed' : 'ci-release-gate-broken',
    name: 'CIReleaseGate',
    schema: {
      tests: { kind: 'enum', values: ['stale', 'passed'] },
      artifact: { kind: 'enum', values: ['clean', 'hotfix'] },
      signed: { kind: 'boolean' },
      deployed: { kind: 'boolean' },
    },
    initialState: { tests: 'stale', artifact: 'clean', signed: false, deployed: false },
    rules: [
      { id: 'run-tests', label: 'Run CI suite', guard: { op: 'and', args: [eq('tests', 'stale'), not('deployed')] }, updates: [{ var: 'tests', value: { op: 'lit', value: 'passed' } }] },
      { id: 'sign-release', label: 'Sign build', guard: { op: 'and', args: [eq('tests', 'passed'), not('signed'), not('deployed')] }, updates: [{ var: 'signed', value: { op: 'lit', value: true } }] },
      { id: 'hotfix-patch', label: 'Apply hotfix', guard: { op: 'and', args: [eq('artifact', 'clean'), not('deployed')] }, updates: [{ var: 'artifact', value: { op: 'lit', value: 'hotfix' } }, { var: 'tests', value: { op: 'lit', value: 'stale' } }] },
      { id: 'deploy-prod', label: 'Deploy build', guard: deployGuard, updates: [{ var: 'deployed', value: { op: 'lit', value: true } }] },
    ],
    invariants: [
      { id: 'no-untested-deploy', label: 'Deployed build must have passing tests', holds: { op: 'or', args: [not('deployed'), eq('tests', 'passed')] } },
    ],
    goal: { id: 'safe-deploy', label: 'Deploy tested build', reached: { op: 'and', args: [{ op: 'var', name: 'deployed' }, eq('tests', 'passed')] } },
    assumptions: [
      { id: 'a-ci', category: 'pipeline', statement: 'Pipeline stages execute sequentially on one candidate build.', notModeled: 'Flaky tests, runner compromise, or out-of-band manual deploys.' },
    ],
  };
}

describe('third-domain portability via @rulecanvas/core package import (CIReleaseGate)', () => {
  it('exposes a multi-step bypass (>= 2 steps) in the broken CIReleaseGate and verifies the fixed gate with goalReachable: true', () => {
    const broken = buildCIReleaseGate(false);
    const brokenRes = verifyModel(broken, { maxStates: 256, maxDepth: 20 });

    expect(brokenRes.status).toBe('VIOLATED');
    if (brokenRes.status !== 'VIOLATED') return;

    expect(brokenRes.trace.length).toBeGreaterThanOrEqual(2);
    expect(brokenRes.trace.map((s) => s.ruleId)).toEqual(['run-tests', 'sign-release', 'hotfix-patch', 'deploy-prod']);
    expect(brokenRes.violatedInvariantIds).toEqual(['no-untested-deploy']);

    const replayed = replayTrace(
      broken,
      brokenRes.trace.map((s) => s.ruleId),
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.finalState).toEqual(brokenRes.terminalState);
      expect(replayed.violatedInvariantIds).toEqual(['no-untested-deploy']);
    }

    const fixed = buildCIReleaseGate(true);
    const fixedRes = verifyModel(fixed, { maxStates: 256, maxDepth: 20 });

    expect(fixedRes.status).toBe('VERIFIED');
    if (fixedRes.status !== 'VERIFIED') return;
    expect(fixedRes.goalReachable).toBe(true);
  });
});
