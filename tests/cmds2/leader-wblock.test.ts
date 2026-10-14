import { describe, expect, it, vi } from 'vitest';

const downloads: string[] = [];
vi.mock('../../src/app/export', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/app/export')>();
  return { ...mod, download: (_b: Blob, name: string) => downloads.push(name) };
});

import type { BlockDef, CadDocument, MTextEntity } from '../../src/core/model';
import { entityDefaults, tableKey } from '../../src/core/model';
import { applyLeaderFormat, leaderCreationType, registerLeaderCommand } from '../../src/app/leaderold';
import { registerDashWblockCommand, wblockTarget } from '../../src/app/wblockcmd';
import { takeErased } from '../../src/app/util2-ui';
import { circle, line } from '../edit/make';
import { makeHarness, modelEntities } from './harness';

function addBlock(doc: CadDocument, name: string): void {
  const def: BlockDef = { name, handle: 'C1', recordHandle: 'C2', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [{ ...line(0, 0, 1, 1), owner: 'C2' }] };
  doc.blocks.set(tableKey(name), def);
  doc.blockRecords.set(tableKey(name), { name, handle: 'C2', flags: 0, insertUnits: 0, explodable: true, scalable: true });
}

describe('LEADER', () => {
  it('형식 옵션과 주석 종류', () => {
    expect(applyLeaderFormat({ spline: false, arrow: true }, 'S')).toEqual({ spline: true, arrow: true });
    expect(applyLeaderFormat({ spline: true, arrow: true }, 'st')).toEqual({ spline: false, arrow: true });
    expect(applyLeaderFormat({ spline: false, arrow: true }, 'N')).toEqual({ spline: false, arrow: false });
    expect(leaderCreationType(null)).toBe(3);
    expect(leaderCreationType({ type: 'MTEXT' } as never)).toBe(0);
    expect(leaderCreationType({ type: 'TOLERANCE' } as never)).toBe(1);
    expect(leaderCreationType({ type: 'INSERT' } as never)).toBe(2);
  });

  it('점 → Enter(주석) → 문자 두 줄: 여러 줄 문자와 연결, 가파르면 갈고리선', async () => {
    const h = makeHarness();
    registerLeaderCommand(h.app);
    await h.run('LEADER', ['0,0', '10,10', '', 'Hello', 'World', '']);
    const [ld] = modelEntities(h.doc, 'LEADER');
    const [mt] = modelEntities(h.doc, 'MTEXT');
    expect(mt!.text).toBe('Hello\\PWorld');
    expect(ld!.annotation).toBe(mt!.handle);
    expect(mt!.reactors).toEqual([ld!.handle]);
    expect(ld!.creation).toBe(0);
    expect(ld!.hookline).toBe(true);
    expect(ld!.vertices.length).toBe(3);
    expect(ld!.arrowHead).toBe(true);
    expect(h.prompts.slice(0, 5)).toEqual([
      '지시선 시작점 지정:',
      '다음 점 지정:',
      '다음 점 지정 또는 [주석(A)/형식(F)/명령 취소(U)] <주석>:',
      '주석 문자의 첫 번째 행 입력 또는 <옵션>:',
      '주석 문자의 다음 행 입력:',
    ]);
  });

  it('형식(F) 스플라인·없음, 명령 취소(U), 주석 없음(N)', async () => {
    const h = makeHarness();
    registerLeaderCommand(h.app);
    await h.run('LEADER', ['0,0', '5,0', 'F', 'S', '10,5', 'F', 'N', 'U', '12,3', 'A', '', 'N']);
    const [ld] = modelEntities(h.doc, 'LEADER');
    expect(ld!.pathType).toBe(1);
    expect(ld!.arrowHead).toBe(false);
    expect(ld!.vertices.map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [5, 0],
      [12, 3],
    ]);
    expect(ld!.annotation).toBeUndefined();
    expect(ld!.creation).toBe(3);
    expect(h.prompts).toContain('지시선 형식 옵션 입력 [스플라인(S)/직선(ST)/화살표(A)/없음(N)] <종료>:');
    expect(h.prompts).toContain('주석 옵션 입력 [공차(T)/복사(C)/블록(B)/없음(N)/여러 줄 문자(M)] <여러 줄 문자>:');
  });

  it('복사(C): 여러 줄 문자를 복사해 잇는다, 블록(B): 참조를 끝점에', async () => {
    const h = makeHarness((doc) => addBlock(doc, 'TAG'));
    registerLeaderCommand(h.app);
    const src: MTextEntity = { ...entityDefaults(), type: 'MTEXT', handle: '', insert: { x: 50, y: 50, z: 0 }, height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text: 'NOTE', style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 };
    const s = h.add(src);
    await h.run('LEADER', ['0,0', '10,0', '', '', 'C', { pick: s.handle, at: [50, 50] }]);
    const mts = modelEntities(h.doc, 'MTEXT');
    expect(mts.length).toBe(2);
    const copy = mts.find((m) => m.handle !== s.handle)!;
    const [ld] = modelEntities(h.doc, 'LEADER');
    expect(ld!.annotation).toBe(copy.handle);
    expect(copy.insert.x).toBeGreaterThan(10);
    await h.run('LEADER', ['0,20', '10,30', '', '', 'B', '?', 'TAG', '', '2', '', '']);
    const [ins] = modelEntities(h.doc, 'INSERT');
    expect(ins!.block).toBe('TAG');
    expect([ins!.insert.x, ins!.insert.y]).toEqual([10, 30]);
    expect(ins!.scale).toEqual({ x: 2, y: 2, z: 1 });
    const ld2 = modelEntities(h.doc, 'LEADER')[1]!;
    expect(ld2.annotation).toBe(ins!.handle);
    expect(ld2.creation).toBe(2);
    expect(ld2.hookline).toBe(false);
  });
});

describe('-WBLOCK', () => {
  const withEngine = (h: ReturnType<typeof makeHarness>) => {
    const saved: { format: string; version: string; doc: CadDocument }[] = [];
    let last: CadDocument | null = null;
    (h.app as unknown as { engine: unknown }).engine = {
      adopt: async (_n: string, doc: CadDocument) => {
        last = doc;
        return { docId: 7 };
      },
      save: async (_id: number, format: string, version: string) => {
        saved.push({ format, version, doc: last! });
        return { data: new Uint8Array(2048), warnings: [] };
      },
      closeDoc: () => {},
    };
    return saved;
  };

  it('파일 이름 → 형식', () => {
    expect(wblockTarget('part')).toMatchObject({ fileName: 'part.dwg', format: 'dwg', version: 'AC1032' });
    expect(wblockTarget('"C:\\dir\\part.DXF"')).toMatchObject({ fileName: 'part.dxf', base: 'part', format: 'dxf' });
    expect(wblockTarget('a*b')).toBeNull();
  });

  it('객체: 기준점·객체 선택 → 내려받기, 고른 객체는 지운다(OOPS)', async () => {
    // 객체 WBLOCK은 배치 목록 순서로 객체를 모은다(모형 배치)
    const h = makeHarness((doc) => doc.layouts.push({ name: 'Model', blockName: '*Model_Space', tabOrder: 0 } as never));
    registerDashWblockCommand(h.app);
    const saved = withEngine(h);
    const a = h.add(line(10, 10, 20, 10));
    const b = h.add(circle(15, 15, 2));
    h.add(line(0, 0, 1, 1));
    await h.run('-WBLOCK', ['part.dxf', '', '10,10', { sel: [a.handle, b.handle] }]);
    expect(saved[0]).toMatchObject({ format: 'dxf', version: 'AC1032' });
    expect(downloads.at(-1)).toBe('part.dxf');
    // 새 도면: 기준점이 원점
    const ms = saved[0]!.doc.blocks.get('*MODEL_SPACE')!.entities;
    expect(ms.length).toBe(2);
    expect(ms.some((e) => e.type === 'LINE' && e.start.x === 0 && e.start.y === 0)).toBe(true);
    expect(h.doc.entityIndex.has(a.handle)).toBe(false);
    expect(h.doc.entityIndex.has(b.handle)).toBe(false);
    expect(modelEntities(h.doc, 'LINE').length).toBe(1);
    expect(takeErased(h.st)?.length).toBe(2);
    expect(h.prompts).toEqual(['파일 이름 입력 <new block>:', '기존 블록 이름 입력 또는 [= (블록=출력 파일)/* (전체 도면)] <객체 선택 지정>:', '삽입 기준점 지정:', '객체 선택:']);
  });

  it('= (블록=출력 파일), * (전체 도면), 블록 이름, 없는 블록', async () => {
    const h = makeHarness((doc) => addBlock(doc, 'BOLT'));
    registerDashWblockCommand(h.app);
    const saved = withEngine(h);
    h.add(line(0, 0, 5, 5));
    await h.run('-WBLOCK', ['BOLT', '=']);
    expect(downloads.at(-1)).toBe('BOLT.dwg');
    expect(saved.at(-1)!.doc.blocks.has('BOLT')).toBe(false);
    await h.run('-WBLOCK', ['', '*']);
    expect(downloads.at(-1)).toBe('new block.dwg');
    await h.run('-WBLOCK', ['x', 'NONE', 'bolt']);
    expect(h.printed).toContain('블록 "NONE"을(를) 찾을 수 없습니다.');
    expect(downloads.at(-1)).toBe('x.dwg');
    await h.run('-WBLOCK', ['missing', '=']);
    expect(h.printed).toContain('블록 "missing"을(를) 찾을 수 없습니다.');
    // 블록·전체 도면은 아무것도 지우지 않는다
    expect(modelEntities(h.doc, 'LINE').length).toBe(1);
  });
});
