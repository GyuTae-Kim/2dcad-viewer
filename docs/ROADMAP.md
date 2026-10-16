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
- [x] 수정 보강: ALIGN, BLEND, COPYM, EXTRIM, OVERKILL, REVERSE, DIVIDE, MEASURE, PEDIT, SPLINEDIT, BOUNDARY, REVCLOUD, WIPEOUT, SCALETEXT, JUSTIFYTEXT
- [x] 블록·그룹·선택: BATTMAN, ATTSYNC, BCOUNT, BURST, BLOCKREPLACE, MINSERT, WBLOCK, GROUP·UNGROUP(PICKSTYLE 그룹 선택), SELECT, QSELECT, SELECTSIMILAR, FILTER
- [x] 유틸리티: OOPS, RENAME, AUDIT, STATUS, QUICKCALC·CAL, LIMITS(한계 밖 점 거부), MULTIPLE, REDRAW

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
- [x] 치수·지시선 편집: DIMEDIT, DIMTEDIT, DIMSPACE, DIMBREAK, DIMJOGLINE, DIMJOGGED, DIMOVERRIDE, QDIM, QLEADER, MLEADEREDIT·ALIGN·COLLECT·STYLE
- [x] 기하 공차(TOLERANCE, 프레임·GDT 기호를 선으로), 중심 표식·중심선(CENTERMARK·CENTERLINE)
- [x] 표(TABLE·TABLEDIT·TABLECELL·TABLESTYLE), 필드(FIELD·UPDATEFIELD), 여러 줄(MLINE·MLSTYLE·MLEDIT)

## 3.5단계: 배치·뷰·제도 보조

- [x] 배치 뷰포트: MVIEW(구석·맞춤·켜기/끄기·잠금·객체·폴리곤·2/3/4), VPCLIP, VPLAYER, LAYVPI, CHSPACE
- [x] 뷰포트 안 모형 공간(MSPACE·PSPACE, 두 번 눌러 들어가고 나오기, 뷰포트 안 확대·이동이 뷰포트 뷰를 바꿈)
- [x] 명명된 뷰(VIEW 뷰 관리자, -VIEW)
- [x] 사용자 좌표계(UCS·UCSICON·UCSMAN, 2D 범위의 원점·회전)
- [x] 격자(F7)·스냅(F9), 제도 설정(DSETTINGS), 객체 스냅 설정(OSNAP·-OSNAP)
- [x] 객체 격리·숨기기(ISOLATEOBJECTS·HIDEOBJECTS·UNISOLATEOBJECTS)
- [x] 도면층 도구(LAYLCK·LAYULK·LAYMCUR·LAYMCH·LAYCUR·LAYDEL·LAYMRG)
- [x] 특성 변경(CHPROP·CHANGE·COLOR·DDPTYPE·ATTDISP), 2D 솔리드(SOLID), TIME
- [x] 모형 타일 뷰포트(VPORTS·-VPORTS: 나누기·결합·이름 있는 구성, 저장하면 같은 타일로 열림)
- [x] 선택 순환(SELECTIONCYCLING), 밝은 화면 테마(COLORTHEME)
- [x] 뷰포트 최대화(VPMAX·VPMIN, 최대화 중 편집·Ctrl+R), 뷰포트 동기화(VPSYNC), 뷰포트 축척(VPSCALE)
- [x] 채우기(FILL)·빠른 문자(QTEXT)·끌기 모드(DRAGMODE), 등각투영 제도(ISODRAFT·ISOPLANE, F5, 등각원)
- [x] 도면층 상태(LAYERSTATE·-LAYERSTATE, ACAD_LAYERSTATES·.las 읽기·쓰기), 도면층 이전(LAYERP), SETBYLAYER

## 4단계: 저장 형식과 참조

- [x] DWG 저장(R2000·R2004·R2010·R2013·R2018, 같은 버전이면 해석하지 않은 객체도 그대로)
- [x] 래스터 이미지: 외부 참조 창(XR)에서 고른 로컬 파일로 연결(화면·PDF·SVG, 자르기·밝기·대비·흐리기)
- [x] 외부 참조(DWG·DXF): 고른 로컬 파일을 별도 문서로 열어 인스턴스 변환·XCLIP대로 그림(화면·뷰포트·출력, 저장 파일에는 섞지 않음)
- [x] PDF 언더레이: 고른 PDF의 페이지를 pdf.js로 그려 붙임(자르기·반전, 단색, 흐리기, 배경 맞춤, 화면·PDF·SVG)
- [x] 중첩 외부 참조(덮어씌우기 제외, 순환 차단), 외부 참조 도면층 재지정(`참조|도면층`, VISRETAIN, 뷰포트 동결)
- [x] 연관 치수(DIMASSOC·DIMREASSOCIATE·DIMDISASSOCIATE·DIMREGEN), 검사 치수(DIMINSPECT)
- [x] 파라메트릭 기하·치수 구속(GEOMCONSTRAINT·DIMCONSTRAINT·AUTOCONSTRAIN·PARAMETERS, 이 앱의 구속 기록으로 저장)
- [x] 동적 블록 참조 편집(DYNPROPS·RESETBLOCK·동적 그립), DWG의 동적 블록 객체 9종 해독·쓰기
- [x] 동적 블록: DWG의 뒤집기·XY·회전·조회·점·기준점·정렬·극좌표 매개변수와 이동·신축·회전·뒤집기·배열·조회·극좌표 신축 동작(30종) 읽기·쓰기, 점·극좌표 편집
- [x] 동적 블록: 배열 동작 평가(AutoCAD 표현 블록과 같은 사본), 정렬 매개변수 그립, 구속 기반 정의 평가(구속 매개변수 값 바꾸기), 대리 노드 DWG 읽기·쓰기
- [ ] 동적 블록: XY·극좌표 값 목록과 극좌표 신축 점 묶음의 DXF 코드, 블록 속성 표·사용자 매개변수(DXF 짝 필요), 구속 매개변수의 DWG 배치
- [x] AutoCAD 파라메트릭 구속(ACAD_ASSOCNETWORK) 읽기·편집(DXF·DWG R2000~R2018): 기하 구속 11종, 거리·반지름·지름 치수 구속, 변수·사용자 매개변수, 고치면 원본 망을 같은 형식으로 갱신
- [x] 이 앱에서 만든 구속을 AutoCAD 2D 구속 그룹으로 저장(일치·평행·직교·동일선상·접선·동심·같은 길이·같은 반지름·수평·수직·고정, 거리·반지름·지름), 같은 반지름 구속 읽기·편집
- [ ] AutoCAD 구속: 각도·대칭·부드러움·타원·스플라인 구속(실물 없음), 다른 매개변수를 쓰는 식의 변수(DXF 배치 미확인)
- [x] 주석 축척(CANNOSCALE·SCALELISTEDIT·OBJECTSCALE·ANNOALLVISIBLE·ANNOAUTOSCALE, 뷰포트마다 주석 축척으로 그림)
- [x] 주석 축척: 치수·해치·다중 지시선의 AutoCAD 축척 레코드 읽기·쓰기(DXF·DWG R2000~R2018), DWG의 MTEXT·블록 참조·속성 레코드
- [x] 주석 축척: 공개 AutoCAD 도면(DWG·DXF 짝)으로 치수·MTEXT·해치·HATCHVIEW·LEADER 레코드 배치 확인, 치수 15비트·MTEXT 열 높이 읽기·쓰기, 해치 뷰포트별 표현(HATCHVIEW) 만들기
- [ ] 주석 축척: 치수 레코드 값(71·280 등)의 뜻, 해치 루프 290 = 0, 여러 줄 속성·다중 지시선·반지름·세로좌표 치수 레코드 실물, 공차(FCF) 레코드, AutoCAD에서 열어 확인
- [x] 도면 비교(COMPARE: 색·구름형 리비전·가져오기·스냅샷 내보내기)
- [x] 외부 참조 비교(XCOMPARE: 다시 불러온 외부 참조의 이전·지금 버전, 모형 공간 최상위 참조)
- [x] 참조 제자리 편집(REFEDIT·REFSET·REFCLOSE), 전자 전송(ETRANSMIT)
- [x] 도면층 탐색·복사·변환(LAYWALK·COPYTOLAYER·LAYTRANS), CAD 표준(STANDARDS·CHECKSTANDARDS), 디자인센터(ADCENTER)
- [x] CAD 표준 연결을 AutoCAD 형식(AcStStandard)으로 저장, LAYTRANS 매핑 불러오기·저장(DWS의 ACLAYTRANS)
- [x] 문자 도구(TXT2MTXT·TEXTALIGN·ATTIPEDIT), 원호 정렬 문자(ARCTEXT, 새로 만든 것은 이 앱 기록 블록으로 저장)
- [x] 스마트 치수(DIM), 옛 지시선(LEADER), 경로 배열(ARRAYPATH, 비연관), -LAYER·-WBLOCK
- [x] 연관 배열(ARRAYRECT·ARRAYPOLAR·ARRAYPATH 연관, ARRAYEDIT·ARRAYCLOSE, 배열 그립·특성, AutoCAD DXF 배열 읽기·편집)
- [x] 연관 배열: 새 배열을 AutoCAD 연관 객체로 쓰기(직사각형·원형·선 경로), DWG 안 AutoCAD 배열·구속의 연관 객체 해독·쓰기
- [x] 연관 배열: 곡선 경로(호·원·폴리선·스플라인) 배열의 AutoCAD 곡선 캐시 읽기·쓰기(DXF·DWG)
- [ ] 연관 배열: 타원 경로, 지운 항목 플래그(실물 없음)
- [x] Express Tools: TCASE·TCOUNT·TORIENT·TEXTFIT·TEXTMASK·TCIRCLE·TXTEXP·SSX·GETSEL·XLIST·XDLIST·NCOPY·GATTE·BREAKLINE·MPEDIT·EXOFFSET·FLATTEN·CDORDER·MKLTYPE·SHOWURLS·REDIR
- [x] 스크립트(SCRIPT·RSCRIPT·RESUME·DELAY, .scr 끌어 놓기)와 명령행 버전 명령(-INSERT·-ATTEDIT·-ARRAY·-HATCH·-BOUNDARY·-PURGE·-STYLE·-LINETYPE·-DIMSTYLE·-UNITS·-OVERKILL·-XREF·-IMAGE·-PLOT), PSETUPIN
- [x] 도면층 필터(특성 필터·그룹 필터, 필터 반전, FILTERS — 이 앱 기록으로 저장하고 AutoCAD의 ACLYDICTIONARY는 보존)
- [x] 도면층 필터를 AutoCAD 형식(ACLYDICTIONARY: AcLyLayerFilter 식·AcLyLayerGroup 핸들, 중첩)으로 읽고 쓰기, 바꿀 수 없는 식은 읽기 전용으로 보존
- [ ] 도면층 필터: 투명도·플롯 스타일·설명·트루컬러 열 이름과 중첩 필터 실물 확인, 지금 고른 필터(290·`<All`) 연동
- [x] AutoLISP 부분 집합(명령행·스크립트 평가, defun c:, command, get*, entget·entmod·entmake, ssget 필터, APPLOAD·.lsp 끌어 놓기)
- [x] 스크립트·AutoLISP: 객체 선택 방식 WP·CP·F, LAYOUT 템플릿(T)·다른 이름으로 저장(SA), 확장 데이터·사전·XRECORD 함수, nentsel·textbox·osnap·grdraw, 이번 세션에 연 파일 읽기
- [x] 좁은 화면·휴대폰·태블릿 배치(겹쳐 펼치는 리본, 아래쪽 팔레트 시트, 상태 막대 넘침 메뉴, 소프트 키보드)
- [x] 블록·참조 명령: ATTOUT·ATTIN·ATTEXT·ATTREDEF, XATTACH·IMAGEATTACH·PDFATTACH·XBIND·XOPEN·BLOCKTOXREF, UNDEFINE·REDEFINE·BASE·TINSERT·PASTESPEC, BLOCKSPALETTE, DIMEX·DIMIM
- [x] 편집·표시 명령: HATCHGENERATEBOUNDARY·HATCHSETBOUNDARY·HATCHSETORIGIN, IMAGEADJUST·IMAGEQUALITY·TRANSPARENCY·PDFADJUST·PDFLAYERS, DIMCENTER, TABLEEXPORT·MATCHCELL, QUICKPROPERTIES, DBLIST, GROUPEDIT, STRETCH의 걸침 폴리곤
- [x] 파일·출력 명령: CLOSEALL·SAVEALL·REVERT, PLOTSTAMP, PLOTSTYLE·CONVERTCTB·CONVERTPSTYLES, MVSETUP·LAYOUTWIZARD, WMFOUT, IMPORT
- [ ] 표 셀 블록(TINSERT를 셀에 담기), AutoCAD Express .dim 실물 형식, PDF 언더레이 대비 표시, IMAGEQUALITY·VIEWRES 화면 반영
- [ ] 스크립트·AutoLISP: (redraw 이름 모드) 강조, MINSERT 칸별 nentsel, 실제 휴대폰 기기 확인
- [x] 등각 설정(SNAPSTYL·SNAPISOPAIR)을 VPORT에 저장, 명령 시작 경합 수정과 앱 확장 지점(src/app/hooks.ts)
- [x] 표를 AutoCAD 표로 남기기: DXF의 셀 병합·셀 정렬·셀 서식, DWG의 ACAD_TABLE·TABLESTYLE 쓰기(R2000~R2018)
- [x] 필드 회색 배경 표시(FIELDDISPLAY)
- [x] AutoCAD FIELD 객체 읽기·쓰기(DXF·DWG)
- [x] PDF 가져오기(PDFIMPORT: 벡터 형상·솔리드 채우기·트루타입 문자)
- [x] 나선(HELIX: 기준·상단 반지름, 회전 수, 비틀기), 스케치(SKETCH), 그라데이션(GRADIENT), 블록 개수(COUNT)
- [x] 이미지·PDF 자르기(IMAGECLIP·PDFCLIP·CLIP), 블록으로·원래 좌표에 붙여넣기, EXPORT·JPGOUT·BMPOUT
- [x] 해치 편집(HATCHEDIT), 블록 자르기(XCLIP), 하이퍼링크(HYPERLINK), 데이터 추출(DATAEXTRACTION, 표·CSV)
- [x] 자동 저장과 도면 복구(SAVETIME·DRAWINGRECOVERY·RECOVER, 이 브라우저에만)
- [x] 배치를 모형으로 내보내기(EXPORTLAYOUT)

## 5단계: AutoCAD처럼 편집하기 (2026-10-16)

저장소 이름을 `2dcad-viewer`에서 `opencad-dwgdxf`로 바꾸고, 보기 전용 뷰어가 아니라 편집기로 쓰도록 손으로 고치는 흐름을 채웠습니다.
프리즘 서비스 웹 2D CAD 명세(기능 목록)와 영역별로 맞대어 빠진 것을 찾았습니다.

- [x] 시작 화면의 새 도면(mm·인치), 소개·제목·공유 이미지를 편집기 기준으로
- [x] 직접 조작: 선택한 객체 끌어 옮기기·복사, 올가미 선택, 창·올가미 미리 강조, 오른쪽 클릭 Enter·상황별 메뉴(SHORTCUTMENU), 두 번 눌러 고치기
- [x] 동적 입력(상대 좌표 기본, 거리·각도 칸 Tab 잠금), 객체 스냅 재지정 입력(END…·FROM·M2P·TT·점 필터), 접점·연장선·평행·가상 교차점·기하학적 중심 스냅, 기본 OSMODE 4133
- [x] Shift 임시 직교, Ctrl 제도 키, 객체 선택 옵션 G·M·AU·SI·U
- [x] 다기능 그립(폴리선 정점·호/선 변환, 길이 조정·반지름, 스플라인 맞춤점, 치수 문자·연속·기준선), 그립 편집 모드·Ctrl 복사·여러 핫 그립·동적 치수
- [x] RECTANG·CIRCLE Ttr·PLINE 호·XLINE·ELLIPSE 호·SPLINE 옵션, 명령행 ARRAYRECT·ARRAYPOLAR, UNDO 옵션, LENGTHEN 동적, PEDIT 정점 편집, TRIM·EXTEND 걸치기·울타리·Shift 전환, MOCORO, REVCLOUD 수정, 3DPOLY·3DFACE·TRACE, 고도·두께
- [x] 여러 줄 문자 제자리 편집기(서식·스택·목록·열·필드), TEXT 도면 위 입력, TEXTEDIT 확장(다중 지시선·공차·지시선 주석·치수 문자), 찾기 및 대치
- [x] 특성 팔레트의 치수·다중 지시선·공차·표 셀 편집, 한 창짜리 DIMSTYLE 관리자, STYLE 대화상자, MLEADER 옵션, 지시선 연관, FIELDEVAL
- [x] BLOCK 재정의·-BLOCK, ATTDEF·INSERT·EATTEDIT 보강, 다른 도면 붙여넣기의 익명 블록 충돌 수정, ADDSELECTED
- [x] 시스템 변수 바로 입력·SYSVDLG·ALIASEDIT·OPTIONS(화면에 바로 반영)·DWGPROPS(DWG 요약 정보 왕복), PAGESETUP 관리자, PLOT 배치에 적용·브라우저 인쇄
- [ ] 기준점 없는 접점(지연된 접점), 스냅 표식 위 Tab 순환, 오른쪽 버튼 끌어 놓기 메뉴, 가상 교차점 정밀화, AUTOSNAP 마그넷·추적 비트
- [ ] Ctrl 순환 다기능 그립(GRIPMULTIFUNCTIONAL 1), 회전·축척 그립의 참조(R), 각도 치수 연속·기준선, 화살표 반전 값
- [ ] SPLINE 공차 근사, 매듭 방식 보존, 3DPOLY의 Z 입력, PLINE 호 Ctrl 방향 전환, ARRAYPOLAR 회전축
- [ ] 표 셀 제자리 편집, 블록 내용 다중 지시선 속성, 자동 쌓기·철자 검사·배경 마스크, DIMARC 지시선, QDIM·DIMJOGGED 머리말 재지정
- [ ] VIEW에 UCS 저장, 사용자 특성 10개 넘게, 배치 플롯 범위·윈도우, 브라우저마다 다른 contenteditable·시간에 민감한 오른쪽 클릭 실기기 확인

## 품질 과제

- [x] Arial·Times와 글자 폭이 같은 OFL 글꼴(Liberation)로 트루타입 문자 배치 맞추기
- [x] 사용자 컴퓨터의 SHX 글꼴 불러오기(SHXFONTS, 일반·큰 글꼴·유니코드, 복합 선종류 도형과 SHAPE 객체)
- [x] 다각형·원 뷰포트 자르기(화면 스텐실, PDF·SVG 자르기 경로)
- [x] XCLIP 블록 자르기(사각형·다각형·반전, 경계 틀)
- [x] 프록시 그림(사용자 객체, ODA 명세 29장의 선·원·호·다각형·메시·셸·문자·색·변환)
- [x] 아주 깊이 확대했을 때 곡선 다시 나누기(보이는 영역 세부 장면)
- [x] PSLTSCALE(뷰포트마다 점선 무늬를 종이 길이로 맞춤, 화면·PDF·SVG·플롯)
- [x] 이미지·가리기 자르기 경계 방향, 맞춤 폴리선의 호, 폭 0 세그먼트, IMAGEFRAME·WIPEOUTFRAME(변수 객체에 저장)
- [x] 아주 큰 도면(수백만 객체) 읽기·메모리 최적화(DXF 바이트 토큰화로 문자열 한계 없이, 장면 상자·글리프를 형식 배열로, 워커→메인 상자 전송; 합성 300만 객체 DXF·DWG를 4GB 힙에서 읽고 그림)
- [x] 큰 도면 점진 빌드(첫 화면에 보이는 객체부터 그려 보이고 나머지는 만드는 대로 이어 그림), 메인 문서 사본 줄이기(장면 뒤에 큰 블록 객체를 묶음으로 부호화해 보냄), 묶음 그리기 호출 줄이기(전체 보기에서 작은 묶음을 큰 칸 무리로 합침)
- [x] 큰 도면 정점 평탄 좌표(경량 폴리선·해치 폴리선 경계 정점을 수 배열로 — 100만 객체 문서 힙 670→555MB), 워커 쪽 문서 부호화 더 빠르게(모양별 쓰기 함수·수 배열 한꺼번에 — 0.9~1.0→0.68초)
- [ ] 나머지 정점 평탄 좌표(2D·3D POLYLINE 정점, 스플라인 제어점·맞춤점, 해치 모서리 경계, 지시선·메시 정점)와 점 객체·공통 속성 줄이기

## 다른 형식

OpenCAD의 다음 뷰어로 SKP(SketchUp), STEP, NC(G-code·MPR 등)를 같은 방식(서버 없이 브라우저 안에서)으로 만듭니다.
2026-10-16부터 형식마다 별도 저장소에서 개발하며, 남은 일도 각 저장소 README에 있습니다.

- [opencad-viewer3d](https://github.com/GyuTae-Kim/opencad-viewer3d): 공용 3D 뷰어 코어(WebGL2)
- [opencad-nc](https://github.com/GyuTae-Kim/opencad-nc): G-code·Heidenhain 평문·woodWOP MPR
- [opencad-step](https://github.com/GyuTae-Kim/opencad-step): STEP(AP203·AP214·AP242)
- [opencad-skp](https://github.com/GyuTae-Kim/opencad-skp): SketchUp 2021~2026

이 저장소에서 3D 문서를 열던 탭·리본·패널 화면(`src/app/view3d/`)은 커밋 `d7c584a`에서 볼 수 있습니다.
