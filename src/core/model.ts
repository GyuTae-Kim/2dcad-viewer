/**
 * 도면 문서 모델.
 *
 * DXF 리더와 DWG 리더는 모두 이 형태로 문서를 만든다. 값은 DXF 그룹 코드의 뜻을 그대로 따르되,
 * 다음만 정규화한다.
 * - 각도는 라디안이다(DXF 파일의 도 단위 값도 라디안으로 바꾼다).
 * - 핸들은 앞자리 0이 없는 대문자 16진 문자열이다. 핸들이 없으면 빈 문자열이다.
 * - 색은 CadColor, 선가중치는 1/100 mm 정수(-1 ByLayer, -2 ByBlock, -3 기본값)다.
 * - 좌표는 파일에 저장된 좌표계 그대로다. OCS 객체(원·호·문자 등)는 extrusion으로 WCS를 구한다.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** ACI 0 = ByBlock, 256 = ByLayer, 257 = ByEntity(DWG), 1..255 = 색 번호. rgb가 있으면 화면에는 rgb를 쓴다. */
export interface CadColor {
  aci: number;
  rgb?: number;
  /** 색상표 이름(예: "PANTONE$...") */
  name?: string;
}

export const BYLAYER = 256;
export const BYBLOCK = 0;

export const LW_BYLAYER = -1;
export const LW_BYBLOCK = -2;
export const LW_DEFAULT = -3;

/** 투명도: -1 ByLayer(값 없음), -2 ByBlock, 0..255 불투명도(255 = 불투명). */
export const TRANSPARENCY_BYLAYER = -1;
export const TRANSPARENCY_BYBLOCK = -2;

export type XDataValue = string | number | Vec3 | Uint8Array;

export interface XDataItem {
  code: number;
  value: XDataValue;
}

export interface XData {
  app: string;
  items: XDataItem[];
}

/** 모르는 객체나 나중에 다시 쓸 객체를 위해 남기는 원본 태그. */
export interface RawTag {
  code: number;
  value: string | number;
}

// ---------------------------------------------------------------------------
// 객체(Entity)
// ---------------------------------------------------------------------------

export interface EntityBase {
  type: string;
  handle: string;
  /** 소유 블록 레코드 핸들 */
  owner?: string;
  layer: string;
  /** 선종류 이름. 기본값 "ByLayer" */
  linetype: string;
  color: CadColor;
  lineweight: number;
  ltscale: number;
  transparency: number;
  /** DXF 60: 1이면 보이지 않음 */
  invisible?: boolean;
  /** DXF 67: 종이 공간 객체(R12 형식이나 ENTITIES 구역의 배치 객체) */
  paperSpace?: boolean;
  /** OCS Z축. 없으면 (0, 0, 1) */
  extrusion?: Vec3;
  thickness?: number;
  xdata?: XData[];
  /** 확장 사전 핸들 */
  xdict?: string;
  reactors?: string[];
  /** 플롯 스타일 핸들(명명된 플롯 스타일 도면) */
  plotStyle?: string;
  /** 하이퍼링크(PE_URL 확장 데이터) */
  hyperlink?: { url: string; description?: string; location?: string };
  /** DWG 리더가 남긴 원본 본문(같은 버전으로 다시 쓸 때만 쓴다) */
  dwgRaw?: DwgRawBody;
}

/**
 * DWG 객체의 형식별 본문 비트(공통 자료·공통 핸들 뒤). DWG 쓰기가 같은 버전일 때 그대로 되쓴다.
 * fingerprint는 읽을 때 모델 값의 지문이다. 값이 바뀌었으면 원본을 쓰지 않는다.
 */
export interface DwgRawBody {
  /** 원본 DWG 버전(AC1015 …) */
  version: string;
  /** 고정 이름 또는 클래스 DXF 이름 */
  typeName: string;
  /** 고정 종류 번호(500 미만), 클래스면 0 */
  typeNum: number;
  data: Uint8Array;
  dataBits: number;
  /** R2007+ 문자열 흐름 */
  strings?: Uint8Array;
  stringBits?: number;
  handles: Uint8Array;
  handleBits: number;
  /** R2013+ 자료 저장소(AcDsPrototype_1b)를 쓰는 객체 */
  dataStore?: boolean;
  /** 도형의 프록시 그림(공통 자료에 다시 쓴다) */
  graphics?: Uint8Array;
  fingerprint: string;
}

export interface LineEntity extends EntityBase {
  type: 'LINE';
  start: Vec3;
  end: Vec3;
}

export interface PointEntity extends EntityBase {
  type: 'POINT';
  position: Vec3;
  /** 점 표시의 X축 각도 */
  angle: number;
}

export interface CircleEntity extends EntityBase {
  type: 'CIRCLE';
  /** OCS 중심 */
  center: Vec3;
  radius: number;
}

export interface ArcEntity extends EntityBase {
  type: 'ARC';
  /** OCS 중심 */
  center: Vec3;
  radius: number;
  /** OCS 각도(라디안), 반시계 방향 */
  startAngle: number;
  endAngle: number;
}

export interface EllipseEntity extends EntityBase {
  type: 'ELLIPSE';
  /** WCS 중심 */
  center: Vec3;
  /** WCS 장축 끝점(중심 기준 상대 벡터) */
  majorAxis: Vec3;
  /** 단축/장축 비 */
  ratio: number;
  startParam: number;
  endParam: number;
}

export interface LwVertex {
  x: number;
  y: number;
  bulge: number;
  startWidth: number;
  endWidth: number;
}

export interface LwPolylineEntity extends EntityBase {
  type: 'LWPOLYLINE';
  vertices: LwVertex[];
  closed: boolean;
  /** 선종류 생성(PLINEGEN, 70 비트 128) */
  plinegen: boolean;
  constantWidth: number;
  /** OCS 고도 */
  elevation: number;
}

export interface PolyVertex {
  /** 2D 폴리선은 OCS, 3D·메시는 WCS */
  location: Vec3;
  bulge: number;
  startWidth: number;
  endWidth: number;
  /** VERTEX 70 플래그 */
  flags: number;
  /** 곡선 맞춤 접선 방향(라디안), flags & 2일 때 */
  tangent?: number;
  /** 폴리페이스 면 레코드의 정점 번호(71~74, 음수 = 보이지 않는 모서리) */
  faceIndices?: number[];
}

export type PolylineKind = '2d' | '3d' | 'mesh' | 'polyface';

export interface PolylineEntity extends EntityBase {
  type: 'POLYLINE';
  kind: PolylineKind;
  /** POLYLINE 70 플래그 */
  flags: number;
  vertices: PolyVertex[];
  /** 2D 폴리선의 고도(그룹 10의 Z) */
  elevation: number;
  defaultStartWidth: number;
  defaultEndWidth: number;
  /** 메시 M·N 개수(71·72), 폴리페이스는 정점 수·면 수 */
  mCount: number;
  nCount: number;
  mDensity: number;
  nDensity: number;
  /** 75: 0 없음, 5 2차 B 스플라인, 6 3차 B 스플라인, 8 베지어 */
  smoothType: number;
}

export interface SplineEntity extends EntityBase {
  type: 'SPLINE';
  /** 70: 1 닫힘, 2 주기, 4 유리, 8 평면, 16 선형 */
  flags: number;
  degree: number;
  knots: number[];
  controlPoints: Vec3[];
  /** 유리 스플라인의 가중치(없으면 모두 1) */
  weights?: number[];
  fitPoints: Vec3[];
  startTangent?: Vec3;
  endTangent?: Vec3;
  knotTolerance: number;
  controlTolerance: number;
  fitTolerance: number;
  normal?: Vec3;
  /** HELIX(AcDbHelix)일 때 나선 정의 */
  helix?: {
    axisBase: Vec3;
    start: Vec3;
    axis: Vec3;
    radius: number;
    turns: number;
    turnHeight: number;
    ccw: boolean;
    constrain: number;
  };
}

export interface XLineEntity extends EntityBase {
  type: 'XLINE' | 'RAY';
  base: Vec3;
  /** 단위 방향 벡터(WCS) */
  direction: Vec3;
}

export type TextHAlign = 0 | 1 | 2 | 3 | 4 | 5; // left, center, right, aligned, middle, fit
export type TextVAlign = 0 | 1 | 2 | 3; // baseline, bottom, middle, top

export interface TextEntity extends EntityBase {
  type: 'TEXT' | 'ATTRIB' | 'ATTDEF';
  /** OCS 첫 정렬점(10) */
  insert: Vec3;
  /** OCS 두 번째 정렬점(11). 왼쪽·기준선 정렬이면 없음 */
  alignPoint?: Vec3;
  height: number;
  text: string;
  rotation: number;
  widthFactor: number;
  oblique: number;
  style: string;
  /** 71: 2 좌우 반전, 4 상하 반전 */
  generation: number;
  halign: TextHAlign;
  valign: TextVAlign;
}

export interface AttribEntity extends Omit<TextEntity, 'type'> {
  type: 'ATTRIB' | 'ATTDEF';
  tag: string;
  /** ATTDEF 3 */
  prompt?: string;
  /** 70: 1 숨김, 2 상수, 4 확인, 8 미리 설정 */
  attFlags: number;
  lockPosition?: boolean;
  /** 여러 줄 속성(R2018)이면 MTEXT 정의 */
  mtext?: MTextEntity;
}

export interface MTextColumns {
  type: number; // 0 없음, 1 정적, 2 동적
  count: number;
  width: number;
  gutter: number;
  autoHeight: boolean;
  flowReversed: boolean;
  heights: number[];
}

export interface MTextEntity extends EntityBase {
  type: 'MTEXT';
  /** WCS 삽입점 */
  insert: Vec3;
  /** 문자 높이(40) */
  height: number;
  /** 참조 사각형 폭(41), 0이면 줄바꿈 없음 */
  width: number;
  /** 정의된 높이(46) */
  rectHeight?: number;
  /** 71: 1 위 왼쪽 … 9 아래 오른쪽 */
  attachment: number;
  /** 72: 1 왼→오, 3 위→아래, 5 스타일 따름 */
  drawingDirection: number;
  /** 원본 서식 문자열(1 + 3 이어 붙임) */
  text: string;
  style: string;
  /** WCS X축 방향(11). 없으면 rotation을 쓴다 */
  direction?: Vec3;
  rotation: number;
  /** 73: 1 최소, 2 정확하게 */
  lineSpacingStyle: number;
  lineSpacingFactor: number;
  /** 90: 1 배경색 사용, 2 도면 배경색 사용, 16 텍스트 프레임 */
  backgroundFlags: number;
  backgroundColor?: CadColor;
  backgroundScale: number;
  columns?: MTextColumns;
}

export interface InsertEntity extends EntityBase {
  type: 'INSERT';
  block: string;
  /** OCS 삽입점 */
  insert: Vec3;
  scale: Vec3;
  rotation: number;
  columnCount: number;
  rowCount: number;
  columnSpacing: number;
  rowSpacing: number;
  attribs: AttribEntity[];
}

export interface DimensionEntity extends EntityBase {
  type: 'DIMENSION';
  /** ARC_DIMENSION·LARGE_RADIAL_DIMENSION도 이 형식(subtype에 원래 이름) */
  subtype?: 'ARC_DIMENSION' | 'LARGE_RADIAL_DIMENSION';
  /** 치수 그림 익명 블록(*D…) */
  block: string;
  dimStyle: string;
  /** 70 원본 값. 하위 3비트 종류 0 회전·수평·수직, 1 정렬, 2 각도, 3 지름, 4 반지름, 5 3점 각도, 6 세로좌표 */
  dimType: number;
  /** 10 정의점(WCS) */
  defPoint: Vec3;
  /** 11 문자 중간점(OCS) */
  textMid: Vec3;
  /** 12 (MINSERT 형식 치수의 삽입점, 거의 쓰지 않음) */
  insertPoint?: Vec3;
  /** 13·14·15·16 정의점(WCS, 16은 OCS) */
  defPoint2: Vec3;
  defPoint3: Vec3;
  defPoint4: Vec3;
  defPoint5: Vec3;
  /** 1 문자 재지정("" = 측정값, "<>" 포함 가능, " " = 숨김) */
  text: string;
  /** 42 실제 측정값 */
  measurement: number;
  /** 50 회전(선형 치수) */
  rotation: number;
  /** 52 치수보조선 기울기 */
  obliqueAngle: number;
  /** 53 문자 회전 */
  textRotation: number;
  /** 51 수평 방향 */
  horizontalDirection: number;
  /** 71 문자 부착 */
  attachment: number;
  /** 40 지시선 길이(반지름·지름) */
  leaderLength: number;
  lineSpacingStyle: number;
  lineSpacingFactor: number;
  /** ARC_DIMENSION의 호 정의 */
  arc?: { center: Vec3; start: Vec3; end: Vec3; startAngle: number; endAngle: number; partial: boolean; leader1?: Vec3; leader2?: Vec3 };
  /** ACAD DSTYLE 확장 데이터 재지정(그룹 코드 → 값) */
  overrides?: Record<number, string | number>;
}

export interface LeaderEntity extends EntityBase {
  type: 'LEADER';
  dimStyle: string;
  vertices: Vec3[];
  /** 71: 화살표 사용 */
  arrowHead: boolean;
  /** 72: 0 직선, 1 스플라인 */
  pathType: number;
  /** 73: 0 문자, 1 공차, 2 블록, 3 없음 */
  creation: number;
  /** 74: 걸이 방향 */
  hooklineDirection: number;
  hookline: boolean;
  textHeight: number;
  textWidth: number;
  /** 340 주석 객체 핸들 */
  annotation?: string;
  normal?: Vec3;
  horizontalDirection?: Vec3;
  blockOffset?: Vec3;
  annotationOffset?: Vec3;
  overrides?: Record<number, string | number>;
}

export interface MLeaderLine {
  vertices: Vec3[];
  breaks?: { start: Vec3; end: Vec3 }[];
  index: number;
  color?: CadColor;
}

export interface MLeaderLeader {
  lastLeaderPoint?: Vec3;
  doglegVector?: Vec3;
  doglegLength: number;
  hasLastPoint: boolean;
  hasDogleg: boolean;
  lines: MLeaderLine[];
  index: number;
  attachmentDirection: number;
}

export interface MLeaderEntity extends EntityBase {
  type: 'MULTILEADER';
  styleHandle?: string;
  /** 170: 0 보이지 않음, 1 직선, 2 스플라인 */
  leaderLineType: number;
  leaderLineColor: CadColor;
  leaderLineTypeHandle?: string;
  leaderLineWeight: number;
  landing: boolean;
  dogleg: boolean;
  doglegLength: number;
  arrowHeadHandle?: string;
  arrowSize: number;
  /** 172: 0 없음, 1 블록, 2 여러 줄 문자, 3 공차 */
  contentType: number;
  textStyleHandle?: string;
  textColor: CadColor;
  textFrame: boolean;
  blockHandle?: string;
  blockColor: CadColor;
  blockScale: Vec3;
  blockRotation: number;
  blockConnection: number;
  scale: number;
  context: {
    scale: number;
    contentBase: Vec3;
    textHeight: number;
    arrowSize: number;
    landingGap: number;
    leaders: MLeaderLeader[];
    text?: {
      text: string;
      location: Vec3;
      direction: Vec3;
      normal: Vec3;
      rotation: number;
      width: number;
      height: number;
      lineSpacingFactor: number;
      lineSpacingStyle: number;
      color: CadColor;
      attachment: number;
      flowDirection: number;
      styleHandle?: string;
      backgroundFill: boolean;
      backgroundColor?: CadColor;
      backgroundScale: number;
      /** DXF 쓰기용: 모델에 없는 값(그룹 코드 → 값: 92 배경 투명도, 291, 173 단 종류, 293, 142, 143, 294, 295) */
      props?: Record<number, number>;
    };
    block?: {
      blockHandle?: string;
      location: Vec3;
      normal: Vec3;
      scale: Vec3;
      rotation: number;
      color: CadColor;
      /** 4x4 변환(16개, 행 우선) */
      matrix?: number[];
    };
    basePoint: Vec3;
    baseDirection: Vec3;
    baseVertical: Vec3;
    normal: Vec3;
    /** DXF 쓰기용: 모델에 없는 값(그룹 코드 → 값: 174·175 부착, 176 정렬, 177 부착 방식, 297, 272·273) */
    props?: Record<number, number>;
  };
  /** 블록 내용의 속성 값 */
  blockAttributes?: { attdefHandle: string; index: number; width: number; text: string }[];
  /** DXF 쓰기용: 모델에 없는 본문 값(그룹 코드 → 값: 270 판, 90 재지정 플래그, 173·95·174·175 문자 부착, 293~295, 178·179, 271~273) */
  props?: Record<number, number>;
}

export interface HatchLineEdge {
  type: 'line';
  start: Vec2;
  end: Vec2;
}

/**
 * 해치 호 경계. startAngle·endAngle은 늘 반시계 순서의 각도(라디안)다.
 * 파일은 시계 방향 호(73 = 0)의 각도를 보각(2π − 각도)으로 저장하므로, 리더가
 * start = 2π − 파일 end, end = 2π − 파일 start로 바꿔 둔다. ccw가 거짓이면 경로는 end에서 start로 지난다.
 */
export interface HatchArcEdge {
  type: 'arc';
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
  ccw: boolean;
}

/** 해치 타원 경계. 각도 규칙은 HatchArcEdge와 같고, 값은 장축 기준 기하 각도(매개변수 아님)다. */
export interface HatchEllipseEdge {
  type: 'ellipse';
  center: Vec2;
  majorAxis: Vec2;
  ratio: number;
  startAngle: number;
  endAngle: number;
  ccw: boolean;
}

export interface HatchSplineEdge {
  type: 'spline';
  degree: number;
  rational: boolean;
  periodic: boolean;
  knots: number[];
  controlPoints: Vec2[];
  weights?: number[];
  fitPoints?: Vec2[];
  startTangent?: Vec2;
  endTangent?: Vec2;
}

export type HatchEdge = HatchLineEdge | HatchArcEdge | HatchEllipseEdge | HatchSplineEdge;

export interface HatchPath {
  /** 92: 1 외부, 2 폴리선, 4 파생, 8 텍스트 상자, 16 가장 바깥 */
  flags: number;
  /** 폴리선 경계(flags & 2) */
  polyline?: { closed: boolean; vertices: { x: number; y: number; bulge: number }[] };
  edges?: HatchEdge[];
  /** 연관 경계 객체 핸들 */
  sources?: string[];
}

export interface HatchPatternLine {
  /** 무늬 선 각도(라디안, 이미 해치 각도·축척이 적용된 값) */
  angle: number;
  base: Vec2;
  offset: Vec2;
  /** 양수 = 선, 음수 = 틈, 0 = 점 */
  dashes: number[];
}

export interface HatchGradient {
  /** 450: 0 일반 해치, 1 그라데이션 */
  enabled: boolean;
  name: string;
  color1: CadColor;
  color2: CadColor;
  /** 452: 1 한 가지 색 */
  singleColor: boolean;
  tint: number;
  angle: number;
  /** 461 이동량(0 = 가운데) */
  shift: number;
}

export interface HatchEntity extends EntityBase {
  type: 'HATCH' | 'MPOLYGON';
  patternName: string;
  solid: boolean;
  associative: boolean;
  /** 75: 0 홀짝, 1 바깥만, 2 무시 */
  hatchStyle: number;
  /** 76: 0 사용자, 1 미리 정의, 2 사용자 정의 */
  patternType: number;
  patternAngle: number;
  patternScale: number;
  patternDouble: boolean;
  /** OCS 고도 */
  elevation: number;
  paths: HatchPath[];
  patternLines: HatchPatternLine[];
  pixelSize: number;
  seedPoints: Vec2[];
  gradient?: HatchGradient;
  /** MPOLYGON 채우기 색 */
  fillColor?: CadColor;
}

export interface FaceEntity extends EntityBase {
  type: 'SOLID' | 'TRACE' | '3DFACE';
  /** SOLID·TRACE는 OCS, 3DFACE는 WCS. SOLID의 그리는 순서는 1-2-4-3 */
  points: [Vec3, Vec3, Vec3, Vec3];
  /** 3DFACE 70: 숨긴 모서리 비트 */
  invisibleEdges: number;
}

export interface ImageEntity extends EntityBase {
  type: 'IMAGE' | 'WIPEOUT';
  insert: Vec3;
  uVector: Vec3;
  vVector: Vec3;
  /** 픽셀 단위 이미지 크기 */
  imageSize: Vec2;
  imageDef?: string;
  /** IMAGEDEF_REACTOR 핸들(360) */
  imageDefReactor?: string;
  /** 70: 1 표시, 2 정렬되지 않았을 때 표시, 4 경계 사용, 8 투명 */
  displayFlags: number;
  clipping: boolean;
  brightness: number;
  contrast: number;
  fade: number;
  /** 71: 1 사각형, 2 다각형 */
  clipBoundaryType: number;
  /** 픽셀 좌표 경계(이미지 왼쪽 아래 -0.5, -0.5 기준) */
  clipBoundary: Vec2[];
  clipInverted?: boolean;
}

export interface ViewportEntity extends EntityBase {
  type: 'VIEWPORT';
  /** 종이 공간 중심 */
  center: Vec3;
  width: number;
  height: number;
  /** 69: 1 = 배치 전체(용지) 뷰포트, 0 = 꺼짐 */
  status: number;
  id: number;
  /** DCS 뷰 중심 */
  viewCenter: Vec2;
  snapBase: Vec2;
  snapSpacing: Vec2;
  gridSpacing: Vec2;
  viewDirection: Vec3;
  viewTarget: Vec3;
  lensLength: number;
  frontClip: number;
  backClip: number;
  /** 모형 단위 뷰 높이 */
  viewHeight: number;
  snapAngle: number;
  twistAngle: number;
  circleSides: number;
  /** 90 상태 플래그 */
  flags: number;
  clipBoundary?: string;
  frozenLayers: string[];
  styleSheet?: string;
  renderMode: number;
  ucsPerViewport: boolean;
  ucsOrigin?: Vec3;
  ucsXAxis?: Vec3;
  ucsYAxis?: Vec3;
  /** 주석 축척 핸들 */
  annotationScale?: string;
  /** 사용자 지정 축척 값(종이/모형) */
  customScale?: number;
}

export interface MLineVertex {
  position: Vec3;
  direction: Vec3;
  miter: Vec3;
  /** 요소마다의 매개변수와 채우기 매개변수 */
  elements: { params: number[]; fillParams: number[] }[];
}

export interface MLineEntity extends EntityBase {
  type: 'MLINE';
  styleName: string;
  styleHandle?: string;
  scale: number;
  /** 70: 0 위, 1 0, 2 아래 */
  justification: number;
  /** 71: 1 정점 있음, 2 닫힘, 4 시작 마구리 없음, 8 끝 마구리 없음 */
  flags: number;
  startPoint: Vec3;
  normal: Vec3;
  vertices: MLineVertex[];
  elementCount: number;
}

export interface ToleranceEntity extends EntityBase {
  type: 'TOLERANCE';
  dimStyle: string;
  insert: Vec3;
  text: string;
  direction: Vec3;
}

export interface ShapeEntity extends EntityBase {
  type: 'SHAPE';
  insert: Vec3;
  size: number;
  name: string;
  /** DWG는 번호만 가진다 */
  shapeNumber?: number;
  styleHandle?: string;
  rotation: number;
  widthFactor: number;
  oblique: number;
}

export interface TableEntity extends EntityBase {
  type: 'ACAD_TABLE';
  /** 표 그림 익명 블록(*T…) */
  block: string;
  insert: Vec3;
  direction: Vec3;
  scale: Vec3;
  rotation: number;
  rows: number;
  columns: number;
  rowHeights: number[];
  columnWidths: number[];
  /** 셀 문자(행 우선) — 읽을 수 있을 때만 */
  cells?: { text: string }[];
  tableStyle?: string;
  /** DXF에서 읽은 AcDbEntity 다음 원본 태그(다시 쓰기용)와 그 파일 버전 */
  raw?: RawTag[];
  rawVersion?: string;
}

export interface MeshEntity extends EntityBase {
  type: 'MESH';
  vertices: Vec3[];
  faces: number[][];
  edges: [number, number][];
  subdivision: number;
}

export interface UnderlayEntity extends EntityBase {
  type: 'PDFUNDERLAY' | 'DWFUNDERLAY' | 'DGNUNDERLAY';
  definition?: string;
  insert: Vec3;
  scale: Vec3;
  rotation: number;
  flags: number;
  contrast: number;
  fade: number;
  clipBoundary: Vec2[];
}

export interface Ole2FrameEntity extends EntityBase {
  type: 'OLE2FRAME' | 'OLEFRAME';
  upperLeft: Vec3;
  lowerRight: Vec3;
}

/** ACIS 기반 객체 — 2D 뷰어는 형상을 풀지 않고 프록시 그림이 있으면 그것을 그린다. */
export interface AcisEntity extends EntityBase {
  type: 'REGION' | '3DSOLID' | 'BODY' | 'SURFACE' | 'PLANESURFACE' | 'EXTRUDEDSURFACE' | 'LOFTEDSURFACE' | 'REVOLVEDSURFACE' | 'SWEPTSURFACE' | 'NURBSURFACE';
  /** 일부 파일이 담는 단순 와이어(분해된 선) */
  wires?: Vec3[][];
  /** DXF에서 읽은 AcDbEntity 다음 원본 태그(ACIS 자료 포함)와 그 파일 버전 */
  raw?: RawTag[];
  rawVersion?: string;
}

/** 모르는 객체, 프록시 객체. 프록시 그림이 있으면 graphics에 원본 바이트 */
export interface UnknownEntity extends EntityBase {
  type: 'UNKNOWN';
  originalType: string;
  graphics?: Uint8Array;
  raw?: RawTag[];
}

export type Entity =
  | LineEntity
  | PointEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity
  | LwPolylineEntity
  | PolylineEntity
  | SplineEntity
  | XLineEntity
  | TextEntity
  | AttribEntity
  | MTextEntity
  | InsertEntity
  | DimensionEntity
  | LeaderEntity
  | MLeaderEntity
  | HatchEntity
  | FaceEntity
  | ImageEntity
  | ViewportEntity
  | MLineEntity
  | ToleranceEntity
  | ShapeEntity
  | TableEntity
  | MeshEntity
  | UnderlayEntity
  | Ole2FrameEntity
  | AcisEntity
  | UnknownEntity;

export type EntityType = Entity['type'];

// ---------------------------------------------------------------------------
// 표(Table)
// ---------------------------------------------------------------------------

export interface TableRecordBase {
  name: string;
  handle: string;
  /** 70 플래그 */
  flags: number;
  xdata?: XData[];
  xdict?: string;
}

export interface Layer extends TableRecordBase {
  /** 양수 ACI 색(꺼짐은 off로 따로) */
  color: CadColor;
  off: boolean;
  frozen: boolean;
  locked: boolean;
  linetype: string;
  lineweight: number;
  plot: boolean;
  /** 0..255 불투명도, 없으면 255 */
  transparency: number;
  plotStyle?: string;
  description?: string;
}

export interface LinetypeElement {
  /** 양수 선, 음수 틈, 0 점 */
  length: number;
  /** 74: 1 절대 회전, 2 문자, 4 쉐이프 */
  flags: number;
  shapeNumber?: number;
  styleHandle?: string;
  text?: string;
  scale: number;
  rotation: number;
  offset: Vec2;
}

export interface Linetype extends TableRecordBase {
  description: string;
  patternLength: number;
  elements: LinetypeElement[];
}

export interface TextStyle extends TableRecordBase {
  /** 고정 높이(0 = 가변) */
  height: number;
  widthFactor: number;
  oblique: number;
  /** 71: 2 좌우 반전, 4 상하 반전 */
  generation: number;
  lastHeight: number;
  /** 글꼴 파일(예: "txt", "romans.shx", "arial.ttf") */
  font: string;
  bigFont: string;
  /** 트루타입 글꼴 이름(확장 데이터 ACAD 1000) */
  fontFamily?: string;
  /** 트루타입 굵게·기울임 비트(확장 데이터 1071) */
  fontFlags?: number;
}

/** 치수 스타일: DXF 그룹 코드의 변수 이름(DIMSCALE 등) → 값 */
export interface DimStyle extends TableRecordBase {
  vars: Record<string, number | string>;
}

export interface VPortRecord extends TableRecordBase {
  lowerLeft: Vec2;
  upperRight: Vec2;
  center: Vec2;
  snapBase: Vec2;
  snapSpacing: Vec2;
  gridSpacing: Vec2;
  viewDirection: Vec3;
  viewTarget: Vec3;
  height: number;
  aspect: number;
  lensLength: number;
  twist: number;
}

export interface ViewRecord extends TableRecordBase {
  center: Vec2;
  width: number;
  height: number;
  viewDirection: Vec3;
  viewTarget: Vec3;
  twist: number;
}

export interface UcsRecord extends TableRecordBase {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
}

export interface BlockRecord extends TableRecordBase {
  /** 연결된 LAYOUT 객체 핸들 */
  layout?: string;
  insertUnits: number;
  explodable: boolean;
  scalable: boolean;
}

// ---------------------------------------------------------------------------
// 블록·배치
// ---------------------------------------------------------------------------

export interface BlockDef {
  name: string;
  /** BLOCK 객체 핸들 */
  handle: string;
  /** BLOCK_RECORD 핸들 */
  recordHandle: string;
  basePoint: Vec3;
  /** 70: 1 익명, 2 속성 정의 있음, 4 외부 참조, 8 오버레이, 16 외부 의존, 32 확인됨, 64 참조됨 */
  flags: number;
  xrefPath?: string;
  description?: string;
  layer?: string;
  /** 그리기 순서(파일 순서) */
  entities: Entity[];
  /** 끝 표지(ENDBLK) 핸들 */
  endHandle?: string;
}

export interface PlotSettings {
  pageSetupName: string;
  printerName: string;
  paperName: string;
  /** 용지 크기(mm, 44·45) */
  paperWidth: number;
  paperHeight: number;
  /** 인쇄할 수 없는 여백(mm): 왼쪽·아래·오른쪽·위(40~43) */
  margins: [number, number, number, number];
  plotOrigin: Vec2;
  windowMin: Vec2;
  windowMax: Vec2;
  /** 142·143 축척 분자·분모 */
  scaleNumerator: number;
  scaleDenominator: number;
  /** 70 플롯 배치 플래그 */
  flags: number;
  /** 72: 0 인치, 1 mm, 2 픽셀 */
  paperUnits: number;
  /** 73: 0 회전 없음, 1 90°, 2 180°, 3 270° */
  rotation: number;
  /** 74: 0 표시, 1 범위, 2 한계, 3 뷰, 4 창, 5 배치 */
  plotType: number;
  styleSheet: string;
  standardScaleType: number;
}

export interface Layout {
  name: string;
  handle: string;
  tabOrder: number;
  /** 배치의 블록 레코드 핸들 */
  blockRecord: string;
  /** 배치 블록 이름(*Model_Space, *Paper_Space, *Paper_Space0…) */
  blockName: string;
  flags: number;
  limitsMin: Vec2;
  limitsMax: Vec2;
  insertionBase: Vec3;
  extMin: Vec3;
  extMax: Vec3;
  elevation: number;
  ucsOrigin: Vec3;
  ucsXAxis: Vec3;
  ucsYAxis: Vec3;
  /** 마지막으로 활성화된 뷰포트 핸들(331) */
  viewport?: string;
  plot: PlotSettings;
}

// ---------------------------------------------------------------------------
// 비도형 객체(OBJECTS)
// ---------------------------------------------------------------------------

export interface ObjectBase {
  type: string;
  handle: string;
  owner?: string;
  xdict?: string;
  reactors?: string[];
  xdata?: XData[];
  /** DWG 리더가 남긴 원본 본문(같은 버전으로 다시 쓸 때만 쓴다) */
  dwgRaw?: DwgRawBody;
}

export interface DictionaryObject extends ObjectBase {
  type: 'DICTIONARY' | 'ACDBDICTIONARYWDFLT';
  /** 이름 → 핸들 */
  entries: Map<string, string>;
  hardOwner: boolean;
  cloning: number;
  defaultHandle?: string;
}

export interface MLineStyleElement {
  offset: number;
  color: CadColor;
  linetype: string;
}

export interface MLineStyleObject extends ObjectBase {
  type: 'MLINESTYLE';
  name: string;
  /** 70: 1 채우기, 2 연결부 표시, 16 시작 사각 마구리, 32 시작 내부 호, 64 시작 바깥 호, 256 끝 사각, 512 끝 내부 호, 1024 끝 바깥 호 */
  flags: number;
  description: string;
  fillColor: CadColor;
  startAngle: number;
  endAngle: number;
  elements: MLineStyleElement[];
}

export interface ImageDefObject extends ObjectBase {
  type: 'IMAGEDEF';
  fileName: string;
  imageSize: Vec2;
  pixelSize: Vec2;
  loaded: boolean;
  resolutionUnits: number;
}

export interface UnderlayDefObject extends ObjectBase {
  type: 'PDFDEFINITION' | 'DWFDEFINITION' | 'DGNDEFINITION';
  fileName: string;
  name: string;
}

export interface SortEntsTableObject extends ObjectBase {
  type: 'SORTENTSTABLE';
  blockRecord: string;
  /** 객체 핸들과 정렬 핸들 쌍 */
  entries: { entity: string; sort: string }[];
}

export interface GroupObject extends ObjectBase {
  type: 'GROUP';
  description: string;
  unnamed: boolean;
  selectable: boolean;
  entities: string[];
}

export interface XRecordObject extends ObjectBase {
  type: 'XRECORD';
  cloning: number;
  data: RawTag[];
}

export interface SpatialFilterObject extends ObjectBase {
  type: 'SPATIAL_FILTER';
  /** 경계 점(블록 좌표 또는 클립 좌표) */
  boundary: Vec2[];
  normal: Vec3;
  origin: Vec3;
  displayBoundary: boolean;
  frontClip?: number;
  backClip?: number;
  /** 4x3 행렬(12개, 행 우선) — 블록 → 클립 좌표 역변환과 클립 변환 */
  inverseBlockTransform: number[];
  clipTransform: number[];
  inverted?: boolean;
}

export interface MLeaderStyleObject extends ObjectBase {
  type: 'MLEADERSTYLE';
  name: string;
  contentType: number;
  leaderLineType: number;
  leaderLineColor: CadColor;
  leaderLineWeight: number;
  landing: boolean;
  doglegLength: number;
  arrowHeadHandle?: string;
  arrowSize: number;
  textStyleHandle?: string;
  textHeight: number;
  textColor: CadColor;
  landingGap: number;
  scale: number;
  blockHandle?: string;
  raw?: RawTag[];
}

export interface ScaleObject extends ObjectBase {
  type: 'SCALE';
  name: string;
  paperUnits: number;
  drawingUnits: number;
  unitScale: boolean;
}

export interface LayoutObject extends ObjectBase {
  type: 'LAYOUT';
  layout: Layout;
}

export interface PlotSettingsObject extends ObjectBase {
  type: 'PLOTSETTINGS';
  plot: PlotSettings;
}

export interface GenericObject extends ObjectBase {
  type: string;
  raw?: RawTag[];
  /** DBCOLOR의 색(트루컬러·색상표 이름) */
  color?: CadColor;
}

export type CadObject =
  | DictionaryObject
  | MLineStyleObject
  | ImageDefObject
  | UnderlayDefObject
  | SortEntsTableObject
  | GroupObject
  | XRecordObject
  | SpatialFilterObject
  | MLeaderStyleObject
  | ScaleObject
  | LayoutObject
  | PlotSettingsObject
  | GenericObject;

// ---------------------------------------------------------------------------
// 문서
// ---------------------------------------------------------------------------

export type HeaderValue = string | number | Vec3 | Vec2;

export interface CadClass {
  dxfName: string;
  cppName: string;
  appName: string;
  proxyFlags: number;
  instanceCount: number;
  wasProxy: boolean;
  isEntity: boolean;
  /** DWG 클래스 번호(500부터) */
  number?: number;
}

export type SourceFormat = 'dxf' | 'dwg' | 'new';

export interface ReadWarning {
  code: string;
  message: string;
  count?: number;
  detail?: Record<string, unknown>;
}

/** 모델이 해석하지 않는 DXF 구역(THUMBNAILIMAGE, ACDSDATA 등)의 원본 태그(0 SECTION·2 이름·0 ENDSEC 제외) */
export interface RawSection {
  name: string;
  /** 읽은 파일의 $ACADVER */
  version: string;
  tags: RawTag[];
}

/** 표 머리(TABLE) 객체 */
export interface TableHead {
  handle: string;
  xdict?: string;
  reactors?: string[];
  xdata?: XData[];
}

export interface CadDocument {
  format: SourceFormat;
  /** $ACADVER(AC1009 … AC1032) */
  version: string;
  /** DXF가 이진 형식이었는지 */
  binary?: boolean;
  /** $DWGCODEPAGE */
  codepage: string;
  /** $로 시작하는 DXF 헤더 변수 이름 → 값 */
  header: Map<string, HeaderValue>;
  classes: CadClass[];
  /** 표는 대문자 이름을 키로 쓴다 */
  layers: Map<string, Layer>;
  linetypes: Map<string, Linetype>;
  textStyles: Map<string, TextStyle>;
  dimStyles: Map<string, DimStyle>;
  vports: VPortRecord[];
  views: Map<string, ViewRecord>;
  ucs: Map<string, UcsRecord>;
  appIds: Map<string, TableRecordBase>;
  blockRecords: Map<string, BlockRecord>;
  /** 블록 정의(대문자 이름 키). 모형·배치 공간도 블록이다 */
  blocks: Map<string, BlockDef>;
  /** 탭 순서로 정렬된 배치(첫 항목 = 모형) */
  layouts: Layout[];
  objects: Map<string, CadObject>;
  /** 핸들 → 객체(블록 안 객체 포함, 속성 포함) */
  entityIndex: Map<string, Entity>;
  /** 이름 있는 객체 사전 핸들 */
  rootDictionary?: string;
  warnings: ReadWarning[];
  /** DXF 헤더 변수의 원래 그룹 코드(첫 값) — 쓰기 표에 없는 변수를 다시 쓸 때 쓴다 */
  headerCodes?: Map<string, number>;
  /** 표 이름(VPORT, LTYPE, LAYER …) → 표 머리 */
  tableHeads?: Map<string, TableHead>;
  /** 모델이 해석하지 않는 구역 */
  rawSections?: RawSection[];
}

export function createDocument(format: SourceFormat = 'new'): CadDocument {
  return {
    format,
    version: 'AC1032',
    codepage: 'ANSI_1252',
    header: new Map(),
    classes: [],
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    dimStyles: new Map(),
    vports: [],
    views: new Map(),
    ucs: new Map(),
    appIds: new Map(),
    blockRecords: new Map(),
    blocks: new Map(),
    layouts: [],
    objects: new Map(),
    entityIndex: new Map(),
    warnings: [],
  };
}

export const MODEL_SPACE = '*MODEL_SPACE';
export const PAPER_SPACE = '*PAPER_SPACE';

export function tableKey(name: string): string {
  return name.toUpperCase();
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function v2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export const Z_AXIS: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 1 });

/** 객체 공통 기본값 */
export function entityDefaults(): Omit<EntityBase, 'type'> {
  return {
    handle: '',
    layer: '0',
    linetype: 'ByLayer',
    color: { aci: BYLAYER },
    lineweight: LW_BYLAYER,
    ltscale: 1,
    transparency: TRANSPARENCY_BYLAYER,
  };
}

export function normalizeHandle(h: string | number | bigint): string {
  if (typeof h === 'string') {
    const t = h.trim().replace(/^0+(?=.)/, '');
    return t.toUpperCase();
  }
  return h.toString(16).toUpperCase();
}
