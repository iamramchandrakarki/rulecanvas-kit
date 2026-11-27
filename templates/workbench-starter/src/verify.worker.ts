import { installVerifyWorker, type VerifyWorkerPort } from '@rulecanvas/workbench/verify-worker';

// A dedicated worker scope matches VerifyWorkerPort (onmessage + postMessage). The DOM
// lib types `self` as Window, whose postMessage signature differs, so narrow it here.
installVerifyWorker(self as unknown as VerifyWorkerPort);
