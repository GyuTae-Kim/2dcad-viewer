# 로드맵

목표는 프리즘 서비스의 웹 2D CAD(`/2dcad-viewer`)가 서버와 엔진으로 하던 일을 브라우저 안에서 모두 하는 것입니다.
서버가 하던 파일 해석·편집 계산·저장은 웹 워커가 맡습니다.

## 1단계: 보기와 측정 (완료)

- [x] DXF R12~R2018 리더(ASCII·이진, CP949·UTF-8)
- [x] DWG R13~R2018 리더(ODA 공개 명세로 새로 작성)
- [x] WebGL2 렌더러: 공간 격자 묶음, 그리기 순서 깊이, 선가중치, 투명도, 글리프 인스턴스
- [x] 블록 펼치기(도면층 0·ByBlock 상속, MINSERT, 중첩 16단계), 선종류(복합 선종류 문자), 해치(무늬·단색·그라데이션)
- [x] 문자: 단선 글꼴(SHX 대신), Noto Sans KR 조각 받기, TEXT 정렬, MTEXT 서식·줄바꿈·쌓기·열
- [x] 치수(치수 블록, 블록 없는 치수는 정의점으로), 지시선, 다중 지시선, 여러 줄, 표, 가리기
- [x] 모형·배치 탭, 뷰포트(축척·비틀기·뷰포트별 동결)
- [x] AutoCAD형 화면: 리본, 파일 탭, 명령행(별칭·키워드·점 입력), 상태 막대, 바로가기 메뉴
- [x] 선택(클릭·윈도우·걸침), 특성 팔레트, 도면층 팔레트, 치수 목록, 문자 찾기
- [x] 측정: DIST, MEASUREGEOM(거리·반지름·각도·면적), AREA, ID, LIST, 객체 스냅, 직교
- [x] 내보내기: PNG, SVG, PDF

## 2단계: 편집과 저장 (완료)

- [x] 그리기: LINE, PLINE, CIRCLE, ARC, RECTANG, POLYGON, ELLIPSE, SPLINE, POINT, XLINE, RAY, DONUT, TEXT, MTEXT
- [x] 수정: MOVE, COPY, ROTATE, SCALE, MIRROR, OFFSET, TRIM, EXTEND, FILLET, CHAMFER, BREAK, JOIN, EXPLODE, ERASE, STRETCH, LENGTHEN, ARRAY
- [x] 그립 편집, 명령 취소·복구(U, REDO), 특성 팔레트에서 값 바꾸기, MATCHPROP, 클립보드(Ctrl+C·X·V)
- [x] DXF 저장(R12~R2018, ASCII·이진, 모델이 해석하지 않는 자료는 원본 태그로), 새 도면(acadiso·acad)
- [x] 극좌표 추적, 객체 스냅 추적
- [x] 동적 입력(F12, 커서 옆 프롬프트·거리·입력 중인 값)

## 3단계: 주석·블록·출력

- [x] 치수 작성(DIMLINEAR·DIMALIGNED·DIMANGULAR·DIMRADIUS·DIMDIAMETER·DIMORDINATE·DIMARC) — 치수 스타일대로 치수 블록 생성
- [x] 해치 작성(무늬 66개, 경계 찾기, 섬, 틈 허용, 연관 해치)
- [x] 다중 지시선 작성(MLEADER)
- [x] 블록 삽입·정의, 속성 편집, 블록 편집기(BEDIT)
- [x] 페이지 설정, 배치 만들기·복사·이름 바꾸기·삭제, 흑백·회색조 플롯, 여러 배치를 한 PDF로
- [x] 치수 연속·기준선(DIMCONTINUE·DIMBASELINE)
- [x] 플롯 스타일 표(CTB) 파일 읽기(색·회색조·스크린·선가중치)
- [x] 플롯 미리보기(PREVIEW, 플롯 대화상자의 미리보기)
- [x] 치수 스타일 관리자(DIMSTYLE: 선·기호·문자·맞춤·단위·공차, 고치면 그 스타일의 치수를 다시 만듦)
- [x] 이름 있는 플롯 스타일 표(STB): 객체·도면층의 플롯 스타일 이름으로 펜을 고름

## 3.5단계: 배치·뷰·제도 보조

- [x] 배치 뷰포트: MVIEW(구석·맞춤·켜기/끄기·잠금·객체·폴리곤·2/3/4), VPCLIP, VPLAYER, LAYVPI, CHSPACE
- [x] 뷰포트 안 모형 공간(MSPACE·PSPACE, 두 번 눌러 들어가고 나오기, 뷰포트 안 확대·이동이 뷰포트 뷰를 바꿈)
- [x] 명명된 뷰(VIEW 뷰 관리자, -VIEW)
- [x] 사용자 좌표계(UCS·UCSICON·UCSMAN, 2D 범위의 원점·회전)
- [x] 격자(F7)·스냅(F9), 제도 설정(DSETTINGS), 객체 스냅 설정(OSNAP·-OSNAP)
- [x] 객체 격리·숨기기(ISOLATEOBJECTS·HIDEOBJECTS·UNISOLATEOBJECTS)
- [x] 도면층 도구(LAYLCK·LAYULK·LAYMCUR·LAYMCH·LAYCUR·LAYDEL·LAYMRG)
- [x] 특성 변경(CHPROP·CHANGE·COLOR·DDPTYPE·ATTDISP), 2D 솔리드(SOLID), TIME
- [ ] 모형 타일 뷰포트(VPORTS)

## 4단계: 저장 형식과 참조

- [x] DWG 저장(R2000·R2004·R2010·R2013·R2018, 같은 버전이면 해석하지 않은 객체도 그대로)
- [x] 래스터 이미지: 외부 참조 창(XR)에서 고른 로컬 파일로 연결(화면·PDF·SVG, 자르기·밝기·대비·흐리기)
- [x] 외부 참조(DWG·DXF): 고른 로컬 파일을 별도 문서로 열어 인스턴스 변환·XCLIP대로 그림(화면·뷰포트·출력, 저장 파일에는 섞지 않음)
- [x] PDF 언더레이: 고른 PDF의 페이지를 pdf.js로 그려 붙임(자르기·반전, 단색, 흐리기, 배경 맞춤, 화면·PDF·SVG)
- [x] 중첩 외부 참조(덮어씌우기 제외, 순환 차단), 외부 참조 도면층 재지정(`참조|도면층`, VISRETAIN, 뷰포트 동결)
- [ ] 표 편집, 필드, 연관 치수, 기하 구속, 동적 블록, 주석 축척

## 품질 과제

- [x] Arial·Times와 글자 폭이 같은 OFL 글꼴(Liberation)로 트루타입 문자 배치 맞추기
- [x] 사용자 컴퓨터의 SHX 글꼴 불러오기(SHXFONTS, 일반·큰 글꼴·유니코드, 복합 선종류 도형과 SHAPE 객체)
- [x] 다각형·원 뷰포트 자르기(화면 스텐실, PDF·SVG 자르기 경로)
- [x] XCLIP 블록 자르기(사각형·다각형·반전, 경계 틀)
- [x] 프록시 그림(사용자 객체, ODA 명세 29장의 선·원·호·다각형·메시·셸·문자·색·변환)
- [x] 아주 깊이 확대했을 때 곡선 다시 나누기(보이는 영역 세부 장면)
- [x] PSLTSCALE(뷰포트마다 점선 무늬를 종이 길이로 맞춤, 화면·PDF·SVG·플롯)
- [ ] 아주 큰 도면(수백만 객체) 읽기·메모리 최적화

## 다른 형식

OpenCAD의 다음 뷰어로 SKP(SketchUp), STEP, NC(G-code·MPR 등)를 같은 방식(서버 없이 브라우저 안에서)으로 만듭니다.
