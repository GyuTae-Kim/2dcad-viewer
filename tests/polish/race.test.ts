/**
 * 명령 시작 경합(진짜 App): 앞 명령을 취소하자마자 같은 틱에 다른 명령을 시작하면, 앞 명령의 정리(finally)가 마이크로태스크
 * 뒤에 와서 새 명령의 입력 요청·프롬프트를 지웠다(Express Tools 자동 입력에서 발견). 정리는 자기 것만 지워야 한다.
 * 스크립트 실행기(src/app/script.ts)가 명령을 빠르게 넣을 때도 같다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PointResult } from '../../src/app/app';
import { runScriptText, scriptRunner } from '../../src/app/script';
import { browserGlobals } from './fakes';
import { makeApp, settle } from './real-app';

vi.mock('../../src/app/view', async (orig) => ({ ...(await orig<object>()), CadView: (await import('./fakes')).FakeView }));
vi.mock('../../src/app/commandline', async (orig) => ({ ...(await orig<object>()), CommandLine: (await import('./fakes')).FakeCommandLine }));
vi.mock('../../src/app/engine', async (orig) => ({ ...(await orig<object>()), EngineClient: (await import('./fakes')).FakeEngine }));
vi.mock('../../src/text/fonts', async (orig) => ({ ...(await orig<object>()), OutlineLibrary: (await import('./fakes')).FakeFonts }));

beforeAll(() => {
  const g = browserGlobals();
  vi.stubGlobal('window', g.window);
  vi.stubGlobal('document', g.document);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** 점 하나를 묻는 명령들: AAA·BBB, 받은 답을 모은다 */
function withCommands() {
  const h = makeApp();
  const got: { cmd: string; r: PointResult }[] = [];
  const ask = (name: string) =>
    h.app.register({
      name,
      title: name,
      async run(ctx) {
        got.push({ cmd: name, r: await ctx.getPoint(`${name} 점:`) });
      },
    });
  ask('AAA');
  ask('BBB');
  return { ...h, got };
}

describe('명령 시작 경합', () => {
  it('Esc(취소) 직후 같은 틱에 새 명령을 시작해도 새 명령의 입력 요청·프롬프트가 남는다', async () => {
    const h = withCommands();
    void h.app.run('AAA');
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('AAA 점:');
    h.app.cancel();
    void h.app.run('BBB');
    await settle();
    expect(h.app.busyCommand).toBe('BBB');
    expect(h.app.pendingInput?.prompt).toBe('BBB 점:');
    expect(h.cmd.prompt).toBe('BBB 점:');
    h.app.submitInput('3,4');
    await settle();
    expect(h.got).toEqual([{ cmd: 'BBB', r: { point: { x: 3, y: 4 }, snap: null } }]);
    expect(h.app.busyCommand).toBeNull();
    expect(h.app.pendingInput).toBeNull();
    expect(h.cmd.prompt).toBe('');
    expect(h.out()).toContain('*취소*');
  });

  it('입력을 기다리는 명령 위에서 다른 명령을 시작하면(리본 단추) 앞 명령은 취소되고 새 명령이 입력을 받는다', async () => {
    const h = withCommands();
    void h.app.run('AAA');
    await settle();
    void h.app.run('BBB');
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('BBB 점:');
    h.app.submitInput('1,2');
    await settle();
    expect(h.got.map((g) => g.cmd)).toEqual(['BBB']);
    expect(h.out().filter((t) => t === '*취소*').length).toBe(1);
  });

  it('취소를 잡고 더 묻는 앞 명령은 새 명령의 요청을 빼앗지 못한다(곧바로 취소된다)', async () => {
    const h = withCommands();
    const asked: string[] = [];
    h.app.register({
      name: 'STUBBORN',
      title: 'x',
      async run(ctx) {
        try {
          await ctx.getPoint('첫 점:');
        } catch {
          asked.push('잡음');
        }
        await ctx.getPoint('둘째 점:');
        asked.push('둘째를 받음');
      },
    });
    void h.app.run('STUBBORN');
    await settle();
    void h.app.run('BBB');
    await settle();
    expect(asked).toEqual(['잡음']);
    expect(h.app.pendingInput?.prompt).toBe('BBB 점:');
    expect(h.app.busyCommand).toBe('BBB');
  });

  it('투명 명령이 묻는 중에 새 명령을 시작하면 바깥 명령의 요청을 되돌려 놓지 않는다', async () => {
    const h = withCommands();
    h.app.register({
      name: 'TTT',
      title: 't',
      transparent: true,
      async run(ctx) {
        await ctx.getPoint('TTT 점:');
      },
    });
    void h.app.run('AAA');
    await settle();
    h.app.submitInput("'TTT");
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('TTT 점:');
    void h.app.run('BBB');
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('BBB 점:');
    expect(h.cmd.prompt).toBe('BBB 점:');
  });

  it('투명 명령이 끝나면 바깥 명령의 요청으로 돌아간다(그대로)', async () => {
    const h = withCommands();
    h.app.register({
      name: 'TTT',
      title: 't',
      transparent: true,
      async run(ctx) {
        await ctx.getPoint('TTT 점:');
      },
    });
    void h.app.run('AAA');
    await settle();
    h.app.submitInput("'TTT");
    await settle();
    h.app.submitInput('9,9');
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('AAA 점:');
    expect(h.cmd.prompt).toBe('AAA 점:');
    // Esc는 투명 명령만 취소한다
    h.app.submitInput("'TTT");
    await settle();
    h.app.cancel();
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('AAA 점:');
    h.app.submitInput('5,5');
    await settle();
    expect(h.got).toEqual([{ cmd: 'AAA', r: { point: { x: 5, y: 5 }, snap: null } }]);
  });

  it('명령이 끝나면서 다른 명령을 시작해도(연결 명령) 그 명령의 입력이 남는다', async () => {
    const h = withCommands();
    h.app.register({
      name: 'CHAIN',
      title: 'c',
      run() {
        void h.app.run('BBB');
      },
    });
    void h.app.run('CHAIN');
    await settle();
    expect(h.app.busyCommand).toBe('BBB');
    expect(h.app.pendingInput?.prompt).toBe('BBB 점:');
    expect(h.cmd.prompt).toBe('BBB 점:');
  });

  it('미리보기·추적 표시는 새 명령이 이어받을 때 지우고, 앞 명령의 정리가 새 명령의 것을 지우지 않는다', async () => {
    const h = withCommands();
    void h.app.run('AAA');
    await settle();
    h.view.overlay.rubber = [{ pts: [0, 0, 1, 1] }];
    h.view.overlay.marks = [{}];
    h.app.cancel();
    void h.app.run('BBB');
    // 이어받는 순간 앞 명령의 미리보기는 지운다
    expect(h.view.overlay.rubber).toEqual([]);
    expect(h.view.overlay.marks).toEqual([]);
    h.view.overlay.marks = [{ mine: 'BBB' }];
    await settle();
    expect(h.view.overlay.marks).toEqual([{ mine: 'BBB' }]);
    expect(h.view.overlay.tip).toBe('BBB 점');
  });

  it('보통 명령의 정리는 그대로: 끝나면 요청·프롬프트·미리보기를 지운다', async () => {
    const h = withCommands();
    void h.app.run('AAA');
    await settle();
    h.view.overlay.marks = [{}];
    h.app.submitInput('1,1');
    await settle();
    expect(h.app.busyCommand).toBeNull();
    expect(h.app.pendingInput).toBeNull();
    expect(h.cmd.prompt).toBe('');
    expect(h.view.overlay.marks).toEqual([]);
    expect(h.view.overlay.tip).toBeNull();
    // 입력 없이 Esc
    void h.app.run('AAA');
    await settle();
    h.app.cancel();
    await settle();
    expect(h.app.busyCommand).toBeNull();
    expect(h.app.pendingInput).toBeNull();
  });
});

describe('스크립트 실행기가 빠르게 명령을 넣을 때', () => {
  async function script(h: ReturnType<typeof withCommands>, text: string): Promise<string> {
    const runner = scriptRunner(h.app);
    const done = new Promise<string>((resolve) => {
      runner.onStop = (s, why) => resolve(`${s}:${why}`);
    });
    runScriptText(h.app, 'race.scr', text);
    // 경합이 있으면 실행기가 입력을 기다리는 명령을 영영 못 찾는다(바쁨) — 시간 제한으로 실패를 알린다
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('시간 초과'), 1500));
    const r = await Promise.race([done, timeout]);
    if (r === '시간 초과') runner.interrupt?.();
    return r;
  }

  it('명령이 다른 명령을 이어 시작해도 다음 줄이 그 명령의 입력으로 간다', async () => {
    const h = withCommands();
    h.app.register({
      name: 'CHAIN',
      title: 'c',
      run() {
        void h.app.run('BBB');
      },
    });
    expect(await script(h, 'CHAIN\n5,6\nAAA\n7,8\n')).toBe('idle:end');
    expect(h.got).toEqual([
      { cmd: 'BBB', r: { point: { x: 5, y: 6 }, snap: null } },
      { cmd: 'AAA', r: { point: { x: 7, y: 8 }, snap: null } },
    ]);
    expect(h.app.busyCommand).toBeNull();
  });

  it('명령을 연달아 넣어도(앞 명령이 끝나자마자 다음 명령) 입력이 어긋나지 않는다', async () => {
    const h = withCommands();
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(i % 2 ? 'AAA' : 'BBB', `${i},${i}`);
    expect(await script(h, lines.join('\n') + '\n')).toBe('idle:end');
    expect(h.got.length).toBe(20);
    h.got.forEach((g, i) => {
      expect(g.cmd).toBe(i % 2 ? 'AAA' : 'BBB');
      expect(g.r).toEqual({ point: { x: i, y: i }, snap: null });
    });
  });
});
