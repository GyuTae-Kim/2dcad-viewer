/**
 * DWG 쓰기 시험 공용: 입력 도면 목록, 직접 만든 시험 도면, 요약 정규화.
 * 표본 도면은 저장소에 없다(CAD_FIXTURES, .runtime).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CadDocument, Entity, HeaderValue } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { decodeCadEscapes } from '../../src/core/codepage';
import { readDwg } from '../../src/io/dwg';
import { readDxf } from '../../src/io/dxf/reader';
import { FIXTURES } from '../oracle/ezdxf';
import { dwgFixtures } from './oracle';
import { packLw } from '../../src/core/lwpoly';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const WRITE_VERSIONS = ['AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032'] as const;

export interface Source {
  group: string;
  name: string;
  path: string;
  dxf: boolean;
}

/** 표본 DWG */
export function dwgSources(): Source[] {
  return dwgFixtures().map((f) => ({ group: f.group, name: f.name, path: f.path, dxf: false }));
}

/** DXF 원본: 표본 DXF, 생성 DXF(.runtime/gen), 엔진이 바꾼 DXF(.runtime/oracle-dxf), 앱 예제 */
export function dxfSources(): Source[] {
  const out: Source[] = [];
  const dirs: [string, string][] = [
    ['samples-dxf', join(FIXTURES, 'samples-dxf')],
    ['gen', join(ROOT, '.runtime/gen')],
    ['oracle-dxf', join(ROOT, '.runtime/oracle-dxf')],
  ];
  for (const [group, dir] of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) if (name.toLowerCase().endsWith('.dxf')) out.push({ group, name, path: join(dir, name), dxf: true });
  }
  const app = join(ROOT, 'public/samples/opencad-sample.dxf');
  if (existsSync(app)) out.push({ group: 'app', name: 'opencad-sample.dxf', path: app, dxf: true });
  return out;
}

export function readSource(s: Source): CadDocument {
  const data = new Uint8Array(readFileSync(s.path));
  return s.dxf ? readDxf(data) : readDwg(data);
}

/**
 * 쓰기 결과가 실행마다 같도록(엔진 결과 캐시) 없는 GUID·날짜만 고정한다.
 * 문서는 바꾸지 않고 머리만 복사한다.
 */
export function stable(doc: CadDocument): CadDocument {
  const header = new Map<string, HeaderValue>(doc.header);
  if (!header.has('$FINGERPRINTGUID')) header.set('$FINGERPRINTGUID', '{11111111-2222-3333-4444-555555555555}');
  if (!header.has('$VERSIONGUID')) header.set('$VERSIONGUID', '{66666666-7777-8888-9999-AAAAAAAAAAAA}');
  if (typeof header.get('$TDCREATE') !== 'number') header.set('$TDCREATE', 2461000.5);
  if (typeof header.get('$TDUPDATE') !== 'number') header.set('$TDUPDATE', 2461000.5);
  return { ...doc, header };
}

/** 여러 종류의 도형을 담은 새 도면 */
export function syntheticDocument(): CadDocument {
  const doc = createNewDocument('metric');
  const ms = doc.blocks.get('*MODEL_SPACE')!;
  let seq = 0x9000;
  const h = () => (seq++).toString(16).toUpperCase();
  const base = (layer = '0') => ({ ...entityDefaults(), handle: h(), layer });
  // 도면층·선종류
  doc.layers.set('외형선', { name: '외형선', handle: h(), flags: 0, color: { aci: 1 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: 50, plot: true, transparency: 255 });
  doc.layers.set('투명', { name: '투명', handle: h(), flags: 4, color: { aci: 5, rgb: 0x3366cc }, off: true, frozen: false, locked: true, linetype: 'Continuous', lineweight: -3, plot: false, transparency: 128 });
  doc.appIds.set('MYAPP', { name: 'MYAPP', handle: h(), flags: 0 });
  // 블록(속성 정의 포함)
  const blkRec = h();
  const blk = { name: 'TAG', handle: h(), recordHandle: blkRec, basePoint: { x: 0, y: 0, z: 0 }, flags: 2, entities: [] as Entity[], endHandle: h(), layer: '0' };
  blk.entities.push({ ...base(), type: 'CIRCLE', center: { x: 0, y: 0, z: 0 }, radius: 5 } as Entity);
  blk.entities.push({ ...base(), type: 'ATTDEF', insert: { x: -2, y: -1, z: 0 }, height: 2, text: 'A1', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, tag: 'NO', prompt: '번호', attFlags: 0 } as Entity);
  doc.blocks.set('TAG', blk);
  doc.blockRecords.set('TAG', { name: 'TAG', handle: blkRec, flags: 0, insertUnits: 4, explodable: true, scalable: true });
  const add = (e: Entity) => ms.entities.push(e);
  add({ ...base('외형선'), type: 'LINE', start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 50, z: 0 }, xdata: [{ app: 'MYAPP', items: [{ code: 1000, value: '한글 문자열' }, { code: 1070, value: 7 }, { code: 1040, value: 1.5 }, { code: 1010, value: { x: 1, y: 2, z: 3 } }] }] } as Entity);
  add({ ...base(), type: 'LINE', start: { x: 0, y: 0, z: 1 }, end: { x: 10, y: 0, z: 2 }, color: { aci: 3 }, lineweight: 35, ltscale: 2 } as Entity);
  add({ ...base(), type: 'CIRCLE', center: { x: 10, y: 10, z: 0 }, radius: 7.5, color: { aci: 256, rgb: 0xff8000 }, transparency: 77 } as Entity);
  add({ ...base(), type: 'ARC', center: { x: 30, y: 10, z: 0 }, radius: 5, startAngle: 0.25, endAngle: 2.5, thickness: 1, extrusion: { x: 0, y: 0, z: -1 } } as Entity);
  add({ ...base(), type: 'ELLIPSE', center: { x: 50, y: 10, z: 0 }, majorAxis: { x: 10, y: 0, z: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2 } as Entity);
  add({ ...base(), type: 'POINT', position: { x: 1, y: 2, z: 3 }, angle: 0 } as Entity);
  add({ ...base(), type: 'LWPOLYLINE', ...packLw([{ x: 0, y: 0, bulge: 0, startWidth: 0, endWidth: 0 }, { x: 10, y: 0, bulge: 0.5, startWidth: 1, endWidth: 2 }, { x: 10, y: 10, bulge: 0, startWidth: 0, endWidth: 0 }]), closed: true, plinegen: false, constantWidth: 0, elevation: 3 } as Entity);
  add({ ...base(), type: 'POLYLINE', kind: '2d', flags: 1, elevation: 2, defaultStartWidth: 0, defaultEndWidth: 0, mCount: 0, nCount: 0, mDensity: 0, nDensity: 0, smoothType: 0, vertices: [0, 1, 2].map((i) => ({ location: { x: i * 5, y: i, z: 2 }, bulge: i === 1 ? 0.3 : 0, startWidth: 0.5, endWidth: 0.5, flags: 0 })) } as Entity);
  add({ ...base(), type: 'POLYLINE', kind: '3d', flags: 8, elevation: 0, defaultStartWidth: 0, defaultEndWidth: 0, mCount: 0, nCount: 0, mDensity: 0, nDensity: 0, smoothType: 0, vertices: [0, 1, 2].map((i) => ({ location: { x: i, y: i * 2, z: i * 3 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 })) } as Entity);
  add({
    ...base(),
    type: 'POLYLINE',
    kind: 'polyface',
    flags: 64,
    elevation: 0,
    defaultStartWidth: 0,
    defaultEndWidth: 0,
    mCount: 3,
    nCount: 1,
    mDensity: 0,
    nDensity: 0,
    smoothType: 0,
    vertices: [
      { location: { x: 0, y: 0, z: 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 192 },
      { location: { x: 1, y: 0, z: 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 192 },
      { location: { x: 0, y: 1, z: 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 192 },
      { location: { x: 0, y: 0, z: 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 128, faceIndices: [1, 2, -3] },
    ],
  } as Entity);
  add({ ...base(), type: 'SPLINE', flags: 8, degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 3, y: 2, z: 0 }, { x: 4, y: 0, z: 0 }], fitPoints: [], knotTolerance: 1e-10, controlTolerance: 1e-10, fitTolerance: 1e-10, normal: { x: 0, y: 0, z: 1 } } as Entity);
  add({ ...base(), type: 'SPLINE', flags: 8, degree: 3, knots: [], controlPoints: [], fitPoints: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }, { x: 10, y: 0, z: 0 }], knotTolerance: 1e-10, controlTolerance: 1e-10, fitTolerance: 1e-10, startTangent: { x: 1, y: 1, z: 0 }, endTangent: { x: 1, y: -1, z: 0 }, normal: { x: 0, y: 0, z: 1 } } as Entity);
  add({ ...base(), type: 'XLINE', base: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } as Entity);
  add({ ...base(), type: 'RAY', base: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } } as Entity);
  add({ ...base(), type: 'TEXT', insert: { x: 0, y: -10, z: 0 }, alignPoint: { x: 20, y: -10, z: 0 }, height: 2.5, text: '가나다 ABC', rotation: 0.3, widthFactor: 0.8, oblique: 0.1, style: 'Standard', generation: 0, halign: 1, valign: 0 } as Entity);
  add({ ...base(), type: 'MTEXT', insert: { x: 0, y: -20, z: 0 }, height: 2.5, width: 40, attachment: 1, drawingDirection: 1, text: '첫 줄\\P둘째 {\\C1;빨강}', style: 'Standard', direction: { x: 1, y: 0, z: 0 }, rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 1, backgroundColor: { aci: 2 }, backgroundScale: 1.5 } as Entity);
  add({ ...base(), type: 'SOLID', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }], invisibleEdges: 0 } as Entity);
  add({ ...base(), type: '3DFACE', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 0 }], invisibleEdges: 5 } as Entity);
  const attH = h();
  add({
    ...base(),
    type: 'INSERT',
    block: 'TAG',
    insert: { x: 70, y: 0, z: 0 },
    scale: { x: 2, y: 2, z: 2 },
    rotation: 0.5,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [{ ...base(), handle: attH, type: 'ATTRIB', insert: { x: 66, y: -2, z: 0 }, height: 4, text: 'P-101', rotation: 0.5, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, tag: 'NO', attFlags: 0 }],
  } as unknown as Entity);
  add({ ...base(), type: 'INSERT', block: 'TAG', insert: { x: 90, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 3, rowCount: 2, columnSpacing: 15, rowSpacing: 12, attribs: [] } as Entity);
  add({
    ...base(),
    type: 'HATCH',
    patternName: 'SOLID',
    solid: true,
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [
      { flags: 3, polyline: { closed: true, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 5, y: 0, bulge: 0.4 }, { x: 5, y: 5, bulge: 0 }] } },
      {
        flags: 0,
        edges: [
          { type: 'line', start: { x: 10, y: 0 }, end: { x: 15, y: 0 } },
          { type: 'arc', center: { x: 15, y: 2.5 }, radius: 2.5, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, ccw: true },
          { type: 'line', start: { x: 15, y: 5 }, end: { x: 10, y: 5 } },
          { type: 'ellipse', center: { x: 10, y: 2.5 }, majorAxis: { x: 0, y: 2.5 }, ratio: 0.5, startAngle: 0, endAngle: Math.PI, ccw: true },
        ],
      },
    ],
    patternLines: [],
    pixelSize: 0,
    seedPoints: [{ x: 1, y: 1 }],
  } as Entity);
  add({
    ...base(),
    type: 'HATCH',
    patternName: 'ANSI31',
    solid: false,
    associative: false,
    hatchStyle: 1,
    patternType: 1,
    patternAngle: 0,
    patternScale: 2,
    patternDouble: false,
    elevation: 0,
    paths: [{ flags: 1, edges: [{ type: 'line', start: { x: 0, y: 0 }, end: { x: 9, y: 0 } }, { type: 'line', start: { x: 9, y: 0 }, end: { x: 0, y: 9 } }, { type: 'line', start: { x: 0, y: 9 }, end: { x: 0, y: 0 } }] }],
    patternLines: [{ angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -2.2, y: 2.2 }, dashes: [] }],
    pixelSize: 0,
    seedPoints: [],
    gradient: undefined,
  } as Entity);
  add({
    ...base(),
    type: 'DIMENSION',
    block: '',
    dimStyle: 'ISO-25',
    dimType: 32 | 1,
    defPoint: { x: 0, y: 10, z: 0 },
    textMid: { x: 5, y: 11, z: 0 },
    defPoint2: { x: 0, y: 0, z: 0 },
    defPoint3: { x: 10, y: 0, z: 0 },
    defPoint4: { x: 0, y: 0, z: 0 },
    defPoint5: { x: 0, y: 0, z: 0 },
    text: '',
    measurement: 10,
    rotation: 0,
    obliqueAngle: 0,
    textRotation: 0,
    horizontalDirection: 0,
    attachment: 5,
    leaderLength: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
  } as Entity);
  add({ ...base(), type: 'LEADER', dimStyle: 'ISO-25', vertices: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }, { x: 10, y: 5, z: 0 }], arrowHead: true, pathType: 0, creation: 3, hooklineDirection: 0, hookline: false, textHeight: 0, textWidth: 0 } as Entity);
  add({ ...base(), type: 'TOLERANCE', dimStyle: 'ISO-25', insert: { x: 0, y: 30, z: 0 }, text: '{\\Fgdt;j}%%v0.1', direction: { x: 1, y: 0, z: 0 } } as Entity);
  add({ ...base(), type: 'MLINE', styleName: 'Standard', scale: 1, justification: 0, flags: 1, startPoint: { x: 0, y: 40, z: 0 }, normal: { x: 0, y: 0, z: 1 }, elementCount: 2, vertices: [0, 1].map((i) => ({ position: { x: i * 10, y: 40, z: 0 }, direction: { x: 1, y: 0, z: 0 }, miter: { x: 0, y: 1, z: 0 }, elements: [{ params: [0.5, 0], fillParams: [] }, { params: [-0.5, 0], fillParams: [] }] })) } as Entity);
  return doc;
}

/** 요약 문자열 정규화(\U+XXXX 풀기, 제어 문자 표기) */
export const normText = (s: string): string => decodeCadEscapes(s).replace(/[\x00-\x1f]/g, (c) => '^' + String.fromCharCode(c.charCodeAt(0) + 64));
