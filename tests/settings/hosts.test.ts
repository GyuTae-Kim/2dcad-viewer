/**
 * 이 브라우저 변수를 명령 쪽에서도 쓰는지: AutoLISP getvar·setvar(lisp-host.ts가 SYSVDLG와 같은 sysvarInfo·setSysvarText로),
 * -INSERT의 속성 값 묻기(ATTREQ — 이 브라우저 값을 정했으면 그것, 아니면 도면 머리말, INSERT와 같다).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CadDocument, Entity, InsertEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { Real } from '../../src/edit/lisp/types';
import { getSysVar, setSysVar } from '../../src/app/lisp-host';
import { BROWSER_VARS, browserSysvar, setBrowserSysvar } from '../../src/app/sysvars';
import { prefSet } from '../../src/app/mgr-ui';
import { registerDrawCommands } from '../../src/app/draw';
import { registerBlockCommands } from '../../src/app/blocks';
import { registerDashCommands } from '../../src/app/dashcmds';
import { makeLispApp } from '../lisp/app';
import { makeScriptApp } from '../script/app';

afterEach(() => {
  for (const v of BROWSER_VARS) prefSet(`opencad.sysvar.${v.name}`, null);
});

describe('AutoLISP getvar·setvar와 이 브라우저 변수', () => {
  it('(setvar "APERTURE" 7)·(getvar "aperture")는 SYSVDLG와 같은 값, 범위 밖은 거부', async () => {
    const h = makeLispApp();
    await h.lisp('(getvar "GRIPSIZE")');
    expect(h.printed.at(-1)?.text).toBe('5');
    await h.lisp('(setvar "APERTURE" 7)');
    expect(browserSysvar('APERTURE')).toBe(7);
    await h.lisp('(getvar "aperture")');
    expect(h.printed.at(-1)?.text).toBe('7');
    await h.lisp('(setvar "GRIPSIZE" 300)');
    expect(h.errors().at(-1)).toContain('AutoCAD 변수 설정 거부: "GRIPSIZE" 300 (1과(와) 255 사이의 정수가 필요합니다)');
    expect(browserSysvar('GRIPSIZE')).toBe(5);
  });

  it('정수만 받고(정수 실수는 받는다), ATTREQ는 정하지 않았으면 도면 머리말', () => {
    const h = makeLispApp((d) => d.header.set('$ATTREQ', 0));
    expect(setSysVar(h.app, 'ZOOMFACTOR', new Real(2.5))).toBe('정수가 필요합니다');
    expect(setSysVar(h.app, 'ZOOMFACTOR', new Real(80))).toBeNull();
    expect(getSysVar(h.app, 'ZOOMFACTOR')).toBe(80);
    expect(getSysVar(h.app, 'ATTREQ')).toBe(0);
    expect(setSysVar(h.app, 'ATTREQ', 1)).toBeNull();
    expect(getSysVar(h.app, 'ATTREQ')).toBe(1);
    // 도면 변수·세션 변수는 그대로
    expect(getSysVar(h.app, 'OSMODE')).toEqual(expect.any(Number));
    expect(setSysVar(h.app, 'DWGNAME', 'x')).toBe('읽기 전용');
  });
});

let hs = 0xe000;
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

function insertApp(header?: (doc: CadDocument) => void) {
  const h = makeScriptApp((doc) => {
    addDoor(doc);
    header?.(doc);
  });
  registerDrawCommands(h.app);
  registerBlockCommands(h.app);
  registerDashCommands(h.app);
  return h;
}

describe('-INSERT와 ATTREQ', () => {
  it('이 브라우저 ATTREQ 0이면 머리말이 1이어도 묻지 않고 기본값', async () => {
    expect(setBrowserSysvar('ATTREQ', 0)).toBeNull();
    const h = insertApp((d) => d.header.set('$ATTREQ', 1));
    expect(await h.script('-INSERT DOOR 5,5 1 1 0\n')).toBe('idle');
    const ins = h.model('INSERT')[0] as InsertEntity;
    expect(ins.attribs[0]!.text).toBe('D1');
    expect(h.prompts.some((p) => p.startsWith('번호'))).toBe(false);
  });

  it('이 브라우저 ATTREQ 1이면 머리말이 0이어도 묻는다, 정하지 않았으면 머리말', async () => {
    expect(setBrowserSysvar('ATTREQ', 1)).toBeNull();
    const h = insertApp((d) => d.header.set('$ATTREQ', 0));
    expect(await h.script('-INSERT DOOR 5,5 1 1 0\nA-9\n')).toBe('idle');
    expect((h.model('INSERT')[0] as InsertEntity).attribs[0]!.text).toBe('A-9');
    prefSet('opencad.sysvar.ATTREQ', null);
    const h2 = insertApp((d) => d.header.set('$ATTREQ', 0));
    expect(await h2.script('-INSERT DOOR 5,5 1 1 0\n')).toBe('idle');
    expect((h2.model('INSERT')[0] as InsertEntity).attribs[0]!.text).toBe('D1');
  });
});
