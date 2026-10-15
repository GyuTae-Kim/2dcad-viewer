import { describe, expect, it } from 'vitest';
import type { AttribEntity, CadDocument, Entity, InsertEntity } from '../../src/core/model';
import { entityDefaults, tableKey } from '../../src/core/model';
import { registerDrawCommands } from '../../src/app/draw';
import { registerBlockCommands } from '../../src/app/blocks';
import { registerTableCommands } from '../../src/app/tables';
import { registerDashCommands } from '../../src/app/dashcmds';
import { scriptRunner } from '../../src/app/script';
import { makeScriptApp, type ScriptApp } from './app';

let hs = 0xf000;
const H = () => (hs++).toString(16).toUpperCase();

/** 블록 DOOR: 선 하나와 속성 NUM(프롬프트 "번호", 기본값 D1) */
function addDoor(doc: CadDocument): void {
  const rec = H();
  const line = { ...entityDefaults(), type: 'LINE', handle: H(), start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } as Entity;
  const att = {
    ...entityDefaults(),
    type: 'ATTDEF',
    handle: H(),
    insert: { x: 0, y: 2, z: 0 },
    height: 1,
    text: 'D1',
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    style: 'Standard',
    generation: 0,
    halign: 0,
    valign: 0,
    tag: 'NUM',
    prompt: '번호',
    attFlags: 0,
  } as unknown as Entity;
  doc.blockRecords.set('DOOR', { name: 'DOOR', handle: rec, flags: 0, insertUnits: 0, explodable: true, scalable: true } as never);
  doc.blocks.set('DOOR', { name: 'DOOR', handle: H(), recordHandle: rec, basePoint: { x: 0, y: 0, z: 0 }, flags: 2, entities: [line, att] });
}

function setup(extra?: (doc: CadDocument) => void): ScriptApp {
  const h = makeScriptApp((doc) => {
    addDoor(doc);
    extra?.(doc);
  });
  registerDrawCommands(h.app);
  registerBlockCommands(h.app);
  registerTableCommands(h.app);
  registerDashCommands(h.app);
  return h;
}

const makeScriptPlot = () => setup();

const line = (x0: number, y0: number, x1: number, y1: number) => ({ ...entityDefaults(), type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;

describe('SCRIPT 통합: 선·원·블록 삽입·해치', () => {
  it('짧은 .scr로 객체를 만들고, 명령 취소 한 번으로 모두 되돌린다', async () => {
    const h = setup();
    const depth0 = h.st.session.depth;
    const scr = [
      '; 선·원·블록·해치',
      'LINE 0,0 100,0 100,100 0,100 C',
      'CIRCLE 50,50 10',
      '-INSERT DOOR 20,20 2  45',
      'A-12',
      '-HATCH P ANSI31 2 0 20,80',
      '',
      '',
    ].join('\n');
    expect(await h.script(scr)).toBe('idle');
    expect(h.errors()).toEqual([]);
    expect(h.model('LINE')).toHaveLength(4);
    expect(h.model('CIRCLE')[0]).toMatchObject({ radius: 10, center: { x: 50, y: 50 } });
    const ins = h.model('INSERT')[0] as InsertEntity;
    expect(ins.block).toBe('DOOR');
    expect(ins.scale).toEqual({ x: 2, y: 2, z: 2 });
    expect(ins.rotation).toBeCloseTo(Math.PI / 4);
    expect(ins.insert.x).toBeCloseTo(20);
    expect((ins.attribs[0] as AttribEntity).text).toBe('A-12');
    const hatch = h.model('HATCH')[0]!;
    expect(hatch.patternName).toBe('ANSI31');
    expect(hatch.patternScale).toBe(2);
    expect(hatch.paths).toHaveLength(2); // 바깥 사각형 + 원(섬)
    // 스크립트 한 번 = 명령 취소 한 번
    expect(h.st.session.depth).toBe(depth0 + 1);
    h.st.session.undo();
    expect(h.model('LINE')).toHaveLength(0);
    expect(h.model('INSERT')).toHaveLength(0);
    expect(h.model('HATCH')).toHaveLength(0);
  });

  it('문자 프롬프트는 줄 끝까지(공백 포함), 빈 줄로 TEXT를 끝낸다', async () => {
    const h = setup();
    expect(await h.script('TEXT 0,0 2.5 0 Hello  world\n\n')).toBe('idle');
    expect(h.model('TEXT')[0]).toMatchObject({ text: 'Hello  world', height: 2.5 });
  });

  it('주석·빈 줄 Enter(직전 명령 반복)·_ . 접두어·국제 키워드', async () => {
    const h = setup();
    const scr = '; 원 두 개\n_CIRCLE 0,0 5\n\n0,0 10\n._LINE 0,0 10,0 _U 20,0\n\n';
    expect(await h.script(scr)).toBe('idle');
    expect(h.model('CIRCLE').map((c) => c.radius)).toEqual([5, 10]);
    const lines = h.model('LINE');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 20, y: 0 } });
  });

  it('명령이 아닌 도면 변수는 SETVAR로', async () => {
    const h = setup();
    expect(await h.script('PDMODE 3\n')).toBe('idle');
    expect(h.doc.header.get('$PDMODE')).toBe(3);
  });

  it('스크립트에서는 대화상자 명령 대신 명령행 버전(INSERT → -INSERT, ATTREQ 0)', async () => {
    const h = setup((doc) => doc.header.set('$ATTREQ', 0));
    expect(await h.script('INSERT DOOR 5,5 1 1 0\n')).toBe('idle');
    const ins = h.model('INSERT')[0] as InsertEntity;
    expect(ins.insert).toMatchObject({ x: 5, y: 5 });
    expect(ins.attribs[0]!.text).toBe('D1');
  });
});

describe('SCRIPT 멈춤·이어서·처음부터', () => {
  it('알 수 없는 명령에서 멈추고 줄 번호를 알린다. RESUME으로 이어서', async () => {
    const h = setup();
    expect(await h.script('CIRCLE 0,0 5\nFOO\nCIRCLE 0,0 6\n')).toBe('paused');
    expect(h.errors().join('\n')).toContain('2번째 줄 "FOO"');
    expect(h.model('CIRCLE')).toHaveLength(1);
    const runner = scriptRunner(h.app);
    const done = new Promise((r) => (runner.onStop = (s) => r(s)));
    expect(runner.resume()).toBe(true);
    expect(await done).toBe('idle');
    expect(h.model('CIRCLE').map((c) => c.radius)).toEqual([5, 6]);
  });

  it('잘못된 입력에서 멈춘다(명령의 오류 출력)', async () => {
    const h = setup();
    expect(await h.script('CIRCLE 0,0 5\nLINE abc\n')).toBe('paused');
    expect(h.errors().some((e) => e.includes('2번째 줄 "abc"'))).toBe(true);
  });

  it('AutoLISP 식은 안내하고 멈춘다', async () => {
    const h = setup();
    expect(await h.script('(command "line")\n')).toBe('paused');
    expect(h.errors().join()).toContain('AutoLISP');
  });

  it('RSCRIPT는 처음부터 되풀이하고, 멈춤(Esc)으로 끝낸다', async () => {
    const h = setup();
    const runner = scriptRunner(h.app);
    const stopped = h.script('CIRCLE 0,0 1\nDELAY 5\nRSCRIPT\n');
    await new Promise((r) => setTimeout(r, 120));
    runner.interrupt();
    expect(await stopped).toBe('paused');
    expect(h.model('CIRCLE').length).toBeGreaterThanOrEqual(2);
    expect(h.out()).toContain('RESUME');
  });

  it('SCRIPT 안의 SCRIPT는 이번 세션에서 연 스크립트를 이름으로 이어 실행한다', async () => {
    const h = setup();
    expect(await h.script('CIRCLE 0,0 1\n', 'one.scr')).toBe('idle');
    expect(await h.script('CIRCLE 0,0 2\nSCRIPT one\n', 'two.scr')).toBe('idle');
    expect(h.model('CIRCLE').map((c) => c.radius)).toEqual([1, 2, 1]);
  });
});

describe('스크립트 객체 선택', () => {
  it('W 창 선택 → 클래식 직사각형 배열', async () => {
    const h = setup();
    h.add(line(0, 0, 10, 0));
    expect(await h.script('-ARRAY W -1,-1 11,1  R 2 3 10 20\n')).toBe('idle');
    const ls = h.model('LINE');
    expect(ls).toHaveLength(6);
    expect(ls.some((l) => l.type === 'LINE' && l.start.x === 40 && l.start.y === 10)).toBe(true);
  });

  it('점 선택·마지막(L) → 원형 배열(회전)', async () => {
    const h = setup();
    h.add(line(10, 0, 20, 0));
    expect(await h.script('-ARRAY 15,0  P 0,0 4 360 Y\n')).toBe('idle');
    const ls = h.model('LINE');
    expect(ls).toHaveLength(4);
    expect(ls.some((l) => l.type === 'LINE' && Math.abs(l.start.x) < 1e-9 && Math.abs(l.start.y - 10) < 1e-9)).toBe(true);
    expect(await h.script('-ARRAY L  P 0,0  90 30 N\n')).toBe('idle');
    expect(h.model('LINE')).toHaveLength(7);
  });
});

describe('명령행 버전 명령', () => {
  it('-INSERT: *이름은 분해, ?는 목록, 없는 블록·파일 이름은 안내', async () => {
    const h = setup();
    // ? 목록 뒤에는 블록 이름을 다시 묻는다(AutoCAD와 같다)
    const r = await h.script('-INSERT ? *\n*DOOR 0,0 1 0\n');
    expect(h.errors()).toEqual([]);
    expect(r).toBe('idle');
    expect(h.out()).toContain('"DOOR"');
    expect(h.model('INSERT')).toHaveLength(0);
    expect(h.model('LINE').length).toBeGreaterThanOrEqual(1);
    expect(await h.script('-INSERT NOPE\n')).toBe('paused');
    expect(await h.script('-INSERT A=C:\\a.dwg\n')).toBe('paused');
    expect(h.errors().join()).toContain('블록이름=파일');
  });

  it('-INSERT: 축척(S)·회전(R) 미리 지정, 반대 구석 축척', async () => {
    const h = setup((doc) => doc.header.set('$ATTREQ', 0));
    expect(await h.script('-INSERT DOOR S 3 R 90 0,0\n-INSERT DOOR 10,10 14,12 0\n')).toBe('idle');
    const [a, b] = h.model('INSERT') as InsertEntity[];
    expect(a!.scale).toEqual({ x: 3, y: 3, z: 3 });
    expect(a!.rotation).toBeCloseTo(Math.PI / 2);
    expect(b!.scale).toEqual({ x: 4, y: 2, z: 4 });
  });

  it('-ATTEDIT 전역: 문자열 바꾸기', async () => {
    const h = setup();
    expect(await h.script('-INSERT DOOR 0,0 1 1 0\nA-12\n-ATTEDIT N N DOOR NUM *\nA-\nB-\n')).toBe('idle');
    expect((h.model('INSERT')[0] as InsertEntity).attribs[0]!.text).toBe('B-12');
  });

  it('-ATTEDIT 개별: 값(V) 대치·높이(H)', async () => {
    const h = setup();
    expect(await h.script('-INSERT DOOR 0,0 1 1 0\nX1\n-ATTEDIT Y * * * L  V R\nX9\nH 2 N\n')).toBe('idle');
    const a = (h.model('INSERT')[0] as InsertEntity).attribs[0]!;
    expect(a.text).toBe('X9');
    expect(a.height).toBe(2);
  });

  it('-BOUNDARY: 닫힌 영역 안 점 → 폴리선', async () => {
    const h = setup();
    for (const [a, b, c, d] of [
      [0, 0, 10, 0],
      [10, 0, 10, 10],
      [10, 10, 0, 10],
      [0, 10, 0, 0],
    ] as const)
      h.add(line(a, b, c, d));
    expect(await h.script('-BOUNDARY 5,5\n\n')).toBe('idle');
    expect(h.model('LWPOLYLINE')).toHaveLength(1);
  });

  it('-HATCH: 객체 선택(S)·사용자 정의(U)·도면층(LA)·개별 해치(A H)', async () => {
    const h = setup((doc) => doc.layers.set('HAT', { ...structuredClone(doc.layers.get('0')!), name: 'HAT', handle: 'FF01' }));
    h.add({ ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 5 } as Entity);
    h.add({ ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x: 20, y: 0, z: 0 }, radius: 5 } as Entity);
    expect(await h.script('-HATCH P U 45 1 Y LA HAT A H Y  S ALL  \n\n')).toBe('idle');
    const hs = h.model('HATCH');
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ patternName: '_USER', patternDouble: true, layer: 'HAT' });
  });

  it('-PURGE: 도면층·블록(확인)·0 길이 형상·빈 문자', async () => {
    const h = setup((doc) => {
      doc.layers.set('TEMP', { ...structuredClone(doc.layers.get('0')!), name: 'TEMP', handle: 'FF02' });
    });
    h.add(line(1, 1, 1, 1));
    h.add({ ...entityDefaults(), type: 'TEXT', handle: '', insert: { x: 0, y: 0, z: 0 }, height: 1, text: '  ', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0 } as Entity);
    expect(await h.script('-PURGE LA * N\n-PURGE B DOOR Y Y\n-PURGE Z\n-PURGE E\n')).toBe('idle');
    expect(h.doc.layers.has('TEMP')).toBe(false);
    expect(h.doc.blocks.has('DOOR')).toBe(false);
    expect(h.model('LINE')).toHaveLength(0);
    expect(h.model('TEXT')).toHaveLength(0);
    expect(h.prompts).toContain('블록 "DOOR"을(를) 소거하시겠습니까? [예(Y)/아니오(N)] <아니오>:');
  });

  it('-STYLE: 새 스타일(SHX, 거꾸로) → 현재 스타일', async () => {
    const h = setup();
    expect(await h.script('-STYLE Notes romans.shx 0 0.8 15 N Y N\n')).toBe('idle');
    const s = h.doc.textStyles.get('NOTES')!;
    expect(s).toMatchObject({ font: 'romans.shx', widthFactor: 0.8, generation: 4 });
    expect(s.oblique).toBeCloseTo((15 * Math.PI) / 180);
    expect(h.doc.header.get('$TEXTSTYLE')).toBe('Notes');
    // 트루타입은 수직을 묻지 않는다
    expect(await h.script('-STYLE Notes "Times New Roman" 2.5 1 0 N N\n')).toBe('idle');
    expect(h.doc.textStyles.get('NOTES')).toMatchObject({ font: 'times.ttf', fontFamily: 'Times New Roman', height: 2.5, generation: 0 });
  });

  it('-LINETYPE: 로드(L, 스크립트는 파일 이름을 묻는다)·설정(S)', async () => {
    const h = setup();
    expect(await h.script('-LINETYPE L DASHED,HIDDEN acadiso.lin S DASHED\n\n')).toBe('idle');
    expect(h.doc.linetypes.has('DASHED')).toBe(true);
    expect(h.doc.linetypes.has('HIDDEN')).toBe(true);
    expect(h.doc.header.get('$CELTYPE')).toBe('DASHED');
    expect(await h.script('-LINETYPE S NOPE\n')).toBe('paused');
  });

  it('-UNITS: 건축 단위·분모 16·도분초·0도 방향·시계 방향', async () => {
    const h = setup();
    expect(await h.script('-UNITS 4 16 2 2 90 Y\n')).toBe('idle');
    const hv = (k: string) => h.doc.header.get(k);
    expect([hv('$LUNITS'), hv('$LUPREC'), hv('$AUNITS'), hv('$AUPREC'), hv('$ANGDIR')]).toEqual([4, 4, 1, 2, 1]);
    expect(hv('$ANGBASE')).toBeCloseTo(Math.PI / 2);
  });

  it('-DIMSTYLE: 저장(S)·복원(R)·?', async () => {
    const h = setup();
    expect(await h.script('-DIMSTYLE S MYDIM\n-DIMSTYLE R ISO-25\n-DIMSTYLE ? *\n')).toBe('idle');
    expect(h.doc.dimStyles.has('MYDIM')).toBe(true);
    expect(h.doc.header.get('$DIMSTYLE')).toBe('ISO-25');
    expect(h.out()).toContain('명명된 치수 스타일:');
  });

  it('-OVERKILL: 중복 선 지우기', async () => {
    const h = setup();
    h.add(line(0, 0, 10, 0));
    h.add(line(0, 0, 10, 0));
    expect(await h.script('-OVERKILL ALL  \n')).toBe('idle');
    expect(h.model('LINE')).toHaveLength(1);
    expect(h.out()).toContain('1개의 중복 항목 삭제됨');
  });

  it('-XREF: ?·경로(P)·분리(D), 부착은 안내', async () => {
    const h = setup((doc) => {
      doc.blockRecords.set('XR1', { name: 'XR1', handle: 'FF10', flags: 0, insertUnits: 0, explodable: true, scalable: true } as never);
      doc.blocks.set('XR1', { name: 'XR1', handle: 'FF11', recordHandle: 'FF10', basePoint: { x: 0, y: 0, z: 0 }, flags: 4, xrefPath: 'C:\\x\\XR1.dwg', entities: [] });
      doc.layers.set('XR1|WALL', { ...structuredClone(doc.layers.get('0')!), name: 'XR1|WALL', handle: 'FF12' });
    });
    h.add({ ...entityDefaults(), type: 'INSERT', handle: '', block: 'XR1', insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as Entity);
    expect(await h.script('-XREF ? *\n-XREF P XR1\nD:\\new path\\XR1.dwg\n')).toBe('idle');
    expect(h.out()).toContain('총 외부 참조: 1개');
    expect(h.doc.blocks.get('XR1')!.xrefPath).toBe('D:\\new path\\XR1.dwg');
    expect(await h.script('-XREF D XR1\n')).toBe('idle');
    expect(h.doc.blocks.has('XR1')).toBe(false);
    expect(h.doc.layers.has('XR1|WALL')).toBe(false);
    expect(h.model('INSERT')).toHaveLength(0);
    expect(await h.script('-XREF A\n')).toBe('paused');
  });

  it('-IMAGE: ?·언로드(U)·분리(D)', async () => {
    const h = setup((doc) => {
      doc.objects.set('FF20', { type: 'IMAGEDEF', handle: 'FF20', owner: 'FF21', fileName: 'C:\\img\\pic.png', imageSize: { x: 10, y: 10 }, pixelSize: { x: 1, y: 1 }, loaded: true, resolutionUnits: 0 } as never);
      doc.objects.set('FF21', { type: 'DICTIONARY', handle: 'FF21', entries: new Map([['pic', 'FF20']]), hardOwner: false, cloning: 1 } as never);
    });
    h.add({ ...entityDefaults(), type: 'IMAGE', handle: '', insert: { x: 0, y: 0, z: 0 }, uVector: { x: 1, y: 0, z: 0 }, vVector: { x: 0, y: 1, z: 0 }, imageSize: { x: 10, y: 10 }, imageDef: 'FF20', displayFlags: 1, clipping: false, brightness: 50, contrast: 50 } as unknown as Entity);
    expect(await h.script('-IMAGE ? *\n-IMAGE U pic\n')).toBe('idle');
    expect(h.out()).toContain('pic');
    expect((h.doc.objects.get('FF20') as { loaded: boolean }).loaded).toBe(false);
    expect(await h.script('-IMAGE D pic\n')).toBe('idle');
    expect(h.doc.objects.has('FF20')).toBe(false);
    expect(h.model('IMAGE')).toHaveLength(0);
    expect([...(h.doc.objects.get('FF21') as unknown as { entries: Map<string, string> }).entries.keys()]).toEqual([]);
  });

  it('-PLOT: 상세 구성 프롬프트 순서(플롯 진행 아니오)', async () => {
    const h = setup();
    const scr = '-PLOT Y 모형 SVG A4 M L N E 1=100 C Y . Y A\nout.svg\nN N\n';
    expect(await h.script(scr)).toBe('idle');
    const start = h.prompts.findIndex((p) => p.startsWith('상세한 플롯 구성을 원하십니까?'));
    expect(h.prompts.slice(start).map((p) => p.replace(/ ?<.*$/, '').replace(/ \[.*$/, ''))).toEqual([
      '상세한 플롯 구성을 원하십니까?',
      '배치 이름 또는',
      '출력 장치 이름 또는',
      '용지 크기 또는',
      '용지 단위 입력',
      '용지 방향 입력',
      '위 아래를 뒤집어 플롯?',
      '플롯 영역 입력',
      '플롯 축척 입력 (출력 밀리미터=도면 단위)또는',
      '플롯 간격띄우기 입력(x,y) 또는',
      '플롯 스타일로 플롯?',
      '플롯 스타일 테이블 이름 또는',
      '선가중치로 플롯?',
      '음영 플롯 설정 입력',
      '파일 이름 입력',
      '페이지 설정에 대한 변경 사항 저장',
      '플롯을 진행합니까?',
    ]);
    expect(h.errors()).toEqual([]);
  });

  it('-PLOT: 간단 구성(페이지 설정 이름 Enter), 없는 장치는 오류', async () => {
    const h = setup();
    expect(await h.script('-PLOT N 모형  DWG To PDF.pc3\n\nN N\n')).toBe('paused');
    expect(h.errors().join()).toContain('장치 "DWG"');
    const k = makeScriptPlot();
    expect(await k.script('-PLOT N 모형  "DWG To PDF.pc3"\n\nN N\n')).toBe('idle');
    expect(k.prompts.some((p) => p.startsWith('파일 이름 입력 <test-모형.pdf>'))).toBe(true);
  });

  it('겹치는 이름은 등록하지 않는다(먼저 등록된 명령이 남는다)', () => {
    const h = makeScriptApp();
    const mine = { name: '-PURGE', title: '다른 모듈', run() {} };
    h.app.register(mine);
    registerDashCommands(h.app);
    expect(h.app.commands.get('-PURGE')).toBe(mine);
    expect(h.app.commands.has('-STYLE')).toBe(true);
    // register는 원래대로
    expect(Object.prototype.hasOwnProperty.call(h.app, 'register')).toBe(true);
    void tableKey;
  });
});
