// Runs with `node --test` (Node >= 22.18 strips the TypeScript types in ../src/release-gate.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { replayTrace, validateModel, verifyModel } from '@rulecanvas/core';
import { createModelJsonCodec } from '@rulecanvas/workbench/model-json';
import {
  PROD_REQUIRES_REVIEW,
  RELEASE_GATE_MODELS,
  VERIFY_OPTIONS,
} from '../src/release-gate.ts';

const codec = createModelJsonCodec(undefined, { duplicateKeys: 'reject' });

describe('CI/CD production release gate', () => {
  test('both variants are valid models', () => {
    for (const model of Object.values(RELEASE_GATE_MODELS)) {
      assert.deepEqual(validateModel(model), []);
    }
  });

  test('broken variant violates prod-requires-review with a replayable 5-step counterexample', () => {
    const model = RELEASE_GATE_MODELS.broken;
    const result = verifyModel(model, VERIFY_OPTIONS);
    assert.equal(result.status, 'VIOLATED');
    assert.deepEqual(result.violatedInvariantIds, [PROD_REQUIRES_REVIEW]);
    const ruleIds = result.trace.map((step) => step.ruleId);
    assert.deepEqual(ruleIds, [
      'promote-staging',
      'retry-build',
      'promote-staging',
      'open-hotfix-bypass',
      'promote-prod',
    ]);
    assert.deepEqual(result.terminalState, {
      stage: 'prod',
      reviewed: false,
      hotfixBypass: true,
      retries: 1,
    });

    const replay = replayTrace(model, ruleIds);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.violatedInvariantIds, [PROD_REQUIRES_REVIEW]);
  });

  test('principled fix verifies and still reaches stage == "prod"', () => {
    const result = verifyModel(RELEASE_GATE_MODELS.principled, VERIFY_OPTIONS);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.goalReachable, true);
  });

  test('model JSON round-trips through the strict codec', () => {
    for (const model of Object.values(RELEASE_GATE_MODELS)) {
      const encoded = codec.encode(model);
      assert.equal(encoded.ok, true);
      const decoded = codec.decode(encoded.text);
      assert.equal(decoded.ok, true);
      assert.deepEqual(decoded.model, model);
    }
  });

  test('the strict codec rejects duplicate keys', () => {
    const encoded = codec.encode(RELEASE_GATE_MODELS.principled);
    assert.equal(encoded.ok, true);
    const duplicated = encoded.text.replace('"id": "release-gate-principled"', '"id": "a", "id": "release-gate-principled"');
    assert.notEqual(duplicated, encoded.text, 'fixture edit must apply');
    const decoded = codec.decode(duplicated);
    assert.equal(decoded.ok, false);
  });
});
