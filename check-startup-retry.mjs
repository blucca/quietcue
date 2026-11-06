// Exercise the real start/stop path with the SDK's documented synchronous
// input-start failure. The SDK double starts zero native sessions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

let attempts = 0, destroyed = 0;
class SDKDouble {
  on() { return this; }
  useCamera() {}
  start() { if (++attempts === 1) throw new Error('camera start failed'); }
  async destroy() { destroyed++; }
}
const context = createContext({
  process: { env: { SMARTSPECTRA_API_KEY: 'local-check' } },
  existsSync: () => false,
  SmartSpectraSDK: SDKDouble,
  CameraSelection: { default: 'default' },
  MetricType: { CHEST_BREATHING: 1, BREATHING_RATE: 2, TALKING: 3 },
});
const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const apiKey =');
const end = source.indexOf('const mime =');
assert(start >= 0 && end > start);
runInContext(source.slice(start, end), context);
await assert.rejects(runInContext('start("camera", true)', context), /camera start failed/);
assert.equal(runInContext('state.status', context), 'idle');
assert.equal(runInContext('sdk', context), null);
assert.equal(destroyed, 1);
await runInContext('start("camera", true)', context);
assert.equal(attempts, 2);
await runInContext('stop()', context);
assert.equal(destroyed, 2);
console.log('passed: failed input released, original error retained, same-process retry accepted; native sessions 0');
