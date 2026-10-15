/** 도면 비교 시험용 문서·객체 만들기 */
import type { BlockDef, CadDocument, Entity, HatchEntity, InsertEntity, Vec3 } from '../../src/core/model';
import { MODEL_SPACE, createDocument, entityDefaults, tableKey } from '../../src/core/model';
import { packLw } from '../../src/core/lwpoly';

export const P = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
export const deg = (d: number) => (d * Math.PI) / 180;

/** 핸들을 차례로 주는 문서 */
export class Doc {
  readonly doc: CadDocument;
  private n: number;

  constructor(start = 0x100) {
    this.n = start;
    this.doc = createDocument('new');
    const ms: BlockDef = { name: '*Model_Space', handle: '1F', recordHandle: '1E', basePoint: P(0, 0), flags: 0, entities: [] };
    this.doc.blocks.set(MODEL_SPACE, ms);
    for (const name of ['0', 'A', 'B']) this.doc.layers.set(tableKey(name), { name, handle: this.h(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 });
  }

  h(): string {
    return (this.n++).toString(16).toUpperCase();
  }

  get model(): Entity[] {
    return this.doc.blocks.get(MODEL_SPACE)!.entities;
  }

  add<T extends Entity>(e: T, handle?: string): T {
    e.handle = handle ?? this.h();
    e.owner = '1E';
    this.model.push(e);
    this.doc.entityIndex.set(e.handle, e);
    return e;
  }

  block(name: string, ents: Entity[], base = P(0, 0)): void {
    const rec = this.h();
    for (const e of ents) {
      e.handle = this.h();
      e.owner = rec;
      this.doc.entityIndex.set(e.handle, e);
    }
    this.doc.blocks.set(tableKey(name), { name, handle: this.h(), recordHandle: rec, basePoint: base, flags: name.startsWith('*') ? 1 : 0, entities: ents });
    this.doc.blockRecords.set(tableKey(name), { name, handle: rec, flags: 0, insertUnits: 0, explodable: true, scalable: true });
  }

  /** 핸들까지 같은 사본(같은 계보) */
  clone(): Doc {
    const d = Object.create(Doc.prototype) as Doc;
    (d as unknown as { doc: CadDocument }).doc = structuredClone(this.doc);
    (d as unknown as { n: number }).n = this.n;
    return d;
  }
}

const base = (layer = '0') => ({ ...entityDefaults(), layer });

export function line(x0: number, y0: number, x1: number, y1: number, layer = '0'): Entity {
  return { type: 'LINE', ...base(layer), start: P(x0, y0), end: P(x1, y1) };
}

export function circle(cx: number, cy: number, r: number): Entity {
  return { type: 'CIRCLE', ...base(), center: P(cx, cy), radius: r };
}

export function arc(cx: number, cy: number, r: number, a0: number, a1: number): Entity {
  return { type: 'ARC', ...base(), center: P(cx, cy), radius: r, startAngle: deg(a0), endAngle: deg(a1) };
}

export function lw(pts: [number, number][], closed = false): Entity {
  return { type: 'LWPOLYLINE', ...base(), ...packLw(pts.map(([x, y]) => ({ x, y, bulge: 0, startWidth: 0, endWidth: 0 }))), closed, plinegen: false, constantWidth: 0, elevation: 0 };
}

export function text(x: number, y: number, s: string): Entity {
  return { type: 'TEXT', ...base(), insert: P(x, y), height: 2.5, text: s, rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0 };
}

export function insert(block: string, x: number, y: number, rot = 0): InsertEntity {
  return { type: 'INSERT', ...base(), block, insert: P(x, y), scale: P(1, 1, 1), rotation: deg(rot), columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
}

export function hatch(x: number, y: number, w: number, h: number, pattern = 'ANSI31'): HatchEntity {
  return {
    type: 'HATCH',
    ...base(),
    patternName: pattern,
    solid: pattern === 'SOLID',
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [
      {
        flags: 3,
        polyline: {
          closed: true,
          vertices: [
            { x, y, bulge: 0 },
            { x: x + w, y, bulge: 0 },
            { x: x + w, y: y + h, bulge: 0 },
            { x, y: y + h, bulge: 0 },
          ],
        },
      },
    ],
    patternLines: [],
    pixelSize: 0,
    seedPoints: [],
  };
}

/** 객체 n개의 큰 도면(선·원·호·폴리선·문자·블록 참조를 섞는다) */
export function bigDoc(n: number, start = 0x100): Doc {
  const d = new Doc(start);
  d.block('PART', [line(0, 0, 10, 0), circle(5, 5, 3), text(0, 12, 'P')]);
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const x = (i % side) * 20;
    const y = Math.floor(i / side) * 20;
    switch (i % 6) {
      case 0:
        d.add(line(x, y, x + 15, y + 7));
        break;
      case 1:
        d.add(circle(x + 5, y + 5, 4 + (i % 7) * 0.1));
        break;
      case 2:
        d.add(arc(x + 5, y + 5, 6, 10, 200 + (i % 50)));
        break;
      case 3:
        d.add(
          lw(
            [
              [x, y],
              [x + 10, y],
              [x + 10, y + 10],
              [x, y + 10 + (i % 3)],
            ],
            true,
          ),
        );
        break;
      case 4:
        d.add(text(x, y, `T${i}`));
        break;
      default:
        d.add(insert('PART', x, y, i % 360));
    }
  }
  return d;
}
