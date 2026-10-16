import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const output = readFileSync(process.argv[2], 'utf8');
// The CLI echoes submitted code even when a modal pauses it. Only its actual
// return value proves that every awaited browser assertion completed.
assert(!/^### Error/m.test(output), 'Browser execution failed');
assert(/^### Result\n"MOBILE_BROWSER_CHECK_PASSED"\s*$/m.test(output), 'Browser flow did not complete');
