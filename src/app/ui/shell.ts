/** 화면 골격: 제목 막대, 리본, 파일 탭, 배치 탭, 상태 막대, 시작 화면 */
import type { App, UiHooks } from '../app';
import { MODEL_SPACE, tableKey } from '../../core/model';
import { unitAbbr } from '../../core/units';
import { ALL_SNAPS, SNAP_NAMES } from '../snap';
import { Palette, colorToHeader, currentColor } from './palettes';
import type { CadColor, Entity } from '../../core/model';
import { aciToRgb, rgbToCss } from '../../core/color';
import { colorText } from '../inquiry';
import { type Field, GENERAL_FIELDS, applyField, commonValue } from '../propedit';
import { currentLayer, setCurrentLayer } from '../layers';
import { pickColor } from './colorpick';
import { dialog, formatBytes, h, iconSpan, showMenu, toast } from './dom';
import { icon } from './icons';
import { RecentStore } from '../recent';

interface Btn {
  cmd?: string;
  label: string;
  icon: string;
  tip?: string;
  menu?: { label: string; cmd: string; icon?: string }[];
  noDoc?: boolean;
  run?: () => void;
}

interface Panel {
  title: string;
  large?: Btn[];
  cols?: Btn[][];
  /** 리본 안의 고르기 상자(현재 도면층, 색·선종류·선가중치) */
  custom?: 'layer' | 'props';
}

const RIBBON: { tab: string; panels: Panel[] }[] = [
  {
    tab: '홈',
    panels: [
      {
        title: '그리기',
        large: [
          { cmd: 'LINE', label: '선', icon: 'line', tip: '선 (L)' },
          { cmd: 'PLINE', label: '폴리선', icon: 'pline', tip: '폴리선 (PL)' },
          {
            cmd: 'CIRCLE',
            label: '원',
            icon: 'circle',
            tip: '원 (C)',
            menu: [
              { label: '중심, 반지름', cmd: 'CIRCLE', icon: 'circle' },
              { label: '3점', cmd: 'CIRCLE 3P', icon: 'circle' },
              { label: '2점', cmd: 'CIRCLE 2P', icon: 'circle' },
            ],
          },
          {
            cmd: 'ARC',
            label: '호',
            icon: 'arc',
            tip: '호 (A)',
            menu: [
              { label: '3점', cmd: 'ARC', icon: 'arc' },
              { label: '중심, 시작점, 끝점', cmd: 'ARC C', icon: 'arc' },
            ],
          },
        ],
        cols: [
          [
            { cmd: 'RECTANG', label: '직사각형', icon: 'rect', tip: '직사각형 (REC)' },
            { cmd: 'POLYGON', label: '폴리곤', icon: 'polygon', tip: '정다각형 (POL)' },
            { cmd: 'ELLIPSE', label: '타원', icon: 'ellipse', tip: '타원 (EL)' },
          ],
          [
            { cmd: 'SPLINE', label: '스플라인', icon: 'spline', tip: '스플라인 (SPL)' },
            {
              cmd: 'HATCH',
              label: '해치',
              icon: 'hatch',
              tip: '해치 (H)',
              menu: [
                { label: '해치', cmd: 'HATCH', icon: 'hatch' },
                { label: '경계', cmd: 'BOUNDARY', icon: 'pline' },
              ],
            },
            {
              cmd: 'POINT',
              label: '점',
              icon: 'point',
              tip: '점 (PO)',
              menu: [
                { label: '여러 점', cmd: 'POINT', icon: 'point' },
                { label: '등분할', cmd: 'DIVIDE', icon: 'point' },
                { label: '길이 분할', cmd: 'MEASURE', icon: 'point' },
              ],
            },
          ],
          [
            { cmd: 'XLINE', label: '구성선', icon: 'xline', tip: '구성선 (XL)' },
            { cmd: 'RAY', label: '광선', icon: 'ray' },
            { cmd: 'DONUT', label: '도넛', icon: 'donut', tip: '도넛 (DO)' },
          ],
          [
            { cmd: 'REVCLOUD', label: '구름형 수정 기호', icon: 'polygon', tip: '구름형 수정 기호 (REVCLOUD)' },
            { cmd: 'WIPEOUT', label: '가리기', icon: 'rect', tip: '뒤의 객체를 가리는 영역 (WIPEOUT)' },
            {
              cmd: 'MLINE',
              label: '여러 줄',
              icon: 'xline',
              tip: '여러 줄 (ML)',
              menu: [
                { label: '여러 줄', cmd: 'MLINE', icon: 'xline' },
                { label: '여러 줄 편집', cmd: 'MLEDIT', icon: 'xline' },
                { label: '여러 줄 스타일', cmd: 'MLSTYLE', icon: 'settings' },
              ],
            },
          ],
        ],
      },
      {
        title: '수정',
        cols: [
          [
            { cmd: 'MOVE', label: '이동', icon: 'move', tip: '이동 (M)' },
            {
              cmd: 'COPY',
              label: '복사',
              icon: 'copy',
              tip: '복사 (CO)',
              menu: [
                { label: '복사', cmd: 'COPY', icon: 'copy' },
                { label: '여러 번 복사', cmd: 'COPYM', icon: 'copy' },
              ],
            },
            { cmd: 'STRETCH', label: '신축', icon: 'stretch', tip: '신축 (S)' },
          ],
          [
            { cmd: 'ROTATE', label: '회전', icon: 'rotate', tip: '회전 (RO)' },
            { cmd: 'MIRROR', label: '대칭', icon: 'mirror', tip: '대칭 (MI)' },
            { cmd: 'SCALE', label: '축척', icon: 'scale', tip: '축척 (SC)' },
          ],
          [
            {
              cmd: 'TRIM',
              label: '자르기',
              icon: 'trim',
              tip: '자르기 (TR)',
              menu: [
                { label: '자르기', cmd: 'TRIM', icon: 'trim' },
                { label: '경계 한쪽 모두 자르기', cmd: 'EXTRIM', icon: 'trim' },
              ],
            },
            { cmd: 'EXTEND', label: '연장', icon: 'extend', tip: '연장 (EX)' },
            { cmd: 'OFFSET', label: '간격띄우기', icon: 'offset', tip: '간격띄우기 (O)' },
          ],
          [
            { cmd: 'FILLET', label: '모깎기', icon: 'fillet', tip: '모깎기 (F)' },
            { cmd: 'CHAMFER', label: '모따기', icon: 'chamfer', tip: '모따기 (CHA)' },
            {
              cmd: 'ARRAYRECT',
              label: '배열',
              icon: 'arrayRect',
              tip: '배열 (AR)',
              menu: [
                { label: '직사각형 배열', cmd: 'ARRAYRECT', icon: 'arrayRect' },
                { label: '원형 배열', cmd: 'ARRAYPOLAR', icon: 'arrayPolar' },
              ],
            },
          ],
          [
            { cmd: 'ERASE', label: '지우기', icon: 'erase', tip: '지우기 (E, Delete)' },
            { cmd: 'EXPLODE', label: '분해', icon: 'explode', tip: '분해 (X)' },
            { cmd: 'JOIN', label: '결합', icon: 'join', tip: '결합 (J)' },
          ],
          [
            {
              cmd: 'PEDIT',
              label: '폴리선 편집',
              icon: 'pline',
              tip: '폴리선 편집 (PE)',
              menu: [
                { label: '폴리선 편집', cmd: 'PEDIT', icon: 'pline' },
                { label: '스플라인 편집', cmd: 'SPLINEDIT', icon: 'spline' },
                { label: '혼합 곡선', cmd: 'BLEND', icon: 'spline' },
                { label: '방향 반전', cmd: 'REVERSE', icon: 'redo' },
              ],
            },
            { cmd: 'ALIGN', label: '정렬', icon: 'move', tip: '정렬 (AL)' },
            { cmd: 'OVERKILL', label: '중복 정리', icon: 'erase', tip: '겹치거나 중복된 객체 정리 (OVERKILL)' },
          ],
        ],
      },
      {
        title: '주석',
        large: [{ cmd: 'MTEXT', label: '문자', icon: 'mtext', tip: '여러 줄 문자 (MT)' }],
        cols: [
          [
            { cmd: 'DIMLINEAR', label: '선형 치수', icon: 'dimLinear', tip: '선형 치수 (DLI)' },
            { cmd: 'MLEADER', label: '지시선', icon: 'leader', tip: '다중 지시선 (MLD)' },
            { cmd: 'TEXT', label: '단일 행', icon: 'text', tip: '단일 행 문자 (DT)' },
          ],
        ],
      },
      {
        title: '도면층',
        large: [{ cmd: 'LAYER', label: '도면층 특성', icon: 'layers', tip: '도면층 목록에서 켜기·동결·잠금·색을 바꿉니다 (LA)' }],
        custom: 'layer',
        cols: [
          [
            { cmd: 'LAYOFF', label: '끄기', icon: 'layerOff', tip: '고른 객체의 도면층을 끕니다' },
            { cmd: 'LAYFRZ', label: '동결', icon: 'snow', tip: '고른 객체의 도면층을 동결합니다' },
            { cmd: 'LAYISO', label: '격리', icon: 'layerIso', tip: '고른 객체의 도면층만 남깁니다' },
          ],
          [
            { cmd: 'LAYON', label: '모두 켜기', icon: 'layerAll' },
            { cmd: 'LAYTHW', label: '모두 동결 해제', icon: 'sun' },
            { cmd: 'LAYUNISO', label: '격리 해제', icon: 'layers' },
          ],
        ],
      },
      {
        title: '특성',
        large: [{ cmd: 'MATCHPROP', label: '특성 일치', icon: 'matchprop', tip: '한 객체의 특성을 다른 객체에 복사합니다 (MA)' }],
        custom: 'props',
      },
      {
        title: '유틸리티',
        large: [
          {
            cmd: 'MEASUREGEOM',
            label: '측정',
            icon: 'ruler',
            tip: '거리·반지름·각도·면적 (MEA)',
            menu: [
              { label: '거리', cmd: 'DIST', icon: 'dist' },
              { label: '반지름', cmd: 'MEASURERADIUS', icon: 'radius' },
              { label: '각도', cmd: 'MEASUREANGLE', icon: 'angle' },
              { label: '면적', cmd: 'AREA', icon: 'area' },
            ],
          },
        ],
        cols: [
          [
            { cmd: 'ID', label: 'ID 점', icon: 'id', tip: '점의 좌표 (ID)' },
            { cmd: 'LIST', label: '리스트', icon: 'list', tip: '객체 정보를 명령행에 보입니다 (LI)' },
            { cmd: 'SELECTALL', label: '모두 선택', icon: 'selectAll', tip: 'Ctrl+A' },
          ],
          [
            {
              cmd: 'QSELECT',
              label: '신속 선택',
              icon: 'selectAll',
              tip: '종류·특성·값으로 고르기 (QSELECT)',
              menu: [
                { label: '신속 선택', cmd: 'QSELECT', icon: 'selectAll' },
                { label: '선택 필터', cmd: 'FILTER', icon: 'find' },
              ],
            },
            { cmd: 'SELECTSIMILAR', label: '유사 선택', icon: 'selectAll', tip: '같은 종류·도면층·이름의 객체 고르기' },
            { cmd: 'QUICKCALC', label: '계산기', icon: 'quick', tip: '계산기 (QC)' },
          ],
        ],
      },
      {
        title: '그룹',
        cols: [
          [
            { cmd: 'GROUP', label: '그룹', icon: 'blocks', tip: '그룹 만들기 (G)' },
            { cmd: 'UNGROUP', label: '그룹 해제', icon: 'explode' },
            { cmd: 'PICKSTYLE', label: '그룹 선택', icon: 'selectAll', tip: '그룹 단위 고르기 켜기·끄기 (Ctrl+Shift+A)' },
          ],
        ],
      },
    ],
  },
  {
    tab: '삽입',
    panels: [
      {
        title: '블록',
        large: [{ cmd: 'INSERT', label: '삽입', icon: 'insert', tip: '블록 삽입 (I)' }],
        cols: [
          [
            { cmd: 'BLOCK', label: '만들기', icon: 'block', tip: '블록 만들기 (B)' },
            { cmd: 'BEDIT', label: '편집', icon: 'block', tip: '블록 편집기 (BE)' },
            { cmd: 'WBLOCK', label: '블록 쓰기', icon: 'save', tip: '블록·객체를 새 도면 파일로 (W)' },
          ],
          [
            { cmd: 'BATTMAN', label: '속성 관리', icon: 'list', tip: '블록 속성 관리자' },
            { cmd: 'ATTSYNC', label: '속성 동기화', icon: 'redo' },
            { cmd: 'MINSERT', label: '다중 삽입', icon: 'arrayRect', tip: '행·열로 배열한 블록 참조' },
          ],
          [
            { cmd: 'BCOUNT', label: '블록 개수', icon: 'list' },
            { cmd: 'BURST', label: '속성 남기고 분해', icon: 'explode' },
            { cmd: 'BLOCKREPLACE', label: '블록 대치', icon: 'insert' },
          ],
        ],
      },
      {
        title: '참조',
        large: [{ cmd: 'EXTERNALREFERENCES', label: '외부 참조', icon: 'folder', tip: '외부 참조·이미지·PDF 언더레이 (XR)' }],
      },
      {
        title: '데이터',
        cols: [
          [
            { cmd: 'FIELD', label: '필드', icon: 'text', tip: '날짜·파일 이름·객체 특성 등을 문자에 넣기' },
            { cmd: 'UPDATEFIELD', label: '필드 업데이트', icon: 'redo', tip: '고른 문자의 필드를 다시 계산' },
          ],
        ],
      },
    ],
  },
  {
    tab: '주석',
    panels: [
      {
        title: '문자',
        large: [{ cmd: 'MTEXT', label: '여러 줄 문자', icon: 'mtext', tip: '여러 줄 문자 (MT)' }],
        cols: [
          [
            { cmd: 'TEXT', label: '단일 행', icon: 'text', tip: '단일 행 문자 (DT)' },
            { cmd: 'FIND', label: '문자 찾기', icon: 'find', tip: '도면 안의 문자를 찾아 이동합니다' },
            { cmd: 'STYLE', label: '문자 스타일', icon: 'text', tip: '문자 스타일 (ST)' },
          ],
          [
            { cmd: 'SCALETEXT', label: '문자 축척', icon: 'scale', tip: '문자 높이를 한 번에 바꾸기' },
            { cmd: 'JUSTIFYTEXT', label: '자리맞추기', icon: 'text', tip: '위치는 그대로 두고 자리맞추기만 바꾸기' },
          ],
        ],
      },
      {
        title: '치수',
        large: [{ cmd: 'DIMLINEAR', label: '선형', icon: 'dimLinear', tip: '선형 치수 (DLI)' }],
        cols: [
          [
            { cmd: 'DIMALIGNED', label: '정렬', icon: 'dimAligned', tip: '정렬 치수 (DAL)' },
            { cmd: 'DIMANGULAR', label: '각도', icon: 'dimAngular', tip: '각도 치수 (DAN)' },
            { cmd: 'DIMRADIUS', label: '반지름', icon: 'dimRadius', tip: '반지름 치수 (DRA)' },
          ],
          [
            { cmd: 'DIMDIAMETER', label: '지름', icon: 'dimDiameter', tip: '지름 치수 (DDI)' },
            { cmd: 'DIMSTYLE', label: '치수 스타일', icon: 'dimLinear', tip: '치수 스타일 (D)' },
            { cmd: 'DIMLIST', label: '치수 목록', icon: 'dimlist', tip: '도면의 치수와 실제 측정값을 비교합니다' },
          ],
          [
            { cmd: 'DIMJOGGED', label: '꺾기', icon: 'dimRadius', tip: '꺾기 반지름 치수 (DJO)' },
            { cmd: 'QDIM', label: '빠른 치수', icon: 'dimLinear', tip: '고른 객체에 연속·기준선·반지름 치수 한 번에' },
            { cmd: 'DIMSPACE', label: '간격 조정', icon: 'dimAligned', tip: '평행 치수 간격 맞추기' },
          ],
          [
            { cmd: 'DIMBREAK', label: '끊기', icon: 'break', tip: '치수·지시선을 교차하는 곳에서 끊기' },
            { cmd: 'DIMJOGLINE', label: '꺾어진 선형', icon: 'dimLinear', tip: '선형 치수에 꺾기선 (DJL)' },
            { cmd: 'DIMOVERRIDE', label: '재지정', icon: 'settings', tip: '치수 변수 재지정 (DOV)' },
          ],
          [
            { cmd: 'DIMEDIT', label: '치수 편집', icon: 'dimLinear', tip: '문자·기울기 (DED)' },
            { cmd: 'DIMTEDIT', label: '문자 위치', icon: 'text', tip: '치수 문자 옮기기·정렬' },
            { cmd: 'TOLERANCE', label: '공차', icon: 'rect', tip: '기하 공차 (TOL)' },
          ],
        ],
      },
      {
        title: '지시선',
        large: [{ cmd: 'MLEADER', label: '다중 지시선', icon: 'leader', tip: '다중 지시선 (MLD)' }],
        cols: [
          [
            { cmd: 'QLEADER', label: '빠른 지시선', icon: 'leader', tip: '지시선과 여러 줄 문자 (LE)' },
            { cmd: 'MLEADEREDIT', label: '추가·제거', icon: 'leader', tip: '다중 지시선에 지시선 추가·제거 (MLE)' },
            { cmd: 'MLEADERALIGN', label: '정렬', icon: 'leader', tip: '다중 지시선 정렬 (MLA)' },
          ],
          [
            { cmd: 'MLEADERCOLLECT', label: '수집', icon: 'blocks', tip: '블록 다중 지시선 모으기 (MLC)' },
            { cmd: 'MLEADERSTYLE', label: '지시선 스타일', icon: 'settings', tip: '다중 지시선 스타일 (MLS)' },
          ],
        ],
      },
      {
        title: '표',
        large: [{ cmd: 'TABLE', label: '테이블', icon: 'table', tip: '표 삽입 (TB)' }],
        cols: [
          [
            { cmd: 'TABLEDIT', label: '셀 문자', icon: 'text', tip: '표 셀 문자 편집(표를 두 번 눌러도 됨)' },
            { cmd: 'TABLECELL', label: '셀 편집', icon: 'table', tip: '행·열 삽입·삭제, 병합, 정렬 (TCELL)' },
            { cmd: 'TABLESTYLE', label: '테이블 스타일', icon: 'settings', tip: '테이블 스타일 (TS)' },
          ],
        ],
      },
      {
        title: '중심선',
        cols: [
          [
            { cmd: 'CENTERMARK', label: '중심 표식', icon: 'circle', tip: '원·호의 중심 표식 (CM)' },
            { cmd: 'CENTERLINE', label: '중심선', icon: 'xline', tip: '두 선 사이 중심선 (CL)' },
          ],
        ],
      },
    ],
  },
  {
    tab: '뷰',
    panels: [
      {
        title: '탐색',
        large: [{ cmd: 'ZOOMEXTENTS', label: '범위', icon: 'extents' }],
        cols: [
          [
            { cmd: 'ZOOM W', label: '윈도우', icon: 'zoomWindow' },
            { cmd: 'ZOOMPREVIOUS', label: '이전', icon: 'zoomPrev' },
            { cmd: 'PAN', label: '초점이동', icon: 'pan' },
          ],
          [
            { cmd: 'ZOOMIN', label: '확대', icon: 'zoomIn' },
            { cmd: 'ZOOMOUT', label: '축소', icon: 'zoomOut' },
          ],
        ],
      },
      {
        title: '팔레트',
        cols: [
          [
            { cmd: 'PROPERTIES', label: '특성', icon: 'props' },
            { cmd: 'LAYER', label: '도면층', icon: 'layers' },
            { cmd: 'DIMLIST', label: '치수 목록', icon: 'dimlist' },
          ],
          [
            { cmd: 'FIND', label: '문자 찾기', icon: 'find' },
            { cmd: 'DWGINFO', label: '도면 정보', icon: 'info' },
            { cmd: 'UNITS', label: '도면 단위', icon: 'coord' },
          ],
        ],
      },
      {
        title: '뷰·좌표',
        cols: [
          [
            { cmd: 'VIEW', label: '뷰 관리자', icon: 'views', tip: '지금 화면을 이름 붙여 저장하고 다시 불러오기' },
            { cmd: 'UCS', label: 'UCS', icon: 'ucs', tip: '사용자 좌표계의 원점·방향 바꾸기' },
            { cmd: 'UCSMAN', label: 'UCS 관리자', icon: 'coord' },
          ],
          [
            { cmd: 'DSETTINGS', label: '제도 설정', icon: 'settings', tip: '스냅·격자, 극좌표 추적, 객체 스냅 설정' },
            { cmd: 'ISOLATEOBJECTS', label: '객체 격리', icon: 'isolate', tip: '고른 객체만 보이기(UNISOLATEOBJECTS로 끝)' },
            { cmd: 'UNISOLATEOBJECTS', label: '격리 끝', icon: 'eye' },
          ],
        ],
      },
      {
        title: '모형 뷰포트',
        large: [
          {
            cmd: 'VPORTS',
            label: '뷰포트 구성',
            icon: 'viewport',
            tip: '모형 화면을 여러 타일 뷰포트로 나누기 (VPORTS)',
            menu: [
              { label: '하나', cmd: '-VPORTS SI', icon: 'viewport' },
              { label: '둘: 수직', cmd: '-VPORTS 2 V', icon: 'viewport' },
              { label: '둘: 수평', cmd: '-VPORTS 2 H', icon: 'viewport' },
              { label: '셋: 오른쪽', cmd: '-VPORTS 3 R', icon: 'viewport' },
              { label: '셋: 왼쪽', cmd: '-VPORTS 3 L', icon: 'viewport' },
              { label: '넷: 동일', cmd: '-VPORTS 4', icon: 'viewport' },
              { label: '결합', cmd: '-VPORTS J', icon: 'viewport' },
              { label: '뷰포트 대화상자…', cmd: 'VPORTS', icon: 'settings' },
            ],
          },
        ],
      },
      {
        title: '배치 뷰포트',
        cols: [
          [
            { cmd: 'MVIEW', label: '뷰포트 만들기', icon: 'viewport', tip: '배치에 뷰포트를 만들거나 켜기·끄기·잠그기' },
            { cmd: 'VPCLIP', label: '뷰포트 자르기', icon: 'polygon' },
            { cmd: 'VPLAYER', label: '뷰포트 도면층', icon: 'layers' },
          ],
          [
            { cmd: 'MSPACE', label: '모형 공간', icon: 'model', tip: '뷰포트 안으로 들어가 모형을 다루기(뷰포트 안을 두 번 눌러도 됨)' },
            { cmd: 'PSPACE', label: '종이 공간', icon: 'paper', tip: '뷰포트에서 나오기(뷰포트 밖을 두 번 눌러도 됨)' },
            { cmd: 'CHSPACE', label: '공간 변경', icon: 'move' },
          ],
        ],
      },
      {
        title: '표시',
        large: [
          { cmd: 'BACKGROUND', label: '배경색', icon: 'background', noDoc: true, tip: '검정·흰색 배경 전환' },
          { cmd: 'LWDISPLAY', label: '선가중치', icon: 'lineweight', noDoc: true, tip: '선가중치 표시 켜기·끄기' },
          { cmd: 'SHXFONTS', label: 'SHX 글꼴', icon: 'text', noDoc: true, tip: '이 컴퓨터의 SHX 글꼴을 불러와 도면 문자를 원래 글꼴로 그리기' },
          { cmd: 'FULLSCREEN', label: '전체 화면', icon: 'fullscreen', noDoc: true },
        ],
      },
    ],
  },
  {
    tab: '관리',
    panels: [
      {
        title: '정리',
        cols: [
          [
            { cmd: 'AUDIT', label: '감사', icon: 'info', tip: '도면 오류 찾기·고치기' },
            { cmd: 'PURGE', label: '소거', icon: 'erase', tip: '쓰지 않는 블록·도면층·스타일 지우기' },
            { cmd: 'OVERKILL', label: '중복 정리', icon: 'erase' },
          ],
        ],
      },
      {
        title: '도면',
        cols: [
          [
            { cmd: 'RENAME', label: '이름 바꾸기', icon: 'text', tip: '도면층·블록·스타일 등의 이름 (REN)' },
            { cmd: 'STATUS', label: '상태', icon: 'list' },
            { cmd: 'LIMITS', label: '도면 한계', icon: 'rect' },
          ],
          [
            { cmd: 'UNITS', label: '단위', icon: 'coord' },
            { cmd: 'DWGINFO', label: '도면 정보', icon: 'info' },
          ],
        ],
      },
    ],
  },
  {
    tab: '출력',
    panels: [
      {
        title: '플롯',
        large: [
          { cmd: 'PLOT', label: '플롯', icon: 'print', tip: '용지·축척·플롯 스타일을 골라 PDF로 출력 (Ctrl+P)' },
          { cmd: 'PUBLISH', label: '모든 배치', icon: 'exportPdf', tip: '모든 배치를 PDF 하나로' },
        ],
      },
      {
        title: '내보내기',
        large: [
          { cmd: 'PNGOUT', label: 'PNG', icon: 'exportPng', tip: '지금 화면을 이미지로 저장' },
          { cmd: 'SVGOUT', label: 'SVG', icon: 'exportSvg', tip: '지금 공간을 벡터 그림으로 저장' },
        ],
      },
    ],
  },
];

export class Shell implements UiHooks {
  private readonly title: HTMLDivElement;
  private readonly ribbonTabs: HTMLDivElement;
  private readonly ribbon: HTMLDivElement;
  private readonly fileTabs: HTMLDivElement;
  readonly drawingHost: HTMLDivElement;
  private readonly start: HTMLDivElement;
  private readonly busy: HTMLDivElement;
  private readonly busyText: HTMLDivElement;
  private readonly busyBar: HTMLDivElement;
  private readonly layoutTabs: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly coords: HTMLSpanElement;
  private readonly fileInput: HTMLInputElement;
  private activeTab = 0;
  private app!: App;
  palette!: Palette;
  readonly recent = new RecentStore();
  private readonly workspace: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.fileInput = h('input', { type: 'file', accept: '.dxf,.dwg,.DXF,.DWG', multiple: true, hidden: true });
    this.title = h('div', { class: 'titlebar' });
    this.ribbonTabs = h('div', { class: 'ribbon-tabs', role: 'tablist' });
    this.ribbon = h('div', { class: 'ribbon' });
    this.fileTabs = h('div', { class: 'filetabs' });
    this.workspace = h('div', { class: 'workspace' });
    this.drawingHost = h('div', { style: 'position:relative;display:flex;flex:1;min-width:0' });
    this.start = h('div', { class: 'start' });
    this.busyText = h('div');
    this.busyBar = h('div');
    this.busy = h('div', { class: 'busy', hidden: true }, h('div', { class: 'busy-box' }, this.busyText, h('div', { class: 'bar' }, this.busyBar)));
    this.drawingHost.append(this.start, this.busy);
    this.workspace.append(this.drawingHost);
    this.layoutTabs = h('div', { class: 'layouttabs' });
    this.coords = h('span', { class: 'coords' });
    this.status = h('div', { class: 'statusbar' });
    root.append(this.title, this.ribbonTabs, this.ribbon, this.fileTabs, this.workspace, this.layoutTabs, this.status, this.fileInput);
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      void this.openFiles(files);
    });
    // 끌어다 놓기(어디에나)
    window.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      this.start.querySelector('.dropzone')?.classList.add('drag');
    });
    window.addEventListener('dragleave', () => this.start.querySelector('.dropzone')?.classList.remove('drag'));
    window.addEventListener('drop', (ev) => {
      ev.preventDefault();
      this.start.querySelector('.dropzone')?.classList.remove('drag');
      const files = [...(ev.dataTransfer?.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
  }

  attach(app: App): void {
    this.app = app;
    // 좁은 화면에서는 리본을 접어 두고 탭을 누르면 펼친다
    if (window.innerWidth < 760) this.ribbon.classList.add('collapsed');
    let rt = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = window.setTimeout(() => this.buildRibbon(), 150);
    });
    this.palette = new Palette(app, this.workspace);
    this.buildTitle();
    this.buildRibbon();
    this.buildStatus();
    this.buildStart();
    this.refreshTabs();
    this.refreshLayouts();
  }

  pickFiles(): void {
    this.fileInput.click();
  }

  async openFiles(files: File[]): Promise<void> {
    for (const f of files) {
      if (f.size > 512 * 1024 * 1024) {
        toast(`${f.name}: 512MB보다 큰 파일은 열 수 없습니다.`, 'error');
        continue;
      }
      const buf = await f.arrayBuffer();
      const copy = buf.slice(0);
      const st = await this.app.openFile(f.name, buf);
      if (st) void this.recent.add(f.name, copy).then(() => this.refreshRecent());
    }
  }

  // -------------------------------------------------------------------------

  private buildTitle(): void {
    const app = this.app;
    const appBtn = h('button', { class: 'app-button', title: '응용프로그램 메뉴', 'aria-label': '응용프로그램 메뉴' }, 'A');
    appBtn.addEventListener('click', () => {
      const r = appBtn.getBoundingClientRect();
      showMenu(r.left, r.bottom + 2, [
        { label: '새로 만들기', icon: 'new', kbd: 'Ctrl+N', run: () => void app.run('NEW') },
        { label: '열기…', icon: 'open', kbd: 'Ctrl+O', run: () => this.pickFiles() },
        { label: '예제 도면 열기', icon: 'sample', run: () => void this.openSample() },
        { separator: true },
        { label: '저장', icon: 'save', kbd: 'Ctrl+S', disabled: !app.active, run: () => void app.run('QSAVE') },
        { label: '다른 이름으로 저장…', icon: 'save', kbd: 'Ctrl+Shift+S', disabled: !app.active, run: () => void app.run('SAVEAS') },
        { separator: true },
        { label: 'PNG로 내보내기', icon: 'exportPng', disabled: !app.active, run: () => void app.run('PNGOUT') },
        { label: 'SVG로 내보내기', icon: 'exportSvg', disabled: !app.active, run: () => void app.run('SVGOUT') },
        { label: '플롯(PDF)…', icon: 'print', kbd: 'Ctrl+P', disabled: !app.active, run: () => void app.run('PLOT') },
        { label: '모든 배치를 PDF로', icon: 'exportPdf', disabled: !app.active, run: () => void app.run('PUBLISH') },
        { separator: true },
        { label: '도면 정보', icon: 'info', disabled: !app.active, run: () => void app.run('DWGINFO') },
        { label: '닫기', icon: 'close', disabled: !app.active, run: () => app.active && app.close(app.active) },
        { separator: true },
        { label: '단축키·도움말', icon: 'help', kbd: 'F1', run: () => void app.run('HELP') },
        { label: '이 뷰어에 대하여', icon: 'info', run: () => void app.run('ABOUT') },
      ]);
    });
    const qat = h(
      'div',
      { class: 'qat' },
      this.iconBtn('new', '새 도면 (Ctrl+N)', () => void app.run('NEW')),
      this.iconBtn('open', '열기 (Ctrl+O)', () => this.pickFiles()),
      this.iconBtn('save', '저장 (Ctrl+S)', () => void app.run('QSAVE')),
      this.iconBtn('undo', '명령 취소 (Ctrl+Z)', () => void app.run('U')),
      this.iconBtn('redo', '다시 실행 (Ctrl+Y)', () => void app.run('REDO')),
      this.iconBtn('print', 'PDF로 인쇄 (Ctrl+P)', () => void app.run('PLOT')),
    );
    const titleText = h('div', { class: 'title' }, h('b', {}, 'OpenCAD'), ' 2D 뷰어');
    const right = h(
      'div',
      { class: 'title-right' },
      this.iconBtn('help', '도움말 (F1)', () => void app.run('HELP')),
      this.iconBtn('fullscreen', '전체 화면', () => void app.run('FULLSCREEN')),
    );
    this.title.append(appBtn, qat, titleText, right);
  }

  private iconBtn(name: string, label: string, run: () => void): HTMLButtonElement {
    return h('button', { class: 'icon-btn', title: label, 'aria-label': label, html: icon(name), onclick: run });
  }

  private buildRibbon(): void {
    this.ribbonTabs.innerHTML = '';
    RIBBON.forEach((t, i) => {
      const b = h('button', { class: `ribbon-tab ${i === this.activeTab ? 'active' : ''}`, role: 'tab' }, t.tab);
      b.addEventListener('click', () => {
        if (this.activeTab === i) this.ribbon.classList.toggle('collapsed');
        else this.ribbon.classList.remove('collapsed');
        this.activeTab = i;
        this.buildRibbon();
      });
      b.addEventListener('dblclick', () => this.ribbon.classList.toggle('collapsed'));
      this.ribbonTabs.append(b);
    });
    this.ribbon.innerHTML = '';
    const tab = RIBBON[this.activeTab]!;
    this.combos = null;
    const els = tab.panels.map((p) => {
      const el = this.panelElement(p);
      this.ribbon.append(el);
      return el;
    });
    // 자리가 모자라면 오른쪽 패널부터 단추 하나로 접는다
    for (let i = tab.panels.length - 1; i > 0 && this.ribbon.scrollWidth > this.ribbon.clientWidth + 1; i--) {
      const p = tab.panels[i]!;
      const folded = this.foldedPanel(p);
      els[i]!.replaceWith(folded);
      // 접힌 패널의 고르기 상자는 펼칠 때 다시 만든다
      const cb = this.combos as Shell['combos'];
      if (cb && p.custom === 'layer') delete cb.layer;
      if (cb && p.custom === 'props') {
        delete cb.color;
        delete cb.linetype;
        delete cb.lineweight;
      }
    }
    this.refreshRibbonState();
  }

  private panelBody(p: Panel): HTMLDivElement {
    const body = h('div', { class: 'rpanel-body' });
    for (const b of p.large ?? []) body.append(this.ribbonButton(b, true));
    if (p.custom === 'layer') body.append(this.layerCombo());
    if (p.custom === 'props') body.append(this.propCombos());
    for (const col of p.cols ?? []) body.append(h('div', { class: 'rbtn-col' }, ...col.map((b) => this.ribbonButton(b, false))));
    return body;
  }

  private panelElement(p: Panel): HTMLDivElement {
    return h('div', { class: 'rpanel' }, this.panelBody(p), h('div', { class: 'rpanel-title' }, p.title));
  }

  /** 접힌 패널: 누르면 패널 내용을 아래로 펼친다 */
  private foldedPanel(p: Panel): HTMLDivElement {
    const ic = p.large?.[0]?.icon ?? p.cols?.[0]?.[0]?.icon ?? 'menu';
    const btn = h('button', { class: 'rbtn-lg folded', title: `${p.title} 패널 펼치기`, 'aria-haspopup': 'true' }, iconSpan(ic), h('span', {}, `${p.title} ▾`));
    btn.addEventListener('click', () => {
      document.querySelector('.ribbon-pop')?.remove();
      const pop = h('div', { class: 'ribbon-pop', role: 'dialog', 'aria-label': p.title }, this.panelBody(p), h('div', { class: 'rpanel-title' }, p.title));
      document.body.append(pop);
      const r = btn.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - pr.width - 4))}px`;
      pop.style.top = `${r.bottom + 2}px`;
      this.refreshRibbonState();
      const off = (ev: Event) => {
        const t = ev.target as Node;
        if (pop.contains(t) && !(t as HTMLElement).closest?.('button.rbtn-lg, button.rbtn-sm')) return;
        if (btn.contains(t)) return;
        setTimeout(() => pop.remove(), 0);
        window.removeEventListener('pointerdown', off, true);
        window.removeEventListener('click', off, true);
      };
      setTimeout(() => {
        window.addEventListener('pointerdown', off, true);
        window.addEventListener('click', off, true);
      });
    });
    return h('div', { class: 'rpanel' }, h('div', { class: 'rpanel-body' }, btn), h('div', { class: 'rpanel-title' }, p.title));
  }

  /** 리본의 고르기 상자들 */
  combos: { layer?: HTMLSelectElement; color?: HTMLButtonElement; linetype?: HTMLSelectElement; lineweight?: HTMLSelectElement } | null = null;

  private layerCombo(): HTMLElement {
    const sel = h('select', { 'aria-label': '도면층', title: '현재 도면층 (객체를 고르면 그 객체의 도면층)' }) as HTMLSelectElement;
    sel.addEventListener('change', () => {
      const app = this.app;
      const st = app.active;
      if (!st || !sel.value) return;
      if (st.selection.size) applyField(app, [...st.selection], GENERAL_FIELDS[0]!, sel.value);
      else setCurrentLayer(app, sel.value);
      this.refreshRibbonState();
    });
    this.combos = { ...(this.combos ?? {}), layer: sel };
    return h('div', { class: 'rprop-col' }, h('label', { class: 'rprop' }, iconSpan('layers'), sel));
  }

  private propCombos(): HTMLElement {
    const app = this.app;
    const color = h('button', { class: 'rprop-color', 'aria-label': '색', title: '색 (객체를 고르면 그 객체의 색)' }) as HTMLButtonElement;
    color.addEventListener('click', async () => {
      const st = app.active;
      if (!st) return;
      const sel = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter((e): e is Entity => !!e);
      const cur = sel.length ? commonValue(GENERAL_FIELDS[1]!, sel).value as CadColor | undefined : currentColor(st.doc);
      const c = await pickColor(cur ?? { aci: 256 }, { allowBy: true });
      if (!c) return;
      if (sel.length) applyField(app, sel.map((e) => e.handle), GENERAL_FIELDS[1]!, c);
      else this.setHeader('$CECOLOR', colorToHeader(c));
      this.refreshRibbonState();
    });
    const lt = h('select', { 'aria-label': '선종류', title: '선종류' }) as HTMLSelectElement;
    lt.addEventListener('change', () => {
      const st = app.active;
      if (!st || !lt.value) return;
      if (st.selection.size) applyField(app, [...st.selection], GENERAL_FIELDS[2]!, lt.value);
      else this.setHeader('$CELTYPE', lt.value);
    });
    const lw = h('select', { 'aria-label': '선가중치', title: '선가중치' }) as HTMLSelectElement;
    lw.addEventListener('change', () => {
      const st = app.active;
      if (!st || !lw.value) return;
      if (st.selection.size) applyField(app, [...st.selection], GENERAL_FIELDS[4]!, lw.value);
      else this.setHeader('$CELWEIGHT', Number(lw.value));
    });
    this.combos = { ...(this.combos ?? {}), color, linetype: lt, lineweight: lw };
    return h(
      'div',
      { class: 'rprop-col' },
      h('div', { class: 'rprop' }, iconSpan('background'), color),
      h('label', { class: 'rprop' }, iconSpan('dimlist'), lt),
      h('label', { class: 'rprop' }, iconSpan('lineweight'), lw),
    );
  }

  private setHeader(name: string, after: string | number): void {
    const st = this.app.active;
    if (!st) return;
    const before = st.doc.header.get(name);
    if (before === after) return;
    st.session.commit({ label: 'SETVAR', ops: [{ kind: 'header', name, before, after }] });
  }

  /** 리본 고르기 상자에 지금 값(고른 객체가 있으면 그 값)을 보인다 */
  private refreshCombos(): void {
    const c = this.combos;
    const st = this.app?.active;
    if (!c) return;
    const fill = (sel: HTMLSelectElement, opts: { value: string; label: string }[], value: string | undefined, varies: boolean) => {
      const key = JSON.stringify(opts) + String(varies);
      if (sel.dataset.key !== key) {
        sel.innerHTML = '';
        if (varies) sel.append(h('option', { value: '' }, '*여러 개*'));
        for (const o of opts) sel.append(h('option', { value: o.value }, o.label));
        sel.dataset.key = key;
      }
      const m = opts.find((o) => o.value.toUpperCase() === (value ?? '').toUpperCase());
      sel.value = varies ? '' : (m?.value ?? '');
    };
    for (const el of [c.layer, c.color, c.linetype, c.lineweight]) if (el) el.disabled = !st;
    if (!st) {
      if (c.color) c.color.textContent = '';
      return;
    }
    const sel = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter((e): e is Entity => !!e);
    const pick = (f: Field, cur: unknown) => (sel.length ? commonValue(f, sel) : { value: cur, varies: false });
    const hdr = st.doc.header;
    if (c.layer) {
      const v = pick(GENERAL_FIELDS[0]!, currentLayer(this.app));
      fill(c.layer, GENERAL_FIELDS[0]!.options!(st.doc), v.value as string | undefined, v.varies);
    }
    if (c.color) {
      const v = pick(GENERAL_FIELDS[1]!, currentColor(st.doc));
      const col = v.value as CadColor | undefined;
      const rgb = col ? (col.rgb !== undefined && col.aci !== 0 && col.aci !== 256 ? col.rgb : col.aci > 0 && col.aci < 256 ? aciToRgb(col.aci, true) : null) : null;
      c.color.innerHTML = '';
      c.color.append(h('span', { class: 'swatch', style: rgb === null ? 'background:transparent' : `background:${rgbToCss(rgb)}` }), v.varies ? '*여러 개*' : col ? colorText(col) : '');
    }
    if (c.linetype) {
      const v = pick(GENERAL_FIELDS[2]!, String(hdr.get('$CELTYPE') ?? 'ByLayer'));
      fill(c.linetype, GENERAL_FIELDS[2]!.options!(st.doc), v.value as string | undefined, v.varies);
    }
    if (c.lineweight) {
      const v = pick(GENERAL_FIELDS[4]!, String(hdr.get('$CELWEIGHT') ?? -1));
      fill(c.lineweight, GENERAL_FIELDS[4]!.options!(st.doc), v.value as string | undefined, v.varies);
    }
  }

  private ribbonButton(b: Btn, large: boolean): HTMLButtonElement {
    const el = h('button', { class: large ? 'rbtn-lg' : 'rbtn-sm', title: b.tip ?? b.label, 'data-cmd': b.cmd ?? '', 'data-nodoc': b.noDoc ? '1' : '' }, iconSpan(b.icon), large ? h('span', {}, b.label) : b.label);
    el.addEventListener('click', () => {
      if (b.menu) {
        const r = el.getBoundingClientRect();
        showMenu(r.left, r.bottom + 2, [
          ...b.menu.map((m) => ({ label: m.label, icon: m.icon, run: () => void this.runCmd(m.cmd) })),
          { separator: true },
          { label: `${b.label} (${b.cmd})`, icon: b.icon, run: () => void this.runCmd(b.cmd!) },
        ]);
        return;
      }
      if (b.run) b.run();
      else if (b.cmd) void this.runCmd(b.cmd);
    });
    return el;
  }

  private runCmd(s: string): Promise<void> {
    const [name, ...rest] = s.split(' ');
    return this.app.run(name!, rest.length ? rest.join(' ') : undefined);
  }

  private refreshRibbonState(): void {
    const has = !!this.app?.active;
    for (const el of document.querySelectorAll<HTMLButtonElement>('.ribbon button[data-cmd], .ribbon-pop button[data-cmd]')) {
      const c = el.dataset.cmd ?? '';
      const known = !c || !!this.app?.findCommand(c.split(' ')[0]!);
      el.disabled = (!has && !el.dataset.nodoc) || !known;
      if (!known) el.title = `${el.title.replace(/ — 준비 중$/, '')} — 준비 중`;
      if (c === 'LWDISPLAY') el.classList.toggle('on', this.app.view.lwDisplay);
    }
    this.refreshCombos();
  }

  // -------------------------------------------------------------------------
  // 탭
  // -------------------------------------------------------------------------

  refreshTabs(): void {
    const app = this.app;
    this.fileTabs.innerHTML = '';
    const startTab = h('div', { class: `filetab ${!app.active ? 'active' : ''}`, role: 'tab' }, h('span', {}, '시작'));
    startTab.addEventListener('click', () => app.activate(null));
    this.fileTabs.append(startTab);
    for (const d of app.docs) {
      const x = h('button', { class: 'icon-btn x', title: '닫기', 'aria-label': `${d.name} 닫기`, html: icon('close2') });
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        app.close(d);
      });
      const dirty = d.session?.dirty;
      const t = h('div', { class: `filetab ${app.active === d ? 'active' : ''}`, role: 'tab', title: `${d.saveName}${d.size ? ` (${formatBytes(d.size)})` : ''}${dirty ? ' · 저장하지 않은 변경 있음' : ''}` }, h('span', {}, `${d.saveName}${dirty ? ' *' : ''}`), x);
      t.addEventListener('click', () => app.activate(d));
      t.addEventListener('auxclick', (ev) => {
        if ((ev as MouseEvent).button === 1) app.close(d);
      });
      this.fileTabs.append(t);
    }
    const plus = h('button', { class: 'icon-btn', title: '열기', 'aria-label': '파일 열기', html: icon('plus') });
    plus.addEventListener('click', () => this.pickFiles());
    this.fileTabs.append(plus);
    this.refreshRibbonState();
  }

  refreshLayouts(): void {
    const app = this.app;
    const st = app.active;
    this.layoutTabs.innerHTML = '';
    if (!st) return;
    if (st.blockEdit) {
      const be = st.blockEdit;
      const close = h('button', { class: 'layouttab blockedit-close', title: '블록 편집기 닫기 (BCLOSE)' }, '블록 편집기 닫기');
      close.addEventListener('click', () => void app.run('BCLOSE'));
      const save = h('button', { class: 'layouttab', title: '블록 저장 (BSAVE)' }, '블록 저장');
      save.addEventListener('click', () => void app.run('BSAVE'));
      this.layoutTabs.append(h('span', { class: 'layouttab active blockedit-label' }, `블록 편집기: ${be.name}`), save, close);
      return;
    }
    for (const l of st.layouts) {
      const key = tableKey(l.blockName);
      const label = key === MODEL_SPACE ? '모형' : l.name;
      const b = h('button', { class: `layouttab ${st.displaySpace === key ? 'active' : ''}` }, label);
      b.addEventListener('click', () => void app.setSpace(l.blockName));
      b.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const paper = key !== MODEL_SPACE;
        const go = async (cmd: string, arg?: string) => {
          if (paper && st.displaySpace !== key) await app.setSpace(l.blockName);
          void app.run(cmd, arg);
        };
        showMenu(ev.clientX, ev.clientY - (paper ? 190 : 80), [
          { label: '새 배치', run: () => void app.run('LAYOUT', 'N') },
          ...(paper
            ? [
                { label: '배치 복사…', run: () => void go('LAYOUT', 'C') },
                { label: '이름 바꾸기…', run: () => void go('LAYOUT', 'R') },
                { label: '삭제', run: () => void go('LAYOUT', 'D') },
              ]
            : []),
          { separator: true },
          { label: '페이지 설정…', run: () => void go('PAGESETUP') },
          { label: '플롯…', run: () => void go('PLOT') },
        ]);
      });
      this.layoutTabs.append(b);
    }
  }

  // -------------------------------------------------------------------------
  // 상태 막대
  // -------------------------------------------------------------------------

  private statusBtns: Record<string, HTMLButtonElement> = {};
  private spaceLabel = h('span', { class: 'status-text' });
  private unitLabel = h('span', { class: 'status-text' });
  private selLabel = h('span', { class: 'status-text' });

  private buildStatus(): void {
    const app = this.app;
    const mk = (key: string, ic: string, label: string, run: () => void) => {
      const b = this.iconBtn(ic, label, run);
      this.statusBtns[key] = b;
      return b;
    };
    const osnap = mk('osnap', 'osnap', '객체 스냅 (F3) · 오른쪽 클릭으로 종류 선택', () => app.toggleOsnap());
    osnap.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.snapMenu(ev.clientX, ev.clientY);
    });
    const polar = mk('polar', 'polarTrack', '극좌표 추적 (F10) · 오른쪽 클릭으로 증분 각도 선택', () => app.togglePolar());
    polar.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY - 220, [
        { heading: '극좌표 증분 각도' },
        ...[90, 45, 30, 22.5, 18, 15, 10, 5].map((d) => ({
          label: `${Math.abs((app.polarInc * 180) / Math.PI - d) < 1e-9 ? '✓ ' : ' '}${d}°`,
          run: () => {
            app.polarInc = (d * Math.PI) / 180;
            if (!app.polarOn) app.togglePolar();
            this.refreshStatus();
          },
        })),
      ]);
    });
    const caret = h('button', { class: 'icon-btn', title: '객체 스냅 종류', 'aria-label': '객체 스냅 종류', style: 'width:14px;padding:0', html: '▾' });
    caret.addEventListener('click', (ev) => this.snapMenu(ev.clientX, ev.clientY - 260));
    this.status.append(
      this.coords,
      h('span', { class: 'status-sep' }),
      this.spaceLabel,
      h('span', { class: 'status-sep' }),
      osnap,
      caret,
      mk('grid', 'grid', '격자 표시 (F7)', () => app.toggleGrid()),
      mk('snap', 'gridSnap', '스냅 모드 (F9) · 격자 간격으로 점을 맞춥니다', () => app.toggleSnap()),
      mk('ortho', 'ortho', '직교 (F8)', () => app.toggleOrtho()),
      polar,
      mk('otrack', 'otrack', '객체 스냅 추적 (F11) · 스냅점 위에 잠시 머물면 그 점에서 정렬선을 씁니다', () => app.toggleOtrack()),
      mk('dyn', 'dyn', '동적 입력 (F12) · 커서 옆에 프롬프트·거리·입력 중인 값', () => app.toggleDyn()),
      mk('lw', 'lineweight', '선가중치 표시', () => void app.run('LWDISPLAY')),
      mk('bg', 'background', '배경색 전환', () => void app.run('BACKGROUND')),
      h('span', { class: 'status-sep' }),
      this.selLabel,
      h('span', { class: 'status-spacer' }),
      this.unitLabel,
      mk('ext', 'extents', '전체 보기', () => app.view.zoomExtents()),
      mk('props', 'props', '특성 팔레트 (Ctrl+1)', () => this.openPalette('props')),
    );
    this.refreshStatus();
  }

  private snapMenu(x: number, y: number): void {
    const app = this.app;
    showMenu(x, y, [
      { heading: '객체 스냅' },
      ...ALL_SNAPS.map((k) => ({
        label: `${app.snapModes.has(k) ? '✓ ' : ' '}${SNAP_NAMES[k]}`,
        run: () => {
          if (app.snapModes.has(k)) app.snapModes.delete(k);
          else app.snapModes.add(k);
          this.refreshStatus();
        },
      })),
      { separator: true },
      { label: '모두 켜기', run: () => (ALL_SNAPS.forEach((k) => app.snapModes.add(k)), this.refreshStatus()) },
      { label: '모두 끄기', run: () => (app.snapModes.clear(), this.refreshStatus()) },
    ]);
  }

  refreshStatus(): void {
    const app = this.app;
    if (!app) return;
    const st = app.active;
    this.statusBtns.osnap?.classList.toggle('on', app.osnapOn);
    this.statusBtns.ortho?.classList.toggle('on', app.orthoOn);
    this.statusBtns.grid?.classList.toggle('on', app.gridOn);
    this.statusBtns.snap?.classList.toggle('on', app.snapOn);
    this.statusBtns.polar?.classList.toggle('on', app.polarOn);
    this.statusBtns.otrack?.classList.toggle('on', app.otrackOn);
    this.statusBtns.dyn?.classList.toggle('on', app.dynOn);
    this.statusBtns.lw?.classList.toggle('on', app.view.lwDisplay);
    this.statusBtns.bg?.classList.toggle('on', app.view.modelBg === 0xffffff);
    this.spaceLabel.textContent = st
      ? st.blockEdit
        ? `블록 편집기: ${st.blockEdit.name}`
        : st.msVp
          ? `배치: ${st.layoutFor(st.msVp.layout)?.name ?? ''} · 모형 공간(뷰포트)`
          : st.isModel
            ? '모형'
            : `배치: ${st.layoutFor(st.space)?.name ?? ''}`
      : '';
    if (st) {
      const abbr = unitAbbr(st.units.insunits);
      this.unitLabel.textContent = abbr ? `단위: ${abbr}` : '단위 없음';
      this.selLabel.textContent = st.selection.size ? `선택 ${st.selection.size.toLocaleString()}개` : '';
    } else {
      this.unitLabel.textContent = '';
      this.selLabel.textContent = '';
      this.coords.textContent = '';
    }
    this.refreshRibbonState();
  }

  setCoords(text: string): void {
    this.coords.textContent = text;
  }

  refreshPalette(): void {
    this.palette?.refresh();
  }

  openPalette(tab: string): void {
    this.palette.open(tab);
  }

  setBusy(text: string | null, fraction = 0): void {
    if (!text) {
      this.busy.hidden = true;
      return;
    }
    this.busy.hidden = false;
    this.busyText.textContent = text;
    this.busyBar.style.width = `${Math.round(Math.max(0.03, Math.min(1, fraction)) * 100)}%`;
  }

  // -------------------------------------------------------------------------
  // 시작 화면
  // -------------------------------------------------------------------------

  private recentList = h('div', { class: 'recent' });

  showStart(show: boolean): void {
    this.start.hidden = !show;
    if (show) this.refreshRecent();
  }

  private buildStart(): void {
    const drop = h(
      'div',
      { class: 'dropzone', role: 'button', tabindex: 0, 'aria-label': '도면 파일 열기' },
      iconSpan('folder', 'big'),
      h('strong', {}, 'DXF·DWG 파일을 여기에 끌어다 놓으십시오'),
      h('span', {}, '또는'),
      h('button', { class: 'btn primary', onclick: (ev: Event) => (ev.stopPropagation(), this.pickFiles()) }, iconSpan('open'), '파일 열기'),
    );
    drop.addEventListener('click', () => this.pickFiles());
    drop.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') this.pickFiles();
    });
    const sample = h('button', { class: 'btn', onclick: () => void this.openSample() }, iconSpan('sample'), '예제 도면 열기');
    this.start.append(
      h(
        'div',
        { class: 'start-inner' },
        h('h1', {}, 'OpenCAD 2D 뷰어'),
        h('p', { class: 'lead' }, 'CAD 프로그램 없이 브라우저에서 DXF·DWG 도면을 열어 보고, 치수를 확인하고, 거리와 면적을 잽니다. 파일은 서버로 보내지 않고 이 컴퓨터 안에서만 읽습니다.'),
        h(
          'div',
          { class: 'start-grid' },
          drop,
          h(
            'div',
            { class: 'start-side' },
            h('div', { class: 'card' }, h('h3', {}, '최근 문서'), this.recentList),
            h('div', { class: 'card' }, h('h3', {}, '처음이라면'), h('div', { style: 'margin-bottom:8px;color:var(--text-dim)' }, '예제 도면으로 기능을 둘러볼 수 있습니다.'), sample),
            h(
              'div',
              { class: 'card' },
              h('h3', {}, '지원 범위'),
              h('ul', {}, h('li', {}, 'DXF R12~R2018(ASCII·이진)'), h('li', {}, 'DWG R13~R2018'), h('li', {}, '모형·배치, 도면층, 블록, 치수, 해치, 문자'), h('li', {}, '측정, 객체 스냅, 특성 보기, PNG·SVG·PDF 내보내기')),
            ),
          ),
        ),
        h(
          'div',
          { class: 'start-foot', html: '오픈소스 OpenCAD 프로젝트의 2D 뷰어입니다(MIT). SKP·STEP·NC 형식도 차례로 추가합니다. · <a href="https://github.com/GyuTae-Kim/2dcad-viewer" target="_blank" rel="noopener">GitHub</a>' },
        ),
      ),
    );
  }

  private async refreshRecent(): Promise<void> {
    const list = await this.recent.list().catch(() => []);
    this.recentList.innerHTML = '';
    if (!list.length) {
      this.recentList.append(h('div', { style: 'color:var(--text-faint)' }, '아직 연 문서가 없습니다.'));
      return;
    }
    for (const r of list) {
      const b = h('button', {}, h('span', {}, r.name), h('small', {}, `${formatBytes(r.size)} · ${new Date(r.time).toLocaleDateString('ko-KR')}`));
      b.addEventListener('click', async () => {
        const data = await this.recent.get(r.id);
        if (data) void this.app.openFile(r.name, data);
        else toast('저장된 파일을 찾지 못했습니다.', 'warn');
      });
      this.recentList.append(b);
    }
  }

  async openSample(): Promise<void> {
    try {
      const url = new URL('samples/opencad-sample.dxf', document.baseURI);
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      await this.app.openFile('opencad-sample.dxf', await r.arrayBuffer());
    } catch {
      toast('예제 도면을 받지 못했습니다.', 'error');
    }
  }

  showInfo(): void {
    const st = this.app.active;
    if (!st) return;
    const d = st.doc;
    const counts = new Map<string, number>();
    for (const e of d.entityIndex.values()) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    dialog(
      '도면 정보',
      h(
        'div',
        {},
        h('div', { class: 'form-row' }, h('span', {}, '파일'), h('b', {}, `${st.name} (${formatBytes(st.size)})`)),
        h('div', { class: 'form-row' }, h('span', {}, '형식'), h('b', {}, `${d.format.toUpperCase()} ${d.version}${d.binary ? ' 이진' : ''}`)),
        h('div', { class: 'form-row' }, h('span', {}, '코드 페이지'), h('b', {}, d.codepage)),
        h('div', { class: 'form-row' }, h('span', {}, '도면층·블록'), h('b', {}, `${d.layers.size}개 · ${[...d.blocks.values()].filter((b) => !b.name.startsWith('*')).length}개`)),
        h('div', { class: 'form-row' }, h('span', {}, '배치'), h('b', {}, `${d.layouts.length - 1}개`)),
        h('div', { class: 'form-row' }, h('span', {}, '읽기 시간'), h('b', {}, `${Math.round(st.readMs)} ms`)),
        h('h4', { style: 'margin:12px 0 6px' }, '객체 종류'),
        h('table', { class: 'grid' }, h('tbody', {}, ...rows.map(([t, n]) => h('tr', {}, h('td', {}, t), h('td', { style: 'text-align:right' }, n.toLocaleString()))))),
        st.warnings.length ? h('h4', { style: 'margin:12px 0 6px' }, '참고') : null,
        ...st.warnings.map((w) => h('div', { style: 'color:var(--text-dim)' }, `· ${w.message}${w.count ? ` (${w.count})` : ''}`)),
      ),
    );
  }
}
