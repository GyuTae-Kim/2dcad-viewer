/**
 * 시험용 작은 STEP 글쓴이: 인스턴스 번호를 매기며 `#n=TYPE(args);` 줄을 모은다.
 * 형상 도우미(점·방향·배치·모서리·고리·면)와 제품·표현 묶음을 만든다.
 */
export type P3 = [number, number, number];

export function r(x: number): string {
  if (!Number.isFinite(x)) return '0.';
  const s = String(x);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return `${m!.includes('.') ? m : `${m}.`}E${e}`;
  }
  return s.includes('.') ? s : `${s}.`;
}

export class StepText {
  private lines: string[] = [];
  private n = 0;

  add(type: string, args: string): number {
    const id = ++this.n;
    this.lines.push(`#${id}=${type}(${args});`);
    return id;
  }
  /** 복합 인스턴스 등 본문을 그대로 */
  raw(body: string): number {
    const id = ++this.n;
    this.lines.push(`#${id}=${body};`);
    return id;
  }

  pt(p: P3): number {
    return this.add('CARTESIAN_POINT', `'',(${p.map(r).join(',')})`);
  }
  dir(p: P3): number {
    return this.add('DIRECTION', `'',(${p.map(r).join(',')})`);
  }
  ax2(o: P3, z: P3 = [0, 0, 1], x: P3 = [1, 0, 0]): number {
    return this.add('AXIS2_PLACEMENT_3D', `'',#${this.pt(o)},#${this.dir(z)},#${this.dir(x)}`);
  }
  vertex(p: P3): number {
    return this.add('VERTEX_POINT', `'',#${this.pt(p)}`);
  }
  line(a: P3, b: P3): number {
    const d: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...d);
    const v = this.add('VECTOR', `'',#${this.dir([d[0] / l, d[1] / l, d[2] / l])},${r(l)}`);
    return this.add('LINE', `'',#${this.pt(a)},#${v}`);
  }
  circle(o: P3, rad: number, z: P3 = [0, 0, 1], x: P3 = [1, 0, 0]): number {
    return this.add('CIRCLE', `'',#${this.ax2(o, z, x)},${r(rad)}`);
  }
  edge(v1: number, v2: number, curve: number, same = true): number {
    return this.add('EDGE_CURVE', `'',#${v1},#${v2},#${curve},${same ? '.T.' : '.F.'}`);
  }
  oe(edge: number, fwd: boolean): number {
    return this.add('ORIENTED_EDGE', `'',*,*,#${edge},${fwd ? '.T.' : '.F.'}`);
  }
  loop(oes: number[]): number {
    return this.add('EDGE_LOOP', `'',(${oes.map((x) => `#${x}`).join(',')})`);
  }
  bound(loop: number, outer = true, orient = true): number {
    return this.add(outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND', `'',#${loop},${orient ? '.T.' : '.F.'}`);
  }
  face(bounds: number[], surface: number, same = true): number {
    return this.add('ADVANCED_FACE', `'',(${bounds.map((x) => `#${x}`).join(',')}),#${surface},${same ? '.T.' : '.F.'}`);
  }
  plane(o: P3, z: P3 = [0, 0, 1], x: P3 = [1, 0, 0]): number {
    return this.add('PLANE', `'',#${this.ax2(o, z, x)}`);
  }
  solid(faces: number[], name = 'body'): number {
    const sh = this.add('CLOSED_SHELL', `'',(${faces.map((x) => `#${x}`).join(',')})`);
    return this.add('MANIFOLD_SOLID_BREP', `'${name}',#${sh}`);
  }

  /** 길이 단위 맥락(mm 또는 inch), 각 단위(라디안 또는 도) */
  context(unit: 'mm' | 'inch' = 'mm', angle: 'rad' | 'deg' = 'rad'): number {
    const mm = this.raw(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
    let len = mm;
    if (unit === 'inch') {
      const m = this.add('LENGTH_MEASURE_WITH_UNIT', `LENGTH_MEASURE(25.4),#${mm}`);
      const dim = this.add('DIMENSIONAL_EXPONENTS', `1.,0.,0.,0.,0.,0.,0.`);
      len = this.raw(`(CONVERSION_BASED_UNIT('INCH',#${m}) LENGTH_UNIT() NAMED_UNIT(#${dim}))`);
    }
    const rad = this.raw(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
    let ang = rad;
    if (angle === 'deg') {
      const m = this.add('PLANE_ANGLE_MEASURE_WITH_UNIT', `PLANE_ANGLE_MEASURE(0.0174532925199433),#${rad}`);
      const dim = this.add('DIMENSIONAL_EXPONENTS', `0.,0.,0.,0.,0.,0.,0.`);
      ang = this.raw(`(CONVERSION_BASED_UNIT('DEGREE',#${m}) NAMED_UNIT(#${dim}) PLANE_ANGLE_UNIT())`);
    }
    const sr = this.raw(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
    const unc = this.add('UNCERTAINTY_MEASURE_WITH_UNIT', `LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value',''`);
    return this.raw(
      `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sr})) REPRESENTATION_CONTEXT('',''))`,
    );
  }

  /** 제품 하나(이름, 형상 항목들) → { pd, rep } */
  product(name: string, items: number[], ctx: number, repType = 'ADVANCED_BREP_SHAPE_REPRESENTATION'): { pd: number; rep: number; origin: number } {
    const appCtx = this.add('APPLICATION_CONTEXT', `'mechanical design'`);
    const pc = this.add('PRODUCT_CONTEXT', `'',#${appCtx},'mechanical'`);
    const prod = this.add('PRODUCT', `'${name}','${name}','',(#${pc})`);
    const form = this.add('PRODUCT_DEFINITION_FORMATION', `'','',#${prod}`);
    const pdc = this.add('PRODUCT_DEFINITION_CONTEXT', `'part definition',#${appCtx},'design'`);
    const pd = this.add('PRODUCT_DEFINITION', `'design','',#${form},#${pdc}`);
    const pds = this.add('PRODUCT_DEFINITION_SHAPE', `'','',#${pd}`);
    const origin = this.ax2([0, 0, 0]);
    const rep = this.add(repType, `'${name}',(${[...items, origin].map((x) => `#${x}`).join(',')}),#${ctx}`);
    this.add('SHAPE_DEFINITION_REPRESENTATION', `#${pds},#${rep}`);
    return { pd, rep, origin };
  }

  /** 부모 제품에 자식 제품을 placement 위치로 놓는다 */
  place(parent: { pd: number; rep: number }, child: { pd: number; rep: number; origin: number }, placement: number, name: string): number {
    const nauo = this.add('NEXT_ASSEMBLY_USAGE_OCCURRENCE', `'${name}','${name}','',#${parent.pd},#${child.pd},$`);
    const idt = this.add('ITEM_DEFINED_TRANSFORMATION', `'','',#${child.origin},#${placement}`);
    const rel = this.raw(
      `(REPRESENTATION_RELATIONSHIP('','',#${child.rep},#${parent.rep}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt}) SHAPE_REPRESENTATION_RELATIONSHIP())`,
    );
    const pds = this.add('PRODUCT_DEFINITION_SHAPE', `'','',#${nauo}`);
    this.add('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION', `#${rel},#${pds}`);
    return nauo;
  }

  /** 면·입체 색 */
  color(item: number, rgb: P3, transparency = 0): number {
    const c = this.add('COLOUR_RGB', `'',${rgb.map(r).join(',')}`);
    const fc = this.add('FILL_AREA_STYLE_COLOUR', `'',#${c}`);
    const fs = this.add('FILL_AREA_STYLE', `'',(#${fc})`);
    const sfa = this.add('SURFACE_STYLE_FILL_AREA', `#${fs}`);
    const parts = [`#${sfa}`];
    if (transparency > 0) {
      const tr = this.add('SURFACE_STYLE_TRANSPARENT', r(transparency));
      parts.push(`#${this.add('SURFACE_STYLE_RENDERING_WITH_PROPERTIES', `.NORMAL_SHADING.,#${c},(#${tr})`)}`);
    }
    const sss = this.add('SURFACE_SIDE_STYLE', `'',(${parts.join(',')})`);
    const ssu = this.add('SURFACE_STYLE_USAGE', `.BOTH.,#${sss}`);
    const psa = this.add('PRESENTATION_STYLE_ASSIGNMENT', `(#${ssu})`);
    return this.add('STYLED_ITEM', `'color',(#${psa}),#${item}`);
  }

  toString(fileName = 'test.stp', schema = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'): string {
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('test model'),'2;1');",
      `FILE_NAME('${fileName}','2026-01-01T00:00:00',('author'),('org'),'pre','sys','');`,
      `FILE_SCHEMA(('${schema}'));`,
      'ENDSEC;',
      'DATA;',
      ...this.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
  }

  bytes(fileName?: string): Uint8Array {
    return new TextEncoder().encode(this.toString(fileName));
  }
}

// ── 입체 만들기 ──

/** 원점 모서리, 한 변 a인 정육면체(면 6, 직선 모서리 12) */
export function cube(w: StepText, a: number, o: P3 = [0, 0, 0]): { solid: number; faces: number[] } {
  const P = (i: number): P3 => [o[0] + (i & 1 ? a : 0), o[1] + (i & 2 ? a : 0), o[2] + (i & 4 ? a : 0)];
  const V = Array.from({ length: 8 }, (_, i) => w.vertex(P(i)));
  const edges = new Map<string, number>();
  const oe = (i: number, j: number) => {
    const k = i < j ? `${i}-${j}` : `${j}-${i}`;
    let e = edges.get(k);
    if (e === undefined) {
      const [s, t] = i < j ? [i, j] : [j, i];
      e = w.edge(V[s]!, V[t]!, w.line(P(s), P(t)));
      edges.set(k, e);
    }
    return w.oe(e, i < j);
  };
  // 바깥에서 볼 때 반시계 순서, 바깥 법선
  const quads: [number[], P3][] = [
    [[0, 2, 3, 1], [0, 0, -1]],
    [[4, 5, 7, 6], [0, 0, 1]],
    [[0, 1, 5, 4], [0, -1, 0]],
    [[2, 6, 7, 3], [0, 1, 0]],
    [[0, 4, 6, 2], [-1, 0, 0]],
    [[1, 3, 7, 5], [1, 0, 0]],
  ];
  const faces = quads.map(([q, n]) => {
    const lp = w.loop(q.map((i, k) => oe(i, q[(k + 1) % 4]!)));
    const x: P3 = Math.abs(n[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
    return w.face([w.bound(lp)], w.plane(P(q[0]!), n, x));
  });
  return { solid: w.solid(faces, 'cube'), faces };
}

/** 반지름 rad, 높이 h 원기둥(z축, 이음선 모서리 하나) */
export function cylinder(w: StepText, rad: number, h: number): number {
  const V0 = w.vertex([rad, 0, 0]);
  const V1 = w.vertex([rad, 0, h]);
  const C0 = w.edge(V0, V0, w.circle([0, 0, 0], rad));
  const C1 = w.edge(V1, V1, w.circle([0, 0, h], rad));
  const L = w.edge(V0, V1, w.line([rad, 0, 0], [rad, 0, h]));
  // 바닥: 평면 법선 +Z에 same_sense .F.(면 법선은 -Z)
  const bottom = w.face([w.bound(w.loop([w.oe(C0, false)]))], w.plane([0, 0, 0]), false);
  const top = w.face([w.bound(w.loop([w.oe(C1, true)]))], w.plane([0, 0, h]));
  const surf = w.add('CYLINDRICAL_SURFACE', `'',#${w.ax2([0, 0, 0])},${r(rad)}`);
  const side = w.face([w.bound(w.loop([w.oe(C0, true), w.oe(L, true), w.oe(C1, false), w.oe(L, false)]))], surf);
  return w.solid([bottom, top, side], 'cylinder');
}

/** 반지름 R 구(면 하나, 남극→북극 반원 이음선) */
export function sphere(w: StepText, R: number): number {
  const S = w.vertex([0, 0, -R]);
  const N = w.vertex([0, 0, R]);
  const arc = w.circle([0, 0, 0], R, [0, -1, 0], [1, 0, 0]);
  const E = w.edge(S, N, arc);
  const surf = w.add('SPHERICAL_SURFACE', `'',#${w.ax2([0, 0, 0])},${r(R)}`);
  const f = w.face([w.bound(w.loop([w.oe(E, true), w.oe(E, false)]))], surf);
  return w.solid([f], 'sphere');
}

/** 밑면 반지름 rad, 높이 h 원뿔(꼭짓점 위, VERTEX_LOOP) */
export function cone(w: StepText, rad: number, h: number, degrees = false): number {
  const V = w.vertex([rad, 0, 0]);
  const A = w.vertex([0, 0, h]);
  const B = w.edge(V, V, w.circle([0, 0, 0], rad));
  const bottom = w.face([w.bound(w.loop([w.oe(B, false)]))], w.plane([0, 0, 0], [0, 0, -1]));
  const ang = Math.atan2(rad, h);
  const surf = w.add('CONICAL_SURFACE', `'',#${w.ax2([0, 0, 0], [0, 0, -1], [1, 0, 0])},${r(rad)},${r(degrees ? (ang * 180) / Math.PI : ang)}`);
  const vl = w.add('VERTEX_LOOP', `'',#${A}`);
  const side = w.face([w.bound(w.loop([w.oe(B, true)])), w.bound(vl, false)], surf);
  return w.solid([bottom, side], 'cone');
}

/** 원환(큰 반지름 R, 작은 반지름 rr), 두 이음선 원 */
export function torus(w: StepText, R: number, rr: number): number {
  const V = w.vertex([R + rr, 0, 0]);
  const Q = w.edge(V, V, w.circle([0, 0, 0], R + rr));
  const M = w.edge(V, V, w.circle([R, 0, 0], rr, [0, -1, 0], [1, 0, 0]));
  const surf = w.add('TOROIDAL_SURFACE', `'',#${w.ax2([0, 0, 0])},${r(R)},${r(rr)}`);
  const f = w.face([w.bound(w.loop([w.oe(Q, true), w.oe(M, true), w.oe(Q, false), w.oe(M, false)]))], surf);
  return w.solid([f], 'torus');
}

/** 20×10×2 판에 (10,5) 중심 반지름 2 관통 구멍 */
export function plateWithHole(w: StepText): number {
  const W = 20;
  const D = 10;
  const H = 2;
  const c: P3 = [10, 5, 0];
  const rad = 2;
  const P = (i: number): P3 => [i & 1 ? W : 0, i & 2 ? D : 0, i & 4 ? H : 0];
  const V = Array.from({ length: 8 }, (_, i) => w.vertex(P(i)));
  const edges = new Map<string, number>();
  const oe = (i: number, j: number) => {
    const k = i < j ? `${i}-${j}` : `${j}-${i}`;
    let e = edges.get(k);
    if (e === undefined) {
      const [s, t] = i < j ? [i, j] : [j, i];
      e = w.edge(V[s]!, V[t]!, w.line(P(s), P(t)));
      edges.set(k, e);
    }
    return w.oe(e, i < j);
  };
  const quad = (q: number[]) => w.loop(q.map((i, k) => oe(i, q[(k + 1) % 4]!)));
  // 구멍 모서리
  const Hb = w.vertex([c[0] + rad, c[1], 0]);
  const Ht = w.vertex([c[0] + rad, c[1], H]);
  const Cb = w.edge(Hb, Hb, w.circle([c[0], c[1], 0], rad));
  const Ct = w.edge(Ht, Ht, w.circle([c[0], c[1], H], rad));
  const L = w.edge(Hb, Ht, w.line([c[0] + rad, c[1], 0], [c[0] + rad, c[1], H]));
  const faces = [
    // 바닥(법선 -Z): 평면 +Z, same_sense .F., 바깥 고리는 위에서 볼 때 시계, 구멍은 반시계
    w.face([w.bound(quad([0, 2, 3, 1])), w.bound(w.loop([w.oe(Cb, true)]), false)], w.plane([0, 0, 0]), false),
    w.face([w.bound(quad([4, 5, 7, 6])), w.bound(w.loop([w.oe(Ct, false)]), false)], w.plane([0, 0, H])),
    w.face([w.bound(quad([0, 1, 5, 4]))], w.plane([0, 0, 0], [0, -1, 0])),
    w.face([w.bound(quad([2, 6, 7, 3]))], w.plane([0, D, 0], [0, 1, 0])),
    w.face([w.bound(quad([0, 4, 6, 2]))], w.plane([0, 0, 0], [-1, 0, 0], [0, 1, 0])),
    w.face([w.bound(quad([1, 3, 7, 5]))], w.plane([W, 0, 0], [1, 0, 0], [0, 1, 0])),
    // 구멍 벽(법선은 축 쪽): 원기둥 same_sense .F.
    w.face(
      [w.bound(w.loop([w.oe(L, true), w.oe(Ct, true), w.oe(L, false), w.oe(Cb, false)]))],
      w.add('CYLINDRICAL_SURFACE', `'',#${w.ax2(c)},${r(rad)}`),
      false,
    ),
  ];
  return w.solid(faces, 'plate');
}
