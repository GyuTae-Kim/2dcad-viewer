// 개발용: 헤드리스 Chrome(CDP)으로 페이지를 열고, 조건이 참이 될 때까지 기다린 뒤 화면을 찍는다.
// 사용법: node scripts/dev/shot.mjs URL 출력.png [조건 JS] [추가 JS] [폭x높이]
//   예: node scripts/dev/shot.mjs "http://localhost:4361/?sample" out.png "window.opencad?.active" "" 1400x900
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , url, out, cond = 'document.readyState === "complete"', extra = '', size = '1400x900'] = process.argv;
const [W, H] = size.split('x').map(Number);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'opencad-shot-'));
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
  } catch {
    /* 아직 */
  }
}
if (!wsUrl) {
  proc.kill();
  rmSync(profile, { recursive: true, force: true });
  throw new Error('Chrome에 연결하지 못했습니다');
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
let ok = false;
for (let i = 0; i < 150; i++) {
  await sleep(200);
  try {
    if (await evaluate(`!!(${cond})`)) {
      ok = true;
      break;
    }
  } catch {
    /* 페이지 로딩 중 */
  }
}
if (extra) {
  const r = await evaluate(`(async () => { ${extra} })()`);
  if (r !== undefined) console.log('result:', JSON.stringify(r));
}
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(ok ? 'ok' : 'timeout', out);
for (const l of logs.slice(-20)) console.log(l);
ws.close();
proc.kill();
// Chrome이 프로필을 놓을 때까지 잠깐 기다렸다가 지운다(한 번에 수백 MB)
await sleep(300);
rmSync(profile, { recursive: true, force: true });
