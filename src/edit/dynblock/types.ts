/**
 * 동적 블록 모델(읽기 전용 해석 결과).
 *
 * 정의 = 블록 레코드의 확장 사전 ACAD_ENHANCEDBLOCK → 평가 그래프(ACAD_EVALUATION_GRAPH)와 그 노드(매개변수·그립·그립 위치 식·동작).
 * 노드는 그래프 안의 번호(id, DXF 90)로 서로를 가리키고, 블록 객체는 정의 블록의 핸들로 가리킨다.
 * 좌표는 모두 블록 정의 좌표다.
 */
import type { Vec3 } from '../../core/model';
import type { EditOp } from '../session';

export type ParamKind = 'visibility' | 'flip' | 'linear' | 'polar' | 'rotation' | 'xy' | 'point' | 'lookup' | 'alignment' | 'basepoint';

export type ActionKind = 'move' | 'stretch' | 'polar_stretch' | 'scale' | 'rotate' | 'flip' | 'array' | 'lookup';

/** 값 집합: type 비트 1 최소, 2 최대, 4 증분, 8 목록 */
export interface ValueSet {
  type: number;
  min: number;
  max: number;
  increment: number;
  list: number[];
}

/** 다른 노드의 속성 연결(노드 id + 속성 이름, 예: 2 'EndXDelta') */
export interface Conn {
  node: number;
  prop: string;
}

interface ParamBase {
  id: number;
  handle: string;
  /** DXF 객체 종류(BLOCKLINEARPARAMETER …) */
  type: string;
  /** 요소 이름(300) */
  name: string;
  /** 특성 이름(레이블). 없으면 요소 이름 */
  label: string;
  description: string;
  /** 특성 팔레트에 보이기(280) */
  show: boolean;
  /** 동작 사슬(281) */
  chain: boolean;
  /** 이 매개변수의 그립 노드 id */
  grips: number[];
}

export interface VisibilityParam extends ParamBase {
  kind: 'visibility';
  location: Vec3;
  /** 이 매개변수가 다루는 정의 객체 핸들 */
  entities: string[];
  states: { name: string; entities: string[]; nodes: string[] }[];
}

export interface FlipParam extends ParamBase {
  kind: 'flip';
  base: Vec3;
  end: Vec3;
  /** 기준 상태·뒤집힌 상태 이름(없으면 빈 문자열) */
  baseState: string;
  flippedState: string;
}

export interface LinearParam extends ParamBase {
  kind: 'linear';
  base: Vec3;
  end: Vec3;
  /** 177: 0 시작점 기준, 1 중간점 기준 */
  baseLocation: number;
  values: ValueSet;
}

export interface PolarParam extends ParamBase {
  kind: 'polar';
  base: Vec3;
  end: Vec3;
  baseLocation: number;
}

export interface RotationParam extends ParamBase {
  kind: 'rotation';
  base: Vec3;
  end: Vec3;
  /** 기준 각도 점(1011) */
  baseAngle: Vec3;
  baseLocation: number;
  values: ValueSet;
}

export interface XYParam extends ParamBase {
  kind: 'xy';
  base: Vec3;
  end: Vec3;
  labelX: string;
  labelY: string;
  valuesX: ValueSet;
  valuesY: ValueSet;
}

export interface PointParam extends ParamBase {
  kind: 'point' | 'basepoint' | 'alignment';
  location: Vec3;
  /** 정렬 매개변수의 둘째 점 */
  end?: Vec3;
}

export interface LookupParam extends ParamBase {
  kind: 'lookup';
  location: Vec3;
  /** 조회 동작 노드 id */
  action: number;
}

export type DynParam = VisibilityParam | FlipParam | LinearParam | PolarParam | RotationParam | XYParam | PointParam | LookupParam;

interface ActionBase {
  id: number;
  handle: string;
  type: string;
  name: string;
  /** 선택 집합의 그래프 노드(DXF 70 목록) */
  nodes: number[];
  /** 선택 집합의 정의 객체 핸들(71 목록) */
  entities: string[];
}

export interface MoveAction extends ActionBase {
  kind: 'move' | 'stretch';
  x: Conn;
  y: Conn;
  multiplier: number;
  /** 각도 오프셋(라디안) */
  angle: number;
  /** 280: 0 XY, 1 X만, 2 Y만 */
  xyType: number;
  /** 신축 틀(블록 좌표, 신축만) */
  frame: { x: number; y: number }[];
  /** 신축: 객체별 묶인 신축점 색인 */
  bindings: { handle: string; points: number[] }[];
  /** 신축: 노드별 점 색인(0 첫 점·위치, 1 둘째 점) */
  nodePoints: { node: number; points: number[] }[];
}

export interface BaseAction extends ActionBase {
  kind: 'scale' | 'rotate';
  baseX: Conn;
  baseY: Conn;
  offset: Vec3;
  /** 280: 기준점이 매개변수에 종속 */
  dependent: boolean;
  basePoint: Vec3;
  /** 축척: Scale·XScale·YScale, 회전: 각도 */
  scale?: Conn;
  scaleX?: Conn;
  scaleY?: Conn;
  angleConn?: Conn;
}

export interface FlipAction extends ActionBase {
  kind: 'flip';
  conns: Conn[];
}

export interface LookupColumn {
  node: number;
  prop: string;
  /** 95: 값 종류(1 문자, 40 실수 …) */
  valueType: number;
  /** 282: 조회 특성 열(출력) */
  lookup: boolean;
  /** 305: 일치하는 행이 없을 때 이름 */
  unmatched: string;
  /** 281: 역방향 조회 허용 */
  reverse: boolean;
}

export interface LookupAction extends ActionBase {
  kind: 'lookup';
  columns: LookupColumn[];
  /** rows[행][열] */
  rows: string[][];
}

export interface OtherAction extends ActionBase {
  kind: 'array' | 'polar_stretch';
  conns: Conn[];
}

export type DynAction = MoveAction | BaseAction | FlipAction | LookupAction | OtherAction;

/** 그립 노드 */
export interface DynGripNode {
  id: number;
  handle: string;
  type: string;
  /** 정의 좌표 위치(1010) */
  location: Vec3;
  /** 그립 위치 식: X·Y가 가리키는 매개변수 속성 */
  x: Conn | null;
  y: Conn | null;
  /** 선형·정렬·뒤집기 그립의 방향(140·141·142) */
  orientation?: Vec3;
}

export interface DynDefinition {
  /** 정의 블록 키(대문자) */
  key: string;
  /** 블록 이름(R2010 전 DXF에서는 *U…) */
  blockName: string;
  /** 보이는 이름(AcDbDynamicBlockTrueName이 있으면 그것) */
  name: string;
  recordHandle: string;
  graphHandle: string;
  params: DynParam[];
  actions: DynAction[];
  grips: DynGripNode[];
  /** 노드 id → 그래프 안 평가 순위(작을수록 먼저) */
  order: Map<number, number>;
  /** 노드 id → 노드 종류(BLOCK…) */
  nodeTypes: Map<number, string>;
  /** 정의 객체 핸들 → ETag 색인 */
  indexOf: Map<string, number>;
  /** ETag 색인 → 정의 객체 핸들 */
  handleAt: Map<number, string>;
  /** 해석하지 못한(원본 태그가 모자란) 노드 종류 */
  undecoded: string[];
}

/** 매개변수·동작 노드의 지금 값(참조 캐시 ACAD_ENHANCEDBLOCKDATA와 같은 뜻) */
export interface NodeValue {
  /** 매개변수 점(1점: [위치], 2점: [첫 점, 둘째 점], 회전: [기준점, 끝점, 기준 각도 점]) */
  points?: Vec3[];
  /** 가시성 상태 이름 */
  state?: string;
  /** 뒤집힘 */
  flipped?: boolean;
  /** 조회 값 */
  value?: string;
  /** 이동·신축 동작의 각도 오프셋 */
  angle?: number;
  /** 축척·회전 동작의 기준점 */
  base?: Vec3;
}

export type RefValues = Map<number, NodeValue>;

/** 동적 블록 편집 결과 */
export interface DynEditResult {
  ops: EditOp[];
  /** 변경이 없거나 거절했을 때의 안내 */
  message?: string;
  /** 새 표현 블록 이름 */
  block?: string;
}

export const MSG_UNSUPPORTED = '이 매개변수의 동작은 지원되지 않습니다.';
export const MSG_SAME = '동적 블록 특성이 이미 그 값입니다.';
export const MSG_NOT_DYNAMIC = '동적 블록 참조가 아닙니다.';
export const MSG_UNDECODED = '이 동적 블록 정의는 읽을 수 없는 자료가 있어 고칠 수 없습니다.';
/** 조회 테이블에 일치하는 행이 없을 때 기본 이름(한국어판 AutoCAD) */
export const LOOKUP_CUSTOM = '사용자';
export const FLIP_NOT = '반전되지 않음';
export const FLIP_YES = '반전됨';
