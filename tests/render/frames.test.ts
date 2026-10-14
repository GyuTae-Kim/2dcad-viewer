/** 가리기·이미지 경계 방향, 테두리 설정(IMAGEFRAME·WIPEOUTFRAME), 폭 있는 폴리선과 맞춤 폴리선 그리기 */
import { describe, expect, it } from 'vitest';
import type { DictionaryObject, Entity, ImageEntity, PolylineEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { frameSetting } from '../../src/core/framevars';
import { frameSettingOps } from '../../src/edit/framevars';
import { applyOps } from '../../src/edit/session';
import { edgePieces } from '../../src/edit/geom/edges';
import type { LinePiece } from '../../src/edit/geom/curve';
import { readCadFile } from '../../src/io';
import { buildSpace } from '../../src/render/build';
import { STYLE_FLAG_NO_PLOT, StyleTable, resolveStyles } from '../../src/render/styles';
import { TextEngine } from '../../src/text/layout';
import { P, add, newDoc } from '../hatch/helpers';

let serial = 0x900;
const H = () => (serial++).toString(16).toUpperCase();

function wipeout(boundary: [number, number][]): ImageEntity {
  return {
    type: 'WIPEOUT',
    ...entityDefaults(),
    handle: H(),
    insert: P(0, 0),
    uVector: P(100, 0),
    vVector: P(0, 40),
    imageSize: { x: 1, y: 1 },
    displayFlags: 7,
    clipping: true,
    brightness: 50,
    contrast: 50,
    fade: 0,
    clipBoundaryType: 2,
    clipBoundary: boundary.map(([x, y]) => ({ x, y })),
  };
}

const build = (doc: ReturnType<typeof newDoc>) => buildSpace(doc, '*Model_Space', { text: new TextEngine(null) });
const segs = (doc: ReturnType<typeof newDoc>) => build(doc).list.chunks.reduce((a, c) => a + c.segCount, 0);

describe('가리기·이미지 경계', () => {
  it('픽셀 좌표의 원점은 왼쪽 위다(ezdxf boundary_path_wcs와 같음)', () => {
    // ezdxf가 (0,0),(100,0),(0,40) 삼각형에 대해 쓰는 경계
    const e = wipeout([
      [-0.5, 0.5],
      [0.5, 0.5],
      [-0.5, -0.5],
      [-0.5, 0.5],
    ]);
    const pts = (edgePieces(e) as LinePiece[]).map((p) => [Math.round(p.a.x * 1e6) / 1e6, Math.round(p.a.y * 1e6) / 1e6]);
    expect(pts.slice(0, 3)).toEqual([
      [0, 0],
      [100, 0],
      [0, 40],
    ]);
  });
});

describe('IMAGEFRAME·WIPEOUTFRAME', () => {
  function docWithRoot() {
    const doc = newDoc();
    const root: DictionaryObject = { type: 'DICTIONARY', handle: 'C', entries: new Map(), hardOwner: false, cloning: 1 };
    doc.objects.set('C', root);
    doc.rootDictionary = 'C';
    return doc;
  }

  it('변수 객체가 없으면 1이고, 바꾸면 객체와 사전 항목을 만든다', () => {
    const doc = docWithRoot();
    expect(frameSetting(doc, 'wipeout')).toBe(1);
    const ops = frameSettingOps(doc, 'wipeout', 2, H)!;
    applyOps(doc, ops);
    expect(frameSetting(doc, 'wipeout')).toBe(2);
    const root = doc.objects.get('C') as DictionaryObject;
    expect(root.entries.has('ACAD_WIPEOUT_VARS')).toBe(true);
    // 있는 객체는 값만 바꾼다
    const again = frameSettingOps(doc, 'wipeout', 0, H)!;
    expect(again).toHaveLength(1);
    applyOps(doc, again);
    expect(frameSetting(doc, 'wipeout')).toBe(0);
    expect(frameSetting(doc, 'image')).toBe(1);
  });

  it('2면 테두리를 화면에는 그리고 출력에서는 뺀다', () => {
    const doc = docWithRoot();
    add(doc, wipeout([
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]));
    expect(segs(doc)).toBe(4);
    applyOps(doc, frameSettingOps(doc, 'wipeout', 0, H)!);
    expect(segs(doc)).toBe(0);
    applyOps(doc, frameSettingOps(doc, 'wipeout', 2, H)!);
    const s = build(doc);
    expect(s.list.chunks.reduce((a, c) => a + c.segCount, 0)).toBe(4);
    const noPlot = s.styles.specs.findIndex((sp) => (sp.flags & STYLE_FLAG_NO_PLOT) !== 0);
    expect(noPlot).toBeGreaterThan(0);
    const vis = (plot: boolean) => resolveStyles(s.styles, s.layers, { darkBackground: true, backgroundRgb: 0, showLineweight: false, defaultLineweight: 25, plot: plot ? { style: 'mono' } : undefined });
    // 스타일 자료는 항목마다 8칸이고 여섯째 칸이 보임 여부다
    expect(vis(false)[noPlot * 8 + 5]).not.toBe(0);
    expect(vis(true)[noPlot * 8 + 5]).toBe(0);
  });

  it('스타일 표 열쇠가 플래그를 구분한다', () => {
    const t = new StyleTable();
    const a = t.intern({ colorKind: 0, color: 1, layer: 0, freezeLayers: [], widthKind: 0, width: 0, alpha: 255, flags: 0 });
    const b = t.intern({ colorKind: 0, color: 1, layer: 0, freezeLayers: [], widthKind: 0, width: 0, alpha: 255, flags: STYLE_FLAG_NO_PLOT });
    expect(a).not.toBe(b);
  });
});

describe('폴리선 그리기', () => {
  it('폭 있는 폴리선의 폭 0 세그먼트는 선으로 그린다', () => {
    const doc = newDoc();
    const e: Entity = {
      type: 'LWPOLYLINE',
      ...entityDefaults(),
      handle: H(),
      vertices: [
        { x: 0, y: 0, bulge: 0, startWidth: 2, endWidth: 2 },
        { x: 20, y: 0, bulge: 0, startWidth: 0, endWidth: 0 },
        { x: 20, y: 20, bulge: 0, startWidth: 2, endWidth: 2 },
        { x: 40, y: 20, bulge: 0, startWidth: 0, endWidth: 0 },
      ],
      closed: false,
      plinegen: false,
      constantWidth: 0,
      elevation: 0,
    };
    add(doc, e);
    expect(segs(doc)).toBe(1);
  });

  it('맞춤(curve-fit) 폴리선은 볼록도대로 호를 그린다', () => {
    const doc = newDoc();
    const v = (x: number, y: number, bulge: number) => ({ location: P(x, y), bulge, startWidth: 0, endWidth: 0, flags: 0 });
    const e: PolylineEntity = {
      type: 'POLYLINE',
      ...entityDefaults(),
      handle: H(),
      kind: '2d',
      flags: 2,
      vertices: [v(0, 0, 0.6), v(20, 10, -0.6), v(40, 0, 0)],
      elevation: 0,
      defaultStartWidth: 0,
      defaultEndWidth: 0,
      mCount: 0,
      nCount: 0,
      mDensity: 0,
      nDensity: 0,
      smoothType: 0,
    };
    add(doc, e);
    expect(segs(doc)).toBeGreaterThan(8);
  });

  it('DXF에서 폭이 적히지 않은 VERTEX는 POLYLINE의 기본 폭을 쓴다', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'POLYLINE', '5', '20', '8', '0', '66', '1', '10', '0', '20', '0', '30', '0', '40', '3', '41', '3', '70', '0',
      '0', 'VERTEX', '5', '21', '8', '0', '10', '0', '20', '0', '30', '0',
      '0', 'VERTEX', '5', '22', '8', '0', '10', '50', '20', '0', '30', '0', '40', '1', '41', '0',
      '0', 'SEQEND', '5', '23', '8', '0',
      '0', 'ENDSEC', '0', 'EOF', '',
    ].join('\n');
    const doc = readCadFile(new TextEncoder().encode(dxf), 'w.dxf');
    const pl = [...doc.entityIndex.values()].find((e) => e.type === 'POLYLINE') as PolylineEntity;
    expect(pl.vertices.map((x) => [x.startWidth, x.endWidth])).toEqual([
      [3, 3],
      [1, 0],
    ]);
  });
});

describe('필드 회색 배경(FIELDDISPLAY)', () => {
  it('필드가 든 문자 뒤에 화면용 배경을 넣고, 끄거나 출력하면 숨긴다', async () => {
    const { displayFlags, STYLE_FLAG_FIELD } = await import('../../src/render/styles');
    const doc = newDoc();
    const t: Entity = {
      type: 'TEXT',
      ...entityDefaults(),
      handle: H(),
      insert: P(0, 0),
      height: 5,
      text: '2026',
      rotation: 0,
      widthFactor: 1,
      oblique: 0,
      style: 'Standard',
      generation: 0,
      halign: 0,
      valign: 0,
      xdata: [{ app: 'OPENCAD_FIELD', items: [{ code: 1000, value: '%<\\AcVar Date>%' }] }],
    } as Entity;
    add(doc, t);
    const s = build(doc);
    const fi = s.styles.specs.findIndex((sp) => (sp.flags & STYLE_FLAG_FIELD) !== 0);
    expect(fi).toBeGreaterThan(0);
    const vis = (plot: boolean) => resolveStyles(s.styles, s.layers, { darkBackground: true, backgroundRgb: 0, showLineweight: false, defaultLineweight: 25, plot: plot ? { style: 'mono' } : undefined })[fi * 8 + 5];
    displayFlags.fieldBackground = true;
    expect(vis(false)).toBe(1);
    expect(vis(true)).toBe(0);
    displayFlags.fieldBackground = false;
    expect(vis(false)).toBe(0);
    displayFlags.fieldBackground = true;
  });
});
