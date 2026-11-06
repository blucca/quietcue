// Focused source-level check: a completed reflection quiet window at file EOF.
// Runs the actual controller plus the app's original EOF and stop handlers.
// DOM/API doubles keep this regression check local with zero SDK sessions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import {
  freshRun, acceptSignal, beginSpeak, turnParagraph, beginReflect, completeRun, runNotes,
} from './public/signal-state.mjs';

let fixture = freshRun('smartspectra');
const feed = (tMs, talking, rate = 14.6) => {
  fixture = acceptSignal(fixture, {
    source: 'smartspectra', tMs, rate, confidence: 0.92,
    upperTrace: 0.1, talking, validation: { code: 0, hint: 'Valid source-level fixture.' },
  });
};
for (let tMs = 0; tMs <= 30000; tMs += 200) feed(tMs, false);
fixture = beginSpeak(fixture);
assert.equal(fixture.phase, 'speak');
for (let tMs = 30200; tMs <= 40000; tMs += 200) {
  feed(tMs, tMs < 35000 || (tMs >= 36200 && tMs < 39000));
  if (tMs === 34000) fixture = turnParagraph(fixture, 0, 1);
}
fixture = beginReflect(fixture);
for (let tMs = 40200; tMs <= 70000; tMs += 200) feed(tMs, false, 13.8);
assert.equal(fixture.phase, 'reflect');
assert.equal(fixture.quietReady, true);
assert.equal(fixture.quietMs, 30000);
assert.equal(fixture.paragraphTurns.length, 1);
assert.equal(completeRun(fixture).after.rate, 13.8);

const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const extract = (from, to) => {
  const start = app.indexOf(from), end = app.indexOf(to, start);
  assert(start >= 0 && end > start);
  return app.slice(start, end);
};
let cleanupRequests = 0;
const messages = [];
const context = createContext({
  fixture, beginReflect, completeRun, runNotes,
  el: {
    'video-input': { disabled: false },
    'summary-title': { focus() {} }, 'run-summary': { scrollIntoView() {} },
  },
  inputMode: () => 'file', render() {}, stopSample() {}, announce() {},
  setError: message => messages.push(message),
  api: async path => {
    assert.equal(path, '/api/stop'); cleanupRequests++;
    return { status: 'idle', videoConfigured: true };
  },
});
runInContext(`
  let source = 'smartspectra', active = true, starting = false, ended = false;
  let run = fixture;
  let serverState = { status: 'running', videoConfigured: true };
`, context);
runInContext(extract('function handleServerState(', 'function chooseSource('), context);
runInContext(extract('async function stopNative(', 'async function viewNotes('), context);
runInContext(extract('async function viewNotes(', 'async function finishEarly('), context);
runInContext(extract('async function finishEarly(', 'async function resetRun('), context);
runInContext('handleServerState({ status: "idle", videoConfigured: true })', context);
await Promise.resolve();
const result = runInContext(`({
  phase: run.phase, quietReady: run.quietReady, quietMs: run.quietMs,
  active, ended, export: { ...runNotes(run, 'file'), status: ended ? 'ended' : 'complete' }
})`, context);
console.log(JSON.stringify({ atEof: result, cleanupRequests, message: messages[0] }, null, 2));
assert.equal(result.export.after?.rate, 13.8,
  'A valid completed 30-second reflection window must retain its after snapshot at EOF.');
assert.equal(result.phase, 'complete');
assert.equal(result.ended, false);
assert.equal(cleanupRequests, 1);
assert.equal(result.export.paragraphTurns.length, 1);

// A shorter recording retains the existing partial-note result.
context.fixture = { ...fixture, quietReady: false, quietMs: 20000, feedback: null };
runInContext(`run = fixture; active = true; ended = false; serverState.status = 'running';
  handleServerState({ status: 'idle', videoConfigured: true });`, context);
await Promise.resolve();
assert.equal(runInContext('run.phase', context), 'reflect');
assert.equal(runInContext('run.after', context), null);
assert.equal(runInContext('ended', context), true);
assert.equal(cleanupRequests, 2);
console.log('passed: completed EOF keeps both quiet snapshots; short EOF keeps partial notes; native sessions 0');
