# @rulecanvas/workbench

Framework-independent verification worker/main-thread transport, detached capture and result validation, and strict portable model JSON codec for RuleCanvasKit (`v0.5.0`, `"private": true`).

## Purity & Dependency Contract

- **Sole dependency**: `@rulecanvas/core` (`workspace:*`) with zero external npm runtime dependencies.
- **Pure ES2022**: Compiles with `"lib": ["ES2022"]` and `"types": []`, with zero DOM globals on module import (including `./verify-worker`), zero `node:*` imports, and zero domain-specific terminology.
- **Subpath-only exports**: Exposes three explicit subpaths (`./verify`, `./verify-worker`, `./model-json`) and intentionally omits a root `"."` export.

## Package Exports

### `@rulecanvas/workbench/verify` (`./dist/verify.js`)

- Functions & constants: `createVerifyClient`, `createLegacyWorkerAdapter`, `isFactoryVerifyClient`, `isWebWorkerSupported`, `captureVerificationRequest`, `sanitizeAndFreezeVerifyResult`, `deepFreeze`, `VERIFY_PROTOCOL_VERSION`
- Types: `VerifyClient`, `VerifyExecutionMode`, `VerifyExecutionPolicy`, `VerifyRunOptions`, `VerifySettlement`, `VerifyWorkerErrorEvent`, `VerifyWorkerInstance`, `LegacyWorkerLike`, `VerifyWorkerRequestMessage`, `VerifyWorkerResponseMessage`

### `@rulecanvas/workbench/verify-worker` (`./dist/verify-worker.js`)

- Functions & constants: `installVerifyWorker`, `VERIFY_PROTOCOL_VERSION`
- Types: `VerifyWorkerMessageEvent`, `VerifyWorkerPort`, `VerifyWorkerRequestMessage`, `VerifyWorkerResponseMessage`

### `@rulecanvas/workbench/model-json` (`./dist/model-json.js`)

- Functions & constants: `createModelJsonCodec`, `DEFAULT_MODEL_JSON_LIMITS`, `HARD_CEILING_MODEL_JSON_LIMITS`
- Types: `ModelJsonLimits`, `ModelJsonCodecOptions`, `ModelJsonCodec`, `ModelJsonDecodeResult`, `ModelJsonEncodeResult`

## Quick Start

```ts
import { createModelJsonCodec } from '@rulecanvas/workbench/model-json';
import { createVerifyClient } from '@rulecanvas/workbench/verify';
import { installVerifyWorker } from '@rulecanvas/workbench/verify-worker';

// Inside a Web Worker entry file (no global `self` access on module import):
// installVerifyWorker(self);

const codec = createModelJsonCodec(); // defaults: 512k chars, 10k visits, depth 64, raw nesting 256
const decoded = codec.decode(rawJsonText);

if (decoded.ok) {
  const client = createVerifyClient({ execution: { kind: 'main-thread' } });
  const settlement = await client.verify(decoded.model, { maxStates: 1_000, maxDepth: 20 });
  if (settlement.kind === 'result') {
    console.log(settlement.result.status, settlement.executionMode);
  }
  client.dispose();
}
```

## Security, Protocol & Budget Details

- **Worker transport (`./verify`, `./verify-worker`)**: Factory clients are tracked via a `WeakSet` (`isFactoryVerifyClient`) and frozen; requests capture plain-data snapshots without invoking ordinary getters before posting; responses correlate `(requestId, generation)` before reading payload fields and validate/deep-freeze `VerifyResult` against the captured model and options (`VERIFY_PROTOCOL_VERSION = 1`).
- **Portable JSON codec (`./model-json`)**: Pre-scans raw JSON before `JSON.parse` to reject duplicate decoded object keys (default `duplicateKeys: 'reject'`, or opt-in `'last-value'` for legacy compatibility), non-integer decimal/exponent numbers (`NON_INTEGER_JSON_NUMBER`), and out-of-range integers (`UNSAFE_INTEGER_JSON_NUMBER`), then enforces strict field allowlists, reserved-key/accessor/cycle checks, and `@rulecanvas/core` `validateModel`.

## Limitations

- Marked `"private": true` for workspace use and verified via local tarball packing (`pnpm verify:pack`), not published to npm.
- Codec limits cannot exceed `HARD_CEILING_MODEL_JSON_LIMITS` (`maxChars: 2_000_000`, `maxVisits: 50_000`, `maxDepth: 64`, `maxRawNesting: 256`); default limits are `DEFAULT_MODEL_JSON_LIMITS` (`maxChars: 512_000`, `maxVisits: 10_000`, `maxDepth: 64`, `maxRawNesting: 256`).
