// Exercise only the real server mapper and public protobuf decoder. No native
// runtime, camera, server or SDK session is started by this regression check.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { freshRun, acceptSignal } from './public/signal-state.mjs';
const require = createRequire(import.meta.url);
const { Metrics, decodeMetrics } = require('@smartspectra/node-sdk/messages');
const code = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const start = code.indexOf('function numberOrNull(value) {');
const end = code.indexOf('async function stop()', start);
assert(start >= 0 && end > start);
const emitted = [];
const context = createContext({
  decodeMetrics, Number, validation: { code: 0 },
  relativeTime: (us) => us / 1000,
  send: (_event, data) => emitted.push(data),
});
// Evaluate the existing mapper, cache and validation handler; server startup stays outside.
runInContext(code.slice(start, end), context);
function packet(metrics, us) {
  context.signal(Metrics.encode(Metrics.fromObject(metrics)).finish(), us);
  return emitted.at(-1);
}
const initial = packet({ face: { talking: [{}] } }, 0);
assert.equal(initial.talking, false); // Native protobuf defaults restore false.
assert.equal(initial.rate, null);
packet({ breathing: { rate: [{ value: 18, confidence: 70 }] } }, 31_000_000);
const fast = packet({ breathing: { upperTrace: [{ value: .1 }] }, face: { talking: [{}] } }, 31_033_000);
assert.equal(fast.rate, 18);
assert.equal(fast.confidence, 70);
assert.equal(fast.talking, false);
assert.equal(packet({ face: { talking: [{ detected: true }] } }, 32_000_000).talking, true);
const zero = packet({ breathing: { rate: [{ value: 18 }] } }, 33_000_000);
assert.equal(zero.confidence, 0); // Explicit SDK zero replaces the prior reading.
assert.equal(zero.talking, true); // The slower packet keeps the latest face state.
assert.equal(packet({ face: { talking: [{}] } }, 33_033_000).confidence, 0);
const faceExpired = packet({ breathing: { rate: [{ value: 18, confidence: 70 }] } }, 34_034_000);
assert.equal(faceExpired.talking, null); // More than 1 s without a face update.
assert.equal(faceExpired.upperTrace, null);
const rateExpired = packet({ breathing: { upperTrace: [{ value: .2 }] }, face: { talking: [{}] } }, 44_035_000);
assert.equal(rateExpired.rate, null);
assert.equal(rateExpired.confidence, null);

context.resetSignal();
let run = freshRun('smartspectra');
run = acceptSignal(run, packet({ breathing: { rate: [{ value: 18, confidence: 70 }] }, face: { talking: [{}] } }, 50_000_000));
context.validationStatus(2, 50_100_000, 'Adjust framing.');
context.validationStatus(0, 50_200_000, 'Hold still and record.');
const recovered = packet({ breathing: { upperTrace: [{ value: .1 }] } }, 50_300_000);
assert.equal(recovered.rate, null); // The validation handler clears even without an intervening metric packet.
assert.equal(recovered.confidence, null);
assert.equal(recovered.talking, null);
run = acceptSignal(run, recovered);
for (let second = 1; second <= 31; second++) {
  run = acceptSignal(run, packet({ breathing: { upperTrace: [{ value: .1 }] } }, 50_300_000 + second * 1_000_000));
}
assert.equal(run.signal.rate, null);
assert.equal(run.signal.confidence, null);
assert.equal(run.signal.talking, null);
assert.equal(run.quietReady, false);
assert.equal(run.feedback, null);
assert.equal(run.quietReason, 'waiting-talking');
context.validationStatus(2, 82_000_000, 'Adjust framing.');
const lost = packet({ breathing: { rate: [{ value: 18, confidence: 80 }] }, face: { talking: [{}] } }, 82_033_000);
assert.equal(lost.rate, null); // Quality-loss packets also stay out of the cache.
assert.equal(lost.talking, null);
console.log('passed: sparse observations retain within source-time limits; zero confidence, field expiry and quality recovery gate readiness');
