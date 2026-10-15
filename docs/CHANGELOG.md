# 작업 내역

OpenCAD 2D 뷰어를 만들어 온 과정을 단계별로 정리했습니다. 커밋 하나하나는 `git log`에, 남은 일은 [ROADMAP.md](ROADMAP.md)에 있습니다.
모든 기능은 브라우저 안에서만 동작하며, 연 파일은 사용자 컴퓨터 밖으로 나가지 않습니다.

## 2026-10-15 (4): 도면층 상태·Express Tools·스크립트

여섯 갈래로 나눠 개발하고 합쳤습니다. 이 단계의 커밋은 `d9d15fe`부터입니다. 전체 시험 2750개가 통과한 상태로 배포했습니다.

### 도면층
- 도면층 상태 관리자(LAYERSTATE, Shift+Ctrl+L)와 명령행(-LAYERSTATE, -LAYER의 상태(A))
  - AutoCAD와 같은 자리(LAYER 표 확장 사전의 `ACAD_LAYERSTATES`)에 같은 꼴로 DXF R2000 이상·DWG에 읽고 씁니다.
  - .las 파일과 다른 도면에서 가져오고, .las로 내보냅니다. 복원할 특성을 고를 수 있습니다.
  - 리본 도면층 패널에 상태 목록을 두어 고르면 바로 복원합니다.
- 도면층 이전(LAYERP·LAYERPMODE): 도면층 설정 변경을 한 단계씩 되돌립니다.
- ByLayer로 설정(SETBYLAYER·SETBYLAYERMODE): 블록 정의 안까지 바꿀 수 있습니다.

### Express Tools
- 리본에 Express Tools 탭을 새로 두었습니다.
- 문자: TCASE(서식 코드 보존), TCOUNT, TORIENT, TEXTFIT, TEXTMASK·TEXTUNMASK, TCIRCLE, TXTEXP
- 선택·조회: SSX, GETSEL, XLIST, XDLIST, NCOPY, GATTE
- 그리기·수정: BREAKLINE, MPEDIT, EXOFFSET, FLATTEN, CDORDER, MKLTYPE(.lin 내려받기), SHOWURLS, REDIR

### 스크립트
- SCRIPT·RSCRIPT·RESUME·DELAY: .scr 파일을 고르거나 끌어 놓으면 명령행에 차례로 넣습니다. 오류나 Esc에서 줄 번호와 함께 멈추고, 한 번 실행한 것이 명령 취소 한 번입니다.
- 스크립트에서 쓰는 명령행 버전 명령 14개: -INSERT, -ATTEDIT, -ARRAY, -HATCH, -BOUNDARY, -PURGE, -STYLE, -LINETYPE, -DIMSTYLE, -UNITS, -OVERKILL, -XREF, -IMAGE, -PLOT
- 페이지 설정 가져오기(PSETUPIN·-PSETUPIN)

### 연관 배열
- ARRAYRECT·ARRAYPOLAR·ARRAYPATH가 연관(AS) = 예(ARRAYASSOCIATIVITY 기본값)일 때 연관 배열 하나를 만듭니다.
- ARRAYEDIT(소스·대체·기준점·행·열·레벨·항목·방법·정렬·재설정)와 ARRAYCLOSE, 배열 그립, 특성 팔레트의 배열 항목, Ctrl+클릭으로 항목 지우기.
- 경로 곡선을 고치면 경로 배열이 따라갑니다.
- AutoCAD가 만든 DXF의 연관 배열(직사각형·원형·경로)을 읽어 고치고, 그 형식 그대로 다시 씁니다. 새로 만든 배열은 이 앱 기록으로 저장해 AutoCAD에서는 블록으로 보입니다.

### 화면·뷰포트
- 외부 참조 비교(XCOMPARE): 다시 불러온 외부 참조의 이전·지금 버전 차이를 참조 자리에 색과 구름형 리비전으로 보입니다. 외부 참조 창 메뉴에서도 시작합니다.
- 뷰포트 최대화(VPMAX·VPMIN): 배치 뷰포트를 화면 가득 키워 고칩니다. 최대화 중에는 Ctrl+R로 다음 뷰포트로 갑니다. 상태 막대에 단추를 두었습니다.
- 뷰포트 동기화(VPSYNC), 뷰포트 축척(VPSCALE)
- 채우기(FILL), 빠른 문자(QTEXT), 끌기 모드(DRAGMODE): 화면·PDF·SVG·플롯이 같은 규칙으로 그립니다.
- 등각투영 제도(ISODRAFT·ISOPLANE): 등각 격자·스냅·직교·추적과 등각원. F5·Ctrl+E로 평면을 바꾸고, 상태 막대 단추로 켭니다.

### 파일 형식
- 치수·해치·다중 지시선의 주석 축척 표현을 이 앱의 기록 대신 AutoCAD 축척 레코드로 DXF·DWG(R2000~R2018)에 저장합니다. 예전 기록이 든 파일도 계속 읽습니다.
- DWG의 문자·속성·블록 참조 축척 레코드를 읽고 씁니다. 표본 레코드 176개를 비트 단위로 왕복해 확인했습니다.

### 이 단계의 한계
- 치수·해치 축척 레코드는 표본에 실물이 없어 기능 명세의 배치를 따랐습니다. 이 앱이 쓴 파일을 AutoCAD로 열어 본 확인은 아직 없습니다.
- 도면층 필터는 표본에 자료가 없어 만들지 않았습니다. .las의 일부 코드 자리는 추측입니다.
- 스크립트는 AutoLISP을 실행하지 않고, 스크립트 안에서 파일 선택 창을 열 수 없어 이번 세션에서 연 파일만 이름으로 찾습니다.
- XCOMPARE는 모형 공간 최상위 참조만 비교하고, 이전 버전은 페이지 메모리에만 남습니다.
- 연관 배열은 표본에 실물이 없어 공개된 AutoCAD DXF 도면으로 형식을 확인했습니다. DWG 안의 AutoCAD 배열은 항목 배치로 짐작해 고칩니다.

## 2026-10-15 (3): 주석·구속·비교와 명령 보강

AutoCAD의 큰 기능 묶음을 여러 갈래로 나눠 개발하고 합쳤습니다. 이 단계의 커밋은 `cce9a5a`부터 `7778d8d`까지입니다.

### 치수·주석
- 연관 치수(DIMASSOC·DIMREASSOCIATE·DIMDISASSOCIATE·DIMREGEN): 형상을 고치면 치수가 따라갑니다.
- 검사 치수(DIMINSPECT·-DIMINSPECT): AutoCAD와 같은 `ACAD_DSTYLE_DIMINSPECT` 기록으로, 레이블·검사율 칸이 있는 원형·각도 프레임을 그립니다.
- 스마트 치수(DIM): 커서 아래 객체에 맞춰 선형·정렬·지름·반지름·각도 치수를 미리 보고 만듭니다. 기준선·계속·세로좌표·정렬·분산·도면층 옵션이 있습니다.
- 옛 지시선(LEADER): 스플라인·직선·화살표 형식과 여러 줄 문자·공차·복사·블록 주석.
- 주석 축척(CANNOSCALE·SCALELISTEDIT·OBJECTSCALE·ANNOALLVISIBLE·ANNOAUTOSCALE·ANNORESET·ANNOUPDATE)
  - 축척 리스트와 상태 막대 주석 항목, 뷰포트마다 다른 주석 축척으로 그린 모형 장면.
  - TEXT·MTEXT·블록 참조·속성은 AutoCAD 축척 표현 레코드로 읽고 씁니다.
  - 문자·치수 스타일과 블록 정의에 "주석" 선택을 넣었고, 주석 문자는 용지 높이로 묻습니다.
- 문자 도구: 한 줄 문자를 여러 줄 문자로 합치기(TXT2MTXT), 기준 문자에 맞춰 줄 세우기(TEXTALIGN), 속성 바로 편집(ATTIPEDIT).
- 원호 정렬 문자(ARCTEXT): 작업장에서 만들고 고치며, 호를 고치면 다시 놓입니다. DXF의 ARCALIGNEDTEXT를 읽습니다.

### 파라메트릭 구속
- 기하 구속 12종(GC*)과 치수 구속 7종(DC*), 자동 구속(AUTOCONSTRAIN), 매개변수 관리자(PARAMETERS), DELCONSTRAINT, CONSTRAINTBAR, DCDISPLAY.
- 이동·회전·신축·그립·특성 편집 뒤 이어진 객체를 다시 풀어 따라오게 하고, 과다 구속·모순은 거절합니다.
- 리본에 파라메트릭 탭을 두었습니다.

### 블록과 참조
- 동적 블록 참조 편집(DYNPROPS·-DYNPROPS·RESETBLOCK·동적 그립): 가시성·뒤집기·선형·XY·회전·조회 매개변수와 이동·신축·축척·회전·뒤집기 동작.
- DWG의 동적 블록 객체 9종을 읽고 쓰며, 앱이 새로 만든 표현 자료(ACDB_BLOCKREPRESENTATION_DATA)도 DWG에 저장합니다.
- 참조 제자리 편집(REFEDIT·REFSET·REFCLOSE·XFADECTL): 작업 세트만 고치고 나머지는 흐리게 보이며, 외부 참조를 두 번 누르면 시작합니다.
- 전자 전송(ETRANSMIT): 도면·외부 참조·이미지·PDF·SHX·플롯 스타일을 zip 하나로 묶고 보고서를 넣습니다.
- 블록 개수 창(COUNT)과 개수 표(COUNTTABLE), 블록으로·원래 좌표에 붙여넣기(PASTEBLOCK·PASTEORIG, Ctrl+Shift+V).
- 자르기: 블록(XCLIP), 이미지(IMAGECLIP), PDF 언더레이(PDFCLIP), 종류에 맞게 나눠 주는 CLIP. 이미지 반전 자르기도 그립니다.

### 도면층·표준·디자인센터
- 도면층 탐색(LAYWALK), 도면층에 복사(COPYTOLAYER), 도면층 변환기(LAYTRANS), 명령행 도면층(-LAYER, 스크립트용).
- CAD 표준(STANDARDS·CHECKSTANDARDS): 표준 파일을 연결해 위반을 찾고 이름 대체·특성 맞춤으로 고칩니다.
- 디자인센터(ADCENTER, Ctrl+2): 열린 도면과 고른 파일의 블록·도면층·스타일·배치를 미리보기와 함께 가져옵니다.

### 그리기·수정
- 나선(HELIX), 스케치(SKETCH), 그라데이션 채우기(GRADIENT, 9종), 경로 배열(ARRAYPATH, 비연관).
- 도면 비교(COMPARE 등 6개 명령과 비교 변수 14개): 공통·이 도면에만·비교 도면에만 있는 객체를 색과 구름형 리비전으로 보이고, 객체 가져오기·스냅샷 내보내기를 합니다. 리본에 공동 작업 탭을 두었습니다.
- PDF 가져오기(PDFIMPORT): 벡터 형상·솔리드 채우기·트루타입 문자를 도면 객체로.
- 그 밖: 데이터 추출(DATAEXTRACTION), 선택 순환, 밝은 화면 테마(COLORTHEME), 배치를 모형으로 내보내기(EXPORTLAYOUT).

### 파일 입출력
- 표를 DWG(R2000~R2018)·DXF 모두 AutoCAD 표 객체로 저장합니다(셀 병합·정렬·셀 서식, 버전별 TABLESTYLE).
- AutoCAD 필드(FIELD·FIELDLIST)를 읽고 쓰고, DWG의 DIMASSOC·문자 주석 축척 자료를 원본 태그로 다룹니다.
- DXF 리더가 객체 본문의 1000번대 코드에서 끊지 않게 고쳤습니다(동적 블록 자료가 잘리던 문제).
- 데이터 내보내기(EXPORT)와 JPEG·BMP를 실제 형식으로 저장(JPGOUT·BMPOUT), 명령행 블록 쓰기(-WBLOCK).

### 개발 환경
- 배포 워크플로의 checkout·setup-node를 v5로 올렸습니다(Node 20 지원 종료).
- 화면 촬영 도구(`scripts/dev/shot.mjs`)가 끝날 때 Chrome 프로필을 지웁니다.
- 시험이 로컬 표본 경로를 직접 쓰지 않고 공용 설정(`CAD_FIXTURES`, `CAD_PYTHON`)을 따르게 했습니다.
- 전체 시험 2441개가 통과한 상태로 배포했습니다.

### 이 단계의 한계
- 구속, 주석 축척의 치수·해치·다중 지시선 표현, 새로 만든 원호 정렬 문자, CAD 표준 연결은 이 앱의 기록으로 저장합니다. AutoCAD에서는 형상이나 일반 블록으로 보입니다.
- AutoCAD 예제 DWG의 동적 블록은 확인하지 못한 객체 종류가 많아 대부분 아직 편집할 수 없습니다.
- 치수 끊기(DIMBREAK)는 AutoCAD의 BREAKDATA 형식을 실물로 확인하지 못해 이 앱의 기록으로 둡니다.

## 2026-10-15 (2): 배치·뷰·명령 확장

- 배치 뷰포트(MVIEW·VPCLIP·VPLAYER·LAYVPI·CHSPACE)와 뷰포트 안 모형 공간(MSPACE·PSPACE), 모형 타일 뷰포트(VPORTS).
- 명명된 뷰(VIEW), 사용자 좌표계(UCS·UCSICON·UCSMAN), 격자·스냅과 제도 설정(DSETTINGS·OSNAP).
- 도면층 도구(LAYLCK·LAYULK·LAYMCUR·LAYMCH·LAYCUR·LAYDEL·LAYMRG), 특성 변경(CHPROP·CHANGE 등), 객체 격리·숨기기.
- 치수 스타일 관리자(DIMSTYLE), 이름 있는 플롯 스타일 표(STB), 플롯 미리보기.
- 수정 명령 15개(PEDIT·SPLINEDIT·ALIGN·BLEND·OVERKILL 등), 블록·그룹·선택·유틸리티 명령 23개.
- 표·필드·여러 줄(TABLE·FIELD·MLINE 등), 치수·지시선 편집 16개(DIMBREAK·QDIM·QLEADER·TOLERANCE 등).
- 자동 저장과 도면 복구, 하이퍼링크, 해치 편집, 필드 회색 배경 표시.

## 2026-10-15 (1): 저장 형식과 참조

- DWG 쓰기(R2000·R2004·R2010·R2013·R2018)와 DWG로 저장.
- 해치 작성(무늬 66개, 경계 찾기, 연관 해치).
- 래스터 이미지·외부 참조·PDF 언더레이 연결, 중첩 외부 참조와 외부 참조 도면층 재지정.
- 프록시 그림, 플롯 스타일 표(CTB), 뷰포트 선종류 축척(PSLTSCALE), 동적 입력(F12).
- 깊이 확대해도 곡선이 매끈하게 다시 나누기.

## 2026-10-14: 보기·편집·저장의 바탕

- 공통 도면 모델, DXF 리더(ASCII·이진)와 ezdxf 대조 시험, DWG R13~R2018 리더.
- 장면 빌더·문자 엔진·WebGL2 렌더러, AutoCAD형 화면(리본·파일 탭·명령행·상태 막대).
- 편집 세션과 명령 취소·다시 실행, 그리기·수정 명령, 그립 편집, 특성 팔레트·도면층 편집.
- 블록 정의·삽입·속성, 블록 편집기, 문자 스타일·선종류·단위, 다중 지시선.
- 치수 생성기와 치수 작성 명령, 연속·기준선 치수.
- DXF 쓰기(R12~R2018)와 새 도면 서식, 저장(QSAVE·SAVEAS).
- 플롯 대화상자와 여러 배치 PDF, 배치 관리·페이지 설정, SHX 글꼴 불러오기, 다각형·원 뷰포트 자르기.
- GitHub Pages 배포 워크플로.
