import { describe, expect, it } from 'vitest';
import { browserSysvar, listSysvars, onSysvarChange, promptSysvar, registerSysvarCommands, setSysvarText, sysvarInfo } from '../../src/app/sysvars';
import { aliasDiff, applyAliasStore, applyAliasTable, builtinAliases, loadAliasStore, saveAliasStore, validAlias } from '../../src/app/aliasedit';
import { makeHarness } from '../cmds2/harness';

describe('시스템 변수 이름 바로 입력', () => {
  it('도면 변수: 프롬프트, 범위 검사 뒤 다시 묻기, 명령 취소 한 단계', async () => {
    const h = makeHarness((d) => d.header.set('$PDMODE', 0));
    h.app.register({ name: 'T', title: 't', run: (ctx) => promptSysvar(h.app, ctx, 'PDMODE') });
    await h.run('T', ['5', '34']);
    expect(h.prompts[0]).toBe('PDMODE에 대한 새 값 입력 <0>:');
    expect(h.printed.some((t) => t.includes('값이 맞지 않습니다'))).toBe(true);
    expect(h.doc.header.get('$PDMODE')).toBe(34);
    h.st.session.undo();
    expect(h.doc.header.get('$PDMODE')).toBe(0);
  });

  it('실수·이름·점 변수와 읽기 전용', async () => {
    const h = makeHarness((d) => {
      d.header.set('$LTSCALE', 1);
      d.header.set('$LIMMAX', { x: 420, y: 297 });
      d.header.set('$DWGCODEPAGE', 'ANSI_949');
    });
    expect(setSysvarText(h.app, 'LTSCALE', '0')).toContain('양수');
    expect(setSysvarText(h.app, 'ltscale', '2.5')).toBeNull();
    expect(h.doc.header.get('$LTSCALE')).toBe(2.5);
    expect(setSysvarText(h.app, 'CLAYER', '없는층')).toContain('없습니다');
    expect(setSysvarText(h.app, 'LIMMAX', '841,594')).toBeNull();
    expect(h.doc.header.get('$LIMMAX')).toEqual({ x: 841, y: 594 });
    expect(sysvarInfo(h.app, 'DWGCODEPAGE')?.readOnly).toBe(true);
    h.app.register({ name: 'T', title: 't', run: (ctx) => promptSysvar(h.app, ctx, 'DWGCODEPAGE') });
    await h.run('T', []);
    expect(h.printed.at(-1)).toBe('DWGCODEPAGE = "ANSI_949" (읽기 전용)');
    // 머리말에 없어도 알려진 변수는 기본값으로 보인다
    expect(sysvarInfo(h.app, 'MIRRTEXT')).toBeTruthy();
    expect(sysvarInfo(h.app, 'NOSUCHVAR')).toBeNull();
  });

  it('이 브라우저 변수: 범위, 구독, PICKBOX는 화면 선택 상자', () => {
    const h = makeHarness();
    const seen: string[] = [];
    const off = onSysvarChange((n, v) => seen.push(`${n}=${v}`));
    expect(setSysvarText(h.app, 'GRIPSIZE', '300')).toContain('1과(와) 255');
    expect(setSysvarText(h.app, 'GRIPSIZE', '7')).toBeNull();
    expect(browserSysvar('GRIPSIZE')).toBe(7);
    expect(setSysvarText(h.app, 'PICKBOX', '9')).toBeNull();
    expect(h.app.view.overlay.pickbox).toBe(9);
    off();
    expect(seen).toEqual(['GRIPSIZE=7', 'PICKBOX=9']);
    const names = listSysvars(h.app).map((v) => v.name);
    expect(names).toContain('PICKBOX');
    expect(names).toContain('LTSCALE');
  });

  it('알 수 없는 명령 고리는 변수가 아닌 이름을 넘긴다', async () => {
    const h = makeHarness();
    registerSysvarCommands(h.app);
    expect(h.app.commandFallbacks.length).toBe(1);
    expect(await h.app.commandFallbacks[0]!.run('ZZTOP')).toBe(false);
    expect(h.app.commands.has('SYSVDLG')).toBe(true);
  });
});

describe('ALIASEDIT 별칭 표', () => {
  function host() {
    const aliases = new Map<string, string>([
      ['L', 'LINE'],
      ['C', 'CIRCLE'],
    ]);
    const cmds = new Set(['LINE', 'CIRCLE', 'COPY']);
    return {
      aliases,
      aliasEntries: () => [...aliases.entries()],
      setAlias: (a: string, n: string | null) => (n === null ? aliases.delete(a) : aliases.set(a, n)),
      findCommand: (n: string) => (cmds.has(n.toUpperCase()) ? ({ name: n.toUpperCase() } as never) : undefined),
    };
  }
  it('차이 저장과 시작할 때 되살리기', () => {
    const a = host();
    const base = builtinAliases(a as never);
    const final = new Map(base);
    final.delete('C');
    final.set('CC', 'COPY');
    final.set('L', 'COPY');
    const store = aliasDiff(base, final);
    expect(store).toEqual({ set: { CC: 'COPY', L: 'COPY' }, removed: ['C'] });
    saveAliasStore(store);
    expect(loadAliasStore()).toEqual(store);
    const b = host();
    applyAliasStore(b as never, loadAliasStore());
    expect([...b.aliases].sort()).toEqual([
      ['CC', 'COPY'],
      ['L', 'COPY'],
    ]);
    // 표 그대로 맞추기
    applyAliasTable(b as never, new Map([['L', 'LINE']]));
    expect([...b.aliases]).toEqual([['L', 'LINE']]);
    saveAliasStore({ set: {}, removed: [] });
    expect(loadAliasStore()).toEqual({ set: {}, removed: [] });
  });
  it('별칭 글자 검사', () => {
    expect(validAlias('3A')).toBe(true);
    expect(validAlias('A B')).toBe(false);
    expect(validAlias('_L')).toBe(false);
  });
});
