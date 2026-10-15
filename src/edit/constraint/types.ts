/**
 * 파라메트릭 구속(기하 구속·치수 구속) 자료 형식.
 *
 * 구속은 객체 핸들과 그 객체의 "부분"(끝점·중심·정점·세그먼트)을 가리킨다.
 * 부분 코드(part):
 * - ''      객체 전체(선·원·호·타원·스플라인을 곡선으로)
 * - 'S' 'E' 시작점·끝점(선·호·타원 호·스플라인)
 * - 'M'     중간점(선·호)
 * - 'C'     중심(원·호·타원)
 * - 'I'     삽입점(점·문자·여러 줄 문자·블록 참조)
 * - 'V<i>'  폴리선 정점 i
 * - 'G<i>'  폴리선 세그먼트 i(직선이면 선, 호면 원호로)
 * - 'M<i>'  폴리선 세그먼트 i의 중간점, 'C<i>' 호 세그먼트 i의 중심
 */

/** 기하 구속 종류 */
export type GeoType =
  | 'COINCIDENT'
  | 'COLLINEAR'
  | 'CONCENTRIC'
  | 'FIX'
  | 'PARALLEL'
  | 'PERPENDICULAR'
  | 'HORIZONTAL'
  | 'VERTICAL'
  | 'TANGENT'
  | 'SMOOTH'
  | 'SYMMETRIC'
  | 'EQUAL';

/** 치수 구속 종류: 거리(정렬), 수평 거리, 수직 거리, 각도, 반지름, 지름 */
export type DimType = 'DIST' | 'HDIST' | 'VDIST' | 'ANGLE' | 'RADIUS' | 'DIAMETER';

export const GEO_TYPES: readonly GeoType[] = ['COINCIDENT', 'COLLINEAR', 'CONCENTRIC', 'FIX', 'PARALLEL', 'PERPENDICULAR', 'HORIZONTAL', 'VERTICAL', 'TANGENT', 'SMOOTH', 'SYMMETRIC', 'EQUAL'];
export const DIM_TYPES: readonly DimType[] = ['DIST', 'HDIST', 'VDIST', 'ANGLE', 'RADIUS', 'DIAMETER'];

/** 화면 이름(AutoCAD 한국어판) */
export const GEO_LABEL: Record<GeoType, string> = {
  COINCIDENT: '일치',
  COLLINEAR: '동일선상',
  CONCENTRIC: '동심',
  FIX: '고정',
  PARALLEL: '평행',
  PERPENDICULAR: '직교',
  HORIZONTAL: '수평',
  VERTICAL: '수직',
  TANGENT: '접선',
  SMOOTH: '부드럽게',
  SYMMETRIC: '대칭',
  EQUAL: '동일',
};

export const DIM_LABEL: Record<DimType, string> = {
  DIST: '정렬',
  HDIST: '수평',
  VDIST: '수직',
  ANGLE: '각도',
  RADIUS: '반지름',
  DIAMETER: '지름',
};

/**
 * AutoCAD가 만든 구속(연관 망의 2D 구속 그룹 노드)에서 읽은 구속이면 그 자리.
 * 이 앱 기록(XRECORD)에는 쓰지 않고, 바뀌면 AutoCAD 그룹·변수를 같은 형식으로 고쳐 쓴다(src/edit/assocnet/constraints.ts).
 */
export interface AcadLink {
  /** ACDBASSOC2DCONSTRAINTGROUP 핸들 */
  group: string;
  /** 구속 노드 번호 */
  node: number;
}

/** 객체의 부분을 가리키는 참조 */
export interface GeoRef {
  /** 객체 핸들(정규화된 대문자 16진) */
  h: string;
  part: string;
}

export interface GeoConstraint {
  id: number;
  kind: 'geo';
  type: GeoType;
  refs: GeoRef[];
  /**
   * 종류별 보조 값(만들 때 정한 방향).
   * - TANGENT 선–원: [쪽(±1)], 원–원: [0 외접 | 1 첫째가 큰 내접 | 2 둘째가 큰 내접]
   * - SMOOTH: [두 번째 곡선 접선 방향(±1)]
   */
  aux?: number[];
  /** 수평·수직의 기준 축 각도(만들 때의 UCS X축, 라디안). 없으면 WCS */
  axis?: number;
  acad?: AcadLink;
}

export interface DimConstraint {
  id: number;
  kind: 'dim';
  type: DimType;
  /**
   * 참조
   * - DIST·HDIST·VDIST: [점, 점] 또는 DIST [점, 선](점과 선) 또는 DIST [선, 선](2선 — 평행하게 만든다)
   * - ANGLE: [선, 선] 또는 [꼭짓점, 점, 점](3점) 또는 [호]
   * - RADIUS·DIAMETER: [원·호]
   */
  refs: GeoRef[];
  /** 매개변수 이름(d1, ang1, rad1, dia1 …) */
  name: string;
  /** 식(수 또는 다른 매개변수를 쓰는 식). 참조 구속은 측정값 */
  expr: string;
  /** 마지막으로 계산한 값: 길이(도면 단위) 또는 각도(도) */
  value: number;
  /** 참조(구동하지 않는) 치수 구속 */
  reference: boolean;
  /** 측정 방향(만들 때 정함). DIST 점과 선·HDIST·VDIST·2선: 부호, ANGLE 선 둘: [선1 방향, 선2 방향] */
  aux?: number[];
  /** 수평·수직 거리의 기준 축 각도(UCS X축, 라디안) */
  axis?: number;
  /**
   * 치수선 자리(측정 대상에 상대값이라 형상을 따라간다).
   * 선형: 측정선에서 치수선까지의 부호 있는 거리, 반지름·지름: 지시 방향 각도(라디안), 각도: 호 반지름
   */
  offset: number;
  /** 치수 구속 표시를 숨김(DCDISPLAY) */
  hidden?: boolean;
  description?: string;
  acad?: AcadLink;
}

export type Constraint = GeoConstraint | DimConstraint;

/** 사용자 매개변수(PARAMETERS 관리자에서 만든다) */
export interface UserParam {
  name: string;
  expr: string;
  value: number;
  description?: string;
  /** AutoCAD 변수(ACDBASSOCVARIABLE)에서 읽은 것이면 그 핸들 */
  acad?: string;
}

/** 도면 하나의 구속 기록 */
export interface ConstraintStore {
  constraints: Constraint[];
  userParams: UserParam[];
  /** 구속 막대를 숨긴 객체 핸들 */
  hiddenBars: string[];
  /** 다음 구속 번호 */
  nextId: number;
  /** 치수 표시를 숨긴 AutoCAD 치수 구속("그룹 핸들:노드 번호" — 이 앱 기록에만 둔다) */
  acadHidden?: string[];
}

export function emptyStore(): ConstraintStore {
  return { constraints: [], userParams: [], hiddenBars: [], nextId: 1 };
}

/** 구속이 가리키는 객체 핸들(중복 없음) */
export function constraintHandles(c: Constraint): string[] {
  return [...new Set(c.refs.map((r) => r.h))];
}

/** 치수 구속 이름 앞머리 */
export function dimPrefix(t: DimType): string {
  return t === 'ANGLE' ? 'ang' : t === 'RADIUS' ? 'rad' : t === 'DIAMETER' ? 'dia' : 'd';
}

/** 부분 코드에서 번호(V3 → 3). 번호가 없으면 -1 */
export function partIndex(part: string): number {
  const m = /^[VGMC](\d+)$/.exec(part);
  return m ? Number(m[1]) : -1;
}
