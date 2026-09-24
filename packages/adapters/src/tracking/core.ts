// M9 — browser-safe subset of the tracking adapters (no node: imports): the normalised types,
// check digits and the status state machine. Published as `@harbour/adapters/tracking/core` so
// the web app's client bundle (validators, timeline, route components) never pulls in the
// node-only adapters (`node:fs` in the rate sheet, `node:crypto` in the providers).
export * from './types.js';
export * from './check-digits.js';
export * from './state-machine.js';
