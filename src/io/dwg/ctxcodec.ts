/**
 * 주석 축척 컨텍스트 데이터(AcDbObjectContextData 계열)의 DWG 본문 ↔ DXF와 같은 원본 태그(GenericObject.raw).
 *
 * 공통(사양 20.4.89·20.4.71, 표본으로 고침): BS 70 클래스 판(AC1024 이상 4, 그 전 3), B 290 기본 — 사양의 "확장 사전 파일
 * 있음" 비트는 없다 —, 핸들 흐름 첫 자리 H 340 축척(하드 포인터). DXF는 `100 AcDbObjectContextData`, 70, 290,
 * `100 AcDbAnnotScaleObjectContextData`, 340, 그 뒤 종류별 태그(DWG 순서와 같다. 다른 곳은 함수 주석에).
 *
 * 종류별 배치(DXF 그룹 = DWG 형식):
 * - TEXT: BS 70 수평 정렬, BD 50 회전(DXF는 도), 2RD 10 첫 점, 2RD 11 정렬점. AutoCAD DXF 실물과 태그가 같다.
 * - MTEXTATTRIBUTE: TEXT + B 290 여러 줄. 여러 줄(1, 포함 객체가 따른다)은 풀지 않는다.
 * - BLKREF: BD 50 회전(도), 3BD 10 삽입점, BD 41·42·43 축척.
 * - MTEXT: BL 70 부착점, 3BD 10 X축 방향, 3BD 11 위치, BD 40 폭, BD 41 정의 높이, BD 42·43 문자 범위, BL 71 열 종류,
 *   열이 있으면 BL 72 수, BD 44 폭, BD 45 거터, B 73 자동 높이, B 74 흐름 반전(손으로 높이를 준 열은 풀지 않는다).
 * - 치수 6종(ALDIM·ANGDIM·RADIM·DMDIM·ORDDIM·RADIMLRG): `100 AcDbDimensionObjectContextData`, 2 그 축척의 익명 블록
 *   (DWG는 블록 레코드 하드 포인터, DXF는 이름), 293, 10·20 문자 위치(2RD), 294 문자가 기본 자리(B), 140 문자 회전(BD,
 *   DXF도 라디안), 298·291·70·292·71·280·295(DWG 15비트, 실물은 모두 0 — 0이 아니면 풀지 않는다), 296·297 화살표 뒤집기(B),
 *   종류 표지(`AcDbAlignedDimensionObjectContextData` …) 뒤 종류별 점(3BD): ALDIM·ANGDIM·RADIM 11, DMDIM·ORDDIM 11·12,
 *   RADIMLRG 11·12·13. DWG 순서는 10, 294, 140, (2는 핸들 흐름), 15비트, 296, 297, 점 — DXF에서 293은 10 앞에 있다.
 * - HATCHSCALE: `100 AcDbHatchObjectContextData`, BL 78 패턴 선 수, 선마다 BD 53 각도(DXF는 도), BD 43·44 기준점,
 *   BD 45·46 간격띄우기, BS 79 대시 수, BD 49 대시…; BD 40 그 축척의 배율, 3BD 10 패턴 방향, BL 90 루프 수,
 *   루프마다 BL 90 종류와 B 290(실물은 모두 1 — 0이면 경계 자료가 따르므로 풀지 않는다).
 * - HATCHVIEW(ACDB_ANNOTATIONSCALE_VIEW_COLLECTION): HATCHSCALE 필드, `100 AcDbHatchViewContextData`, H 330 뷰포트
 *   (소프트 포인터), 3BD 10 시선, BD 51 비틀림, B 290.
 * - MLEADER: 다중 지시선 컨텍스트 자료(사양 20.4.86 MLeaderAnnotContext) 전체. DXF는 MULTILEADER의 `300 CONTEXT_DATA{`
 *   ~ `301 }` 사이 태그와 같은 순서(내용 → 지시선)이고 DWG는 지시선이 먼저다. 재지정이 없는(93 = 0) 지시선 선의 특성
 *   (170·92·340·171·40·341·93)은 DXF에 쓰지 않는다(AutoCAD DXF의 MULTILEADER와 같다).
 * - LEADER: BL 70 꼭짓점 수, 3BD 10 꼭짓점…, 3BD 11 수평 방향, B 290, 3BD 12·13 간격띄우기.
 *
 * 배치는 ODA 공개 사양(20.4.71·20.4.86·20.4.89)과 AutoCAD가 저장한 표본(문자·속성·블록 참조 레코드, 다중 지시선 객체의 같은
 * 컨텍스트 자료)으로 맞추었다. 치수·해치 레코드는 표본이 없어 기능 명세(annotation-scale.md 6.1)의 배치를 따른다.
 * 읽다가 배치가 맞지 않으면 CtxLayoutError — 부르는 쪽은 원본 비트만 남긴다.
 */
import type { RawTag, Vec3 } from '../../core/model';
import type { BitReader } from './bitstream';
import { R2004, R2010 } from './version';

export type CtxKind = 'text' | 'attrib' | 'blkref' | 'mtext' | 'dim' | 'hatch' | 'hatchview' | 'mleader' | 'leader';

/** 치수 종류별 DXF 표지와 점 */
export const DIM_CTX: Readonly<Record<string, { marker: string; points: number[] }>> = {
  ACDB_ALDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbAlignedDimensionObjectContextData', points: [11] },
  ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbAngularDimensionObjectContextData', points: [11] },
  ACDB_RADIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbRadialDimensionObjectContextData', points: [11] },
  ACDB_DMDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbDiametricDimensionObjectContextData', points: [11, 12] },
  ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbOrdinateDimensionObjectContextData', points: [11, 12] },
  ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbRadialDimensionLargeObjectContextData', points: [11, 12, 13] },
};

/** 컨텍스트 데이터 클래스(DXF 이름) → 종류 */
export const CTX_TYPES: ReadonlyMap<string, CtxKind> = new Map<string, CtxKind>([
  ['ACDB_TEXTOBJECTCONTEXTDATA_CLASS', 'text'],
  ['ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS', 'attrib'],
  ['ACDB_BLKREFOBJECTCONTEXTDATA_CLASS', 'blkref'],
  ['ACDB_MTEXTOBJECTCONTEXTDATA_CLASS', 'mtext'],
  ...Object.keys(DIM_CTX).map((k) => [k, 'dim'] as [string, CtxKind]),
  ['ACDB_HATCHSCALECONTEXTDATA_CLASS', 'hatch'],
  ['ACDB_HATCHVIEWCONTEXTDATA_CLASS', 'hatchview'],
  ['ACDB_MLEADEROBJECTCONTEXTDATA_CLASS', 'mleader'],
  ['ACDB_LEADEROBJECTCONTEXTDATA_CLASS', 'leader'],
]);

/** 클래스 C++ 이름(AutoCAD 표본의 클래스 목록, 없는 것은 같은 규칙) */
export const CTX_CPP: Readonly<Record<string, string>> = {
  ACDB_TEXTOBJECTCONTEXTDATA_CLASS: 'AcDbTextObjectContextData',
  ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS: 'AcDbMTextAttributeObjectContextData',
  ACDB_BLKREFOBJECTCONTEXTDATA_CLASS: 'AcDbBlkRefObjectContextData',
  ACDB_MTEXTOBJECTCONTEXTDATA_CLASS: 'AcDbMTextObjectContextData',
  ACDB_ALDIMOBJECTCONTEXTDATA_CLASS: 'AcDbAlignedDimensionObjectContextData',
  ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS: 'AcDbAngularDimensionObjectContextData',
  ACDB_RADIMOBJECTCONTEXTDATA_CLASS: 'AcDbRadialDimensionObjectContextData',
  ACDB_DMDIMOBJECTCONTEXTDATA_CLASS: 'AcDbDiametricDimensionObjectContextData',
  ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS: 'AcDbOrdinateDimensionObjectContextData',
  ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS: 'AcDbRadialDimensionLargeObjectContextData',
  ACDB_HATCHSCALECONTEXTDATA_CLASS: 'AcDbHatchScaleContextData',
  ACDB_HATCHVIEWCONTEXTDATA_CLASS: 'AcDbHatchViewContextData',
  ACDB_MLEADEROBJECTCONTEXTDATA_CLASS: 'AcDbMLeaderObjectContextData',
  ACDB_LEADEROBJECTCONTEXTDATA_CLASS: 'AcDbLeaderObjectContextData',
};

/** 이 버전 파일에 쓰는 클래스 판(70): AC1024 이상 4, 그 전 3 */
export function ctxClassVersion(ver: number): number {
  return ver >= R2010 ? 4 : 3;
}

export class CtxLayoutError extends Error {}

const fail = (what: string): never => {
  throw new CtxLayoutError(what);
};

const HARD_PTR = 5;
const SOFT_PTR = 4;
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const hexOf = (h: number): string => (h > 0 ? h.toString(16).toUpperCase() : '0');

/** 쓰기 명령 */
export type CtxOp =
  | { t: 'B' | 'RC' | 'BS' | 'BL' | 'BD' | 'RD'; v: number }
  | { t: 'TV'; v: string }
  | { t: '3BD'; v: Vec3 }
  /** 색(DXF 원시 정수: 0xC0… ByLayer, 0xC1… ByBlock, 0xC2RRGGBB, 0xC3… ACI) */
  | { t: 'CMC'; v: number }
  /** 블록 이름(쓸 때 블록 레코드 핸들로) */
  | { t: 'HB'; code: number; name: string }
  | { t: 'H'; code: number; h: string };

const num = (v: string | number | undefined, d = 0): number => {
  if (v === undefined) return d;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : d;
};
const int = (v: string | number | undefined, d = 0): number => Math.trunc(num(v, d));

// ---------------------------------------------------------------------------
// 읽기

class In {
  readonly tags: RawTag[] = [];
  constructor(
    readonly r: BitReader,
    readonly hr: BitReader,
    readonly base: number,
    readonly ver: number,
  ) {}
  B = () => this.r.B();
  BS = () => this.r.BS();
  BL = () => this.r.BL();
  BD = () => this.r.BD();
  RD = () => this.r.RD();
  TV = () => this.r.TV();
  P = () => this.r.BD3();
  H = () => hexOf(this.hr.H(this.base));
  /** 개수(BL): 남은 자료 비트로 가능한지 본다 */
  N = (min = 1) => this.r.checkCount(this.r.BL(), min);
  /** 색: R2004+ BS(0) + BL 원시 값 + RC 이름 플래그, 그 전은 BS ACI */
  CMC = (): number => {
    const idx = this.r.BS();
    if (this.ver < R2004) return aciRaw(idx);
    const raw = this.r.BLu() | 0;
    const flags = this.r.RC();
    if (flags & 3) fail('색 이름');
    if (idx !== 0) fail(`색 번호 ${idx}`);
    return raw;
  };
  tag(code: number, value: string | number): void {
    this.tags.push({ code, value });
  }
  pt(code: number, p: Vec3): void {
    this.tags.push({ code, value: p.x }, { code: code + 10, value: p.y }, { code: code + 20, value: p.z });
  }
  sub(name: string): void {
    this.tags.push({ code: 100, value: name });
  }
}

/** ACI 번호 → 원시 색 정수 */
function aciRaw(i: number): number {
  if (i === 256) return 0xc0000000 | 0;
  if (i === 0) return 0xc1000000 | 0;
  if (i === 257) return 0xc8000000 | 0;
  return (0xc3000000 | (i & 0xff)) | 0;
}

/** 원시 색 정수 → ACI 번호(R2000 CMC) */
function rawAci(v: number): number {
  const m = (v >>> 24) & 0xff;
  if (m === 0xc0) return 256;
  if (m === 0xc1) return 0;
  if (m === 0xc8) return 257;
  if (m === 0xc3) return v & 0xff;
  return 7;
}

function rHead(i: In): void {
  i.sub('AcDbObjectContextData');
  i.tag(70, i.BS());
  i.tag(290, i.B());
  i.sub('AcDbAnnotScaleObjectContextData');
  i.tag(340, i.H());
}

function rText(i: In, attrib: boolean): void {
  i.tag(70, i.BS());
  i.tag(50, i.BD() * RAD2DEG);
  i.tag(10, i.RD());
  i.tag(20, i.RD());
  i.tag(11, i.RD());
  i.tag(21, i.RD());
  if (attrib) {
    const ml = i.B();
    if (ml) fail('여러 줄 속성');
    i.tag(290, ml);
  }
}

function rBlkRef(i: In): void {
  i.tag(50, i.BD() * RAD2DEG);
  i.pt(10, i.P());
  i.tag(41, i.BD());
  i.tag(42, i.BD());
  i.tag(43, i.BD());
}

function rMText(i: In): void {
  i.tag(70, i.BL());
  i.pt(10, i.P());
  i.pt(11, i.P());
  i.tag(40, i.BD());
  i.tag(41, i.BD());
  i.tag(42, i.BD());
  i.tag(43, i.BD());
  const ct = i.BL();
  i.tag(71, ct);
  if (ct) {
    i.tag(72, i.BL());
    i.tag(44, i.BD());
    i.tag(45, i.BD());
    const auto = i.B();
    i.tag(73, auto);
    i.tag(74, i.B());
    if (ct === 2 && !auto) fail('열 높이');
  }
}

/** 치수의 15비트 묶음에 해당하는 DXF 그룹(순서) */
const DIM_FLAG_CODES = [298, 291, 70, 292, 71, 280, 295] as const;
const DIM_FLAG_BITS = 15;

function rDim(i: In, type: string): void {
  const spec = DIM_CTX[type]!;
  const tx = i.RD();
  const ty = i.RD();
  const def = i.B();
  const rot = i.BD();
  const block = i.H();
  for (let k = 0; k < DIM_FLAG_BITS; k++) if (i.B()) fail('치수 플래그');
  const f1 = i.B();
  const f2 = i.B();
  i.sub('AcDbDimensionObjectContextData');
  // 블록은 핸들(읽기가 끝난 뒤 build.ts가 이름으로 바꾼다)
  i.tag(2, block);
  i.tag(293, 0);
  i.tag(10, tx);
  i.tag(20, ty);
  i.tag(294, def);
  i.tag(140, rot);
  for (const c of DIM_FLAG_CODES) i.tag(c, 0);
  i.tag(296, f1);
  i.tag(297, f2);
  i.sub(spec.marker);
  for (const c of spec.points) i.pt(c, i.P());
}

function rHatchFields(i: In): void {
  i.sub('AcDbHatchObjectContextData');
  const n = i.N(5);
  i.tag(78, n);
  for (let k = 0; k < n; k++) {
    i.tag(53, i.BD() * RAD2DEG);
    i.tag(43, i.BD());
    i.tag(44, i.BD());
    i.tag(45, i.BD());
    i.tag(46, i.BD());
    const nd = i.BS();
    if (nd < 0 || nd > 64) fail('대시 수');
    i.tag(79, nd);
    for (let d = 0; d < nd; d++) i.tag(49, i.BD());
  }
  i.tag(40, i.BD());
  i.pt(10, i.P());
  const nl = i.N(3);
  i.tag(90, nl);
  for (let k = 0; k < nl; k++) {
    i.tag(90, i.BL());
    const b = i.B();
    if (!b) fail('해치 루프 자료');
    i.tag(290, b);
  }
}

function rHatchView(i: In): void {
  rHatchFields(i);
  i.sub('AcDbHatchViewContextData');
  i.tag(330, i.H());
  i.pt(10, i.P());
  i.tag(51, i.BD());
  i.tag(290, i.B());
}

function rLeader(i: In): void {
  const n = i.N(3);
  i.tag(70, n);
  for (let k = 0; k < n; k++) i.pt(10, i.P());
  i.pt(11, i.P());
  i.tag(290, i.B());
  i.pt(12, i.P());
  i.pt(13, i.P());
}

/**
 * 다중 지시선 컨텍스트 자료(MULTILEADER 본문의 같은 자리와 같다). DXF 순서의 태그(300·301 없이)를 i에 더한다.
 * 지시선 루트는 DWG에서 내용보다 앞이므로 따로 모았다가 내용 뒤에 붙인다.
 */
export function readMLeaderContext(r: BitReader, hr: BitReader, base: number, ver: number): RawTag[] {
  const i = new In(r, hr, base, ver);
  rMLeader(i);
  return i.tags;
}

function rMLeader(i: In): void {
  const ver = i.ver;
  const roots: RawTag[] = [];
  const nr = i.N(8);
  for (let k = 0; k < nr; k++) {
    const t: RawTag[] = [];
    const tag = (code: number, value: string | number) => t.push({ code, value });
    const pt = (code: number, p: Vec3) => t.push({ code, value: p.x }, { code: code + 10, value: p.y }, { code: code + 20, value: p.z });
    tag(302, 'LEADER{');
    tag(290, i.B());
    tag(291, i.B());
    pt(10, i.P());
    pt(11, i.P());
    const nb = i.N(6);
    for (let b = 0; b < nb; b++) {
      pt(12, i.P());
      pt(13, i.P());
    }
    tag(90, i.BL());
    tag(40, i.BD());
    const nl = i.N(4);
    for (let l = 0; l < nl; l++) {
      tag(304, 'LEADER_LINE{');
      const np = i.N(6);
      for (let p = 0; p < np; p++) pt(10, i.P());
      const nbi = i.N(4);
      for (let b = 0; b < nbi; b++) {
        tag(90, i.BL());
        const npairs = i.N(6);
        for (let q = 0; q < npairs; q++) {
          pt(11, i.P());
          pt(12, i.P());
        }
      }
      tag(91, i.BL());
      if (ver >= R2010) {
        const lt = i.BS();
        const col = i.CMC();
        const ltype = i.H();
        const lw = i.BL();
        const arrow = i.BD();
        const ah = i.H();
        const flags = i.BL();
        if (flags) {
          tag(170, lt);
          tag(92, col);
          tag(340, ltype);
          tag(171, lw);
          tag(40, arrow);
          tag(341, ah);
          tag(93, flags);
        }
      }
      tag(305, '}');
    }
    if (ver >= R2010) tag(271, i.BS());
    tag(303, '}');
    roots.push(...t);
  }
  i.tag(40, i.BD());
  i.pt(10, i.P());
  i.tag(41, i.BD());
  i.tag(140, i.BD());
  i.tag(145, i.BD());
  i.tag(174, i.BS());
  i.tag(175, i.BS());
  i.tag(176, i.BS());
  i.tag(177, i.BS());
  const hasText = i.B();
  i.tag(290, hasText);
  if (hasText) {
    i.tag(304, i.TV());
    i.pt(11, i.P());
    i.tag(340, i.H());
    i.pt(12, i.P());
    i.pt(13, i.P());
    i.tag(42, i.BD());
    i.tag(43, i.BD());
    i.tag(44, i.BD());
    i.tag(45, i.BD());
    i.tag(170, i.BS());
    i.tag(90, i.CMC());
    i.tag(171, i.BS());
    i.tag(172, i.BS());
    i.tag(91, i.CMC());
    i.tag(141, i.BD());
    i.tag(92, i.BL());
    i.tag(291, i.B());
    i.tag(292, i.B());
    i.tag(173, i.BS());
    i.tag(293, i.B());
    i.tag(142, i.BD());
    i.tag(143, i.BD());
    i.tag(294, i.B());
    const nc = i.N(2);
    for (let c = 0; c < nc; c++) i.tag(144, i.BD());
    i.tag(295, i.B());
  }
  // 사양은 "문자가 없으면" 아래에 두었지만, 문자가 있을 때도 비트 하나(늘 0 = DXF 296)가 있다
  const hasBlock = i.B();
  i.tag(296, hasBlock);
  if (hasBlock) {
    if (hasText) fail('문자와 블록');
    i.tag(341, hexOf(i.hr.H(i.base)));
    i.pt(14, i.P());
    i.pt(15, i.P());
    i.pt(16, i.P());
    i.tag(46, i.BD());
    i.tag(93, i.CMC());
    for (let m = 0; m < 16; m++) i.tag(47, i.BD());
  }
  i.pt(110, i.P());
  i.pt(111, i.P());
  i.pt(112, i.P());
  i.tag(297, i.B());
  let top = 0;
  let bottom = 0;
  if (ver >= R2010) {
    top = i.BS();
    bottom = i.BS();
  }
  i.tags.push(...roots);
  if (ver >= R2010) {
    i.tag(272, bottom);
    i.tag(273, top);
  }
}

/**
 * 공통 자료 다음 본문을 DXF 태그로 푼다. 배치가 맞지 않으면 CtxLayoutError.
 * 치수의 2(블록)는 블록 레코드 핸들로 둔다(부르는 쪽이 이름으로 바꾼다). 다 읽었는지는 부르는 쪽이 본다.
 */
export function decodeCtx(type: string, dat: BitReader, hdl: BitReader, base: number, ver: number): RawTag[] {
  const kind = CTX_TYPES.get(type);
  if (!kind) fail(type);
  const i = new In(dat, hdl, base, ver);
  rHead(i);
  switch (kind) {
    case 'text':
      rText(i, false);
      break;
    case 'attrib':
      rText(i, true);
      break;
    case 'blkref':
      rBlkRef(i);
      break;
    case 'mtext':
      rMText(i);
      break;
    case 'dim':
      rDim(i, type);
      break;
    case 'hatch':
      rHatchFields(i);
      break;
    case 'hatchview':
      rHatchView(i);
      break;
    case 'mleader':
      rMLeader(i);
      break;
    case 'leader':
      rLeader(i);
      break;
  }
  return i.tags;
}

// ---------------------------------------------------------------------------
// 쓰기

class Out {
  readonly ops: CtxOp[] = [];
  B = (v: number | boolean) => this.ops.push({ t: 'B', v: v ? 1 : 0 });
  BS = (v: number) => this.ops.push({ t: 'BS', v });
  BL = (v: number) => this.ops.push({ t: 'BL', v });
  BD = (v: number) => this.ops.push({ t: 'BD', v });
  RD = (v: number) => this.ops.push({ t: 'RD', v });
  TV = (v: string) => this.ops.push({ t: 'TV', v });
  P = (v: Vec3) => this.ops.push({ t: '3BD', v });
  CMC = (v: number) => this.ops.push({ t: 'CMC', v });
  H = (code: number, h: string) => this.ops.push({ t: 'H', code, h });
}

/** 태그를 차례로 읽는 커서 */
class Cur {
  i = 0;
  constructor(readonly tags: readonly RawTag[]) {}
  peek(): number | undefined {
    return this.tags[this.i]?.code;
  }
  has(code: number): boolean {
    return this.peek() === code;
  }
  opt(code: number): string | number | undefined {
    const t = this.tags[this.i];
    if (!t || t.code !== code) return undefined;
    this.i++;
    return t.value;
  }
  need(code: number): string | number {
    const v = this.opt(code);
    if (v === undefined) fail(`태그 ${code} (${this.peek() ?? '끝'})`);
    return v!;
  }
  int(code: number): number {
    return int(this.need(code));
  }
  num(code: number): number {
    return num(this.need(code));
  }
  str(code: number): string {
    return String(this.need(code));
  }
  handle(code: number): string {
    return String(this.need(code)).trim().toUpperCase() || '0';
  }
  pt(code: number): Vec3 {
    const x = this.num(code);
    const y = num(this.opt(code + 10));
    const z = num(this.opt(code + 20));
    return { x, y, z };
  }
  /** 2D 점(10·20, 30이 있으면 넘긴다) */
  pt2(code: number): { x: number; y: number } {
    const x = this.num(code);
    const y = num(this.opt(code + 10));
    this.opt(code + 20);
    return { x, y };
  }
  marker(name: string): void {
    const t = this.tags[this.i];
    if (!t || t.code !== 100 || String(t.value).trim() !== name) fail(`표지 ${name}`);
    this.i++;
  }
  optMarker(name: string): boolean {
    const t = this.tags[this.i];
    if (t && t.code === 100 && String(t.value).trim() === name) {
      this.i++;
      return true;
    }
    return false;
  }
  end(): void {
    if (this.i < this.tags.length) fail(`남은 태그 ${this.tags[this.i]!.code}`);
  }
}

function wHead(o: Out, c: Cur, ver: number): void {
  c.marker('AcDbObjectContextData');
  c.int(70);
  const def = c.int(290);
  c.marker('AcDbAnnotScaleObjectContextData');
  const scale = c.handle(340);
  o.BS(ctxClassVersion(ver));
  o.B(def);
  o.H(HARD_PTR, scale);
}

function wText(o: Out, c: Cur, attrib: boolean): void {
  o.BS(c.int(70));
  o.BD(c.num(50) * DEG2RAD);
  const p = c.pt2(10);
  o.RD(p.x);
  o.RD(p.y);
  const a = c.pt2(11);
  o.RD(a.x);
  o.RD(a.y);
  if (attrib) {
    const ml = int(c.opt(290));
    if (ml) fail('여러 줄 속성');
    o.B(0);
  }
}

function wBlkRef(o: Out, c: Cur): void {
  o.BD(c.num(50) * DEG2RAD);
  o.P(c.pt(10));
  // 예전 빌드가 쓴 꼴(42·43·44)도 받는다
  if (c.has(41)) {
    o.BD(c.num(41));
    o.BD(c.num(42));
    o.BD(c.num(43));
  } else {
    o.BD(c.num(42));
    o.BD(c.num(43));
    o.BD(c.num(44));
  }
}

function wMText(o: Out, c: Cur): void {
  o.BL(c.int(70));
  o.P(c.pt(10));
  o.P(c.pt(11));
  o.BD(c.num(40));
  o.BD(c.num(41));
  o.BD(c.num(42));
  o.BD(c.num(43));
  const ct = c.int(71);
  o.BL(ct);
  if (ct) {
    o.BL(c.int(72));
    o.BD(c.num(44));
    o.BD(c.num(45));
    const auto = c.int(73);
    o.B(auto);
    o.B(c.int(74));
    if (ct === 2 && !auto) fail('열 높이');
  }
}

function wDim(o: Out, c: Cur, type: string): void {
  const spec = DIM_CTX[type]!;
  c.marker('AcDbDimensionObjectContextData');
  // 순서가 조금 달라도(다른 프로그램) 받는다: 표지 다음 태그를 코드로 모은다
  const seen = new Map<number, string | number>();
  while (c.i < c.tags.length && c.peek() !== 100) {
    const t = c.tags[c.i++]!;
    if (!seen.has(t.code)) seen.set(t.code, t.value);
  }
  for (const code of [293, ...DIM_FLAG_CODES]) if (int(seen.get(code))) fail(`치수 플래그 ${code}`);
  o.RD(num(seen.get(10)));
  o.RD(num(seen.get(20)));
  o.B(int(seen.get(294)));
  o.BD(num(seen.get(140)));
  const name = String(seen.get(2) ?? '').trim();
  o.ops.push({ t: 'HB', code: HARD_PTR, name });
  for (let k = 0; k < DIM_FLAG_BITS; k++) o.B(0);
  o.B(int(seen.get(296)));
  o.B(int(seen.get(297)));
  c.marker(spec.marker);
  for (const code of spec.points) o.P(c.pt(code));
}

function wHatchFields(o: Out, c: Cur): void {
  c.marker('AcDbHatchObjectContextData');
  const n = c.int(78);
  o.BL(n);
  for (let k = 0; k < n; k++) {
    o.BD(c.num(53) * DEG2RAD);
    o.BD(c.num(43));
    o.BD(c.num(44));
    o.BD(c.num(45));
    o.BD(c.num(46));
    const nd = c.int(79);
    o.BS(nd);
    for (let d = 0; d < nd; d++) o.BD(c.num(49));
  }
  o.BD(c.num(40));
  o.P(c.pt(10));
  const nl = c.int(90);
  o.BL(nl);
  for (let k = 0; k < nl; k++) {
    o.BL(c.int(90));
    const b = c.int(290);
    if (!b) fail('해치 루프 자료');
    o.B(1);
  }
}

function wHatchView(o: Out, c: Cur): void {
  wHatchFields(o, c);
  c.marker('AcDbHatchViewContextData');
  o.H(SOFT_PTR, c.handle(330));
  o.P(c.pt(10));
  o.BD(c.num(51));
  o.B(c.int(290));
}

function wLeader(o: Out, c: Cur): void {
  const n = c.int(70);
  o.BL(n);
  for (let k = 0; k < n; k++) o.P(c.pt(10));
  o.P(c.pt(11));
  o.B(c.int(290));
  o.P(c.pt(12));
  o.P(c.pt(13));
}

/** 다중 지시선 컨텍스트 자료: DXF 순서 태그 → DWG 순서 명령 */
function wMLeader(o: Out, c: Cur, ver: number): void {
  const body = new Out();
  body.BD(c.num(40));
  body.P(c.pt(10));
  body.BD(c.num(41));
  body.BD(c.num(140));
  body.BD(c.num(145));
  body.BS(c.int(174));
  body.BS(c.int(175));
  body.BS(c.int(176));
  body.BS(c.int(177));
  const hasText = c.int(290);
  body.B(hasText);
  if (hasText) {
    body.TV(c.str(304));
    body.P(c.pt(11));
    body.H(HARD_PTR, c.handle(340));
    body.P(c.pt(12));
    body.P(c.pt(13));
    body.BD(c.num(42));
    body.BD(c.num(43));
    body.BD(c.num(44));
    body.BD(c.num(45));
    body.BS(c.int(170));
    body.CMC(c.int(90));
    body.BS(c.int(171));
    body.BS(c.int(172));
    body.CMC(c.int(91));
    body.BD(c.num(141));
    body.BL(c.int(92));
    body.B(c.int(291));
    body.B(c.int(292));
    body.BS(c.int(173));
    body.B(c.int(293));
    body.BD(c.num(142));
    body.BD(c.num(143));
    body.B(c.int(294));
    const sizes: number[] = [];
    while (c.has(144)) sizes.push(c.num(144));
    body.BL(sizes.length);
    for (const s of sizes) body.BD(s);
    body.B(c.int(295));
  }
  const hasBlock = int(c.opt(296));
  body.B(hasBlock);
  if (hasBlock) {
    if (hasText) fail('문자와 블록');
    body.H(SOFT_PTR, c.handle(341));
    body.P(c.pt(14));
    body.P(c.pt(15));
    body.P(c.pt(16));
    body.BD(c.num(46));
    body.CMC(c.int(93));
    for (let m = 0; m < 16; m++) body.BD(num(c.opt(47), m % 5 === 0 ? 1 : 0));
  }
  body.P(c.pt(110));
  body.P(c.pt(111));
  body.P(c.pt(112));
  body.B(c.int(297));
  // 지시선 루트
  const roots: Out[] = [];
  while (c.has(302)) {
    c.need(302);
    const r = new Out();
    r.B(c.int(290));
    r.B(c.int(291));
    r.P(c.pt(10));
    r.P(c.pt(11));
    const breaks: Vec3[] = [];
    while (c.has(12)) {
      breaks.push(c.pt(12));
      breaks.push(c.pt(13));
    }
    r.BL(breaks.length / 2);
    for (const p of breaks) r.P(p);
    r.BL(c.int(90));
    r.BD(c.num(40));
    const lines: Out[] = [];
    while (c.has(304)) {
      c.need(304);
      const l = new Out();
      const pts: Vec3[] = [];
      while (c.has(10)) pts.push(c.pt(10));
      l.BL(pts.length);
      for (const p of pts) l.P(p);
      const infos: { seg: number; pairs: Vec3[] }[] = [];
      while (c.has(90)) {
        const info = { seg: c.int(90), pairs: [] as Vec3[] };
        while (c.has(11)) {
          info.pairs.push(c.pt(11));
          info.pairs.push(c.pt(12));
        }
        infos.push(info);
      }
      l.BL(infos.length);
      for (const info of infos) {
        l.BL(info.seg);
        l.BL(info.pairs.length / 2);
        for (const p of info.pairs) l.P(p);
      }
      l.BL(c.int(91));
      // 재지정 특성(93 = 0이면 DXF에 없다)
      const lt = int(c.opt(170), 1);
      const col = int(c.opt(92), 0xc1000000 | 0);
      const ltype = c.has(340) ? c.handle(340) : '0';
      const lw = int(c.opt(171), -2);
      const arrow = num(c.opt(40));
      const ah = c.has(341) ? c.handle(341) : '0';
      const flags = int(c.opt(93));
      if (ver >= R2010) {
        l.BS(lt);
        l.CMC(col);
        l.H(HARD_PTR, ltype);
        l.BL(lw);
        l.BD(arrow);
        l.H(HARD_PTR, ah);
        l.BL(flags);
      }
      c.need(305);
      lines.push(l);
    }
    r.BL(lines.length);
    for (const l of lines) r.ops.push(...l.ops);
    const dir = int(c.opt(271));
    if (ver >= R2010) r.BS(dir);
    c.need(303);
    roots.push(r);
  }
  const bottom = int(c.opt(272), 9);
  const top = int(c.opt(273), 9);
  o.BL(roots.length);
  for (const r of roots) o.ops.push(...r.ops);
  o.ops.push(...body.ops);
  if (ver >= R2010) {
    o.BS(top);
    o.BS(bottom);
  }
}

/** 다중 지시선 컨텍스트 자료 태그(300·301 없이) → DWG 명령. 풀 수 없으면 null */
export function encodeMLeaderContext(tags: readonly RawTag[], ver: number): CtxOp[] | null {
  const o = new Out();
  const c = new Cur(tags);
  try {
    wMLeader(o, c, ver);
    c.end();
  } catch (e) {
    if (e instanceof CtxLayoutError) return null;
    throw e;
  }
  return o.ops;
}

/** 원본 태그 → DWG 쓰기 명령(공통 자료 다음 본문). 풀 수 없으면 null */
export function encodeCtx(type: string, raw: readonly RawTag[] | undefined, ver: number): CtxOp[] | null {
  const kind = CTX_TYPES.get(type);
  if (!kind || !raw?.length) return null;
  const o = new Out();
  const c = new Cur(raw);
  try {
    wHead(o, c, ver);
    switch (kind) {
      case 'text':
        wText(o, c, false);
        break;
      case 'attrib':
        wText(o, c, true);
        break;
      case 'blkref':
        wBlkRef(o, c);
        break;
      case 'mtext':
        wMText(o, c);
        break;
      case 'dim':
        wDim(o, c, type);
        break;
      case 'hatch':
        wHatchFields(o, c);
        break;
      case 'hatchview':
        wHatchView(o, c);
        break;
      case 'mleader':
        wMLeader(o, c, ver);
        break;
      case 'leader':
        wLeader(o, c);
        break;
    }
    c.end();
  } catch (e) {
    if (e instanceof CtxLayoutError) return null;
    throw e;
  }
  return o.ops;
}

/** 쓰기 명령을 받는 비트 쓰기(writer/bitwriter.ts의 BitWriter) */
export interface CtxSink {
  B(v: number): void;
  RC(v: number): void;
  BS(v: number): void;
  BL(v: number): void;
  BD(v: number): void;
  RD(v: number): void;
  TV(s: string): void;
  BD3(p: Vec3): void;
  H(code: number, value: number): void;
}

/**
 * 쓰기 명령을 비트로. ref는 핸들 문자열 → 쓸 핸들(쓰지 않는 객체면 0), block은 블록 이름 → 블록 레코드 핸들.
 */
export function writeCtxOps(d: CtxSink, hd: CtxSink, ops: readonly CtxOp[], ver: number, ref: (h: string) => number, block: (name: string) => number): void {
  for (const op of ops) {
    switch (op.t) {
      case 'B':
        d.B(op.v);
        break;
      case 'RC':
        d.RC(op.v & 0xff);
        break;
      case 'BS':
        d.BS(op.v & 0xffff);
        break;
      case 'BL':
        d.BL(op.v | 0);
        break;
      case 'BD':
        d.BD(op.v);
        break;
      case 'RD':
        d.RD(op.v);
        break;
      case 'TV':
        d.TV(op.v);
        break;
      case '3BD':
        d.BD3(op.v);
        break;
      case 'CMC':
        if (ver < R2004) d.BS(rawAci(op.v));
        else {
          d.BS(0);
          d.BL(op.v | 0);
          d.RC(0);
        }
        break;
      case 'HB':
        hd.H(op.code, op.name ? block(op.name) : 0);
        break;
      case 'H':
        hd.H(op.code, ref(op.h));
        break;
    }
  }
}
