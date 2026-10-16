# DWG 리더·쓰기 메모

ODA 공개 사양(Open Design Specification for .dwg files 5.4.1)만 보고 만든 독자 구현이다.
사양과 실제 파일이 다른 곳은 표본(AutoCAD가 저장한 예제 도면)으로 확인해 코드 주석에 남겼다.

## 구성

| 파일 | 내용 |
| --- | --- |
| `bitstream.ts` | 비트 단위 읽기(B·BB·3B·BS·BL·BLL·BD·DD·RC·RS·RL·RD·MC·MS·H·T·TU·TV·CMC·ENC·BE·BT·OT) |
| `crc.ts` | CRC8(16비트 표)·CRC32·R2004 페이지 체크섬 |
| `lz77.ts`, `lz77r21.ts` | R2004 압축, R2007 압축 풀기 |
| `container/r2000.ts` | R13~R2000 파일 머리·섹션 위치 |
| `container/r2004.ts` | R2004·R2010·R2013·R2018: 0x6C 헤더 XOR, 페이지 지도, 섹션 지도, 페이지 머리 마스크 |
| `container/r2007.ts` | R2007: Reed–Solomon 블록 풀기(끼워 짠 바이트만 꺼내고 오류 정정은 하지 않음), 페이지·섹션 지도 |
| `header.ts`, `classes.ts`, `handles.ts` | 헤더 변수, 클래스, 객체 지도 |
| `streams.ts` | R2007+ 문자열 흐름 위치 |
| `objects/reader.ts` | 객체 머리·공통 자료·공통 핸들·EED |
| `objects/tables.ts`, `objects/nonentities.ts`, `objects/entities.ts` | 객체별 해석 |
| `objects/table.ts` | ACAD_TABLE 셀(옛 읽기, `tablecodec.ts`로 풀지 못할 때만) |
| `tablecodec.ts` | 표·테이블 스타일 본문 배치(읽기·쓰기가 같은 배치 함수): R2010+ 표 내용·셀 스타일·값, 옛 셀·표 재지정, 두 스타일 배치 |
| `tablemodel.ts` | 표 본문 ↔ 셀 배치(`io/tablecells.ts`), 스타일 본문 ↔ 스타일 값(`io/tablestyle.ts`) |
| `objects/tableraw.ts` | 표·테이블 스타일 → DXF와 같은 원본 태그(`raw`) |
| `objects/field.ts`, `objects/rawtags.ts` | FIELD·FIELDLIST, 그리고 DXF 원본 태그로 푸는 객체(DIMASSOC, 주석 축척 자료, 동적 블록 객체) |
| `dyncodec.ts` | 동적 블록 객체 본문 ↔ DXF 원본 태그(읽기·쓰기, 아래 "동적 블록 객체") |
| `ctxcodec.ts` | 주석 축척 컨텍스트 데이터 14종 본문 ↔ DXF 원본 태그(읽기·쓰기, 아래 "주석 축척 컨텍스트 데이터") |
| `build.ts` | 문서 조립(표 → 도형 → 블록 순서·속성·정점·배치·헤더 이름 풀기) |
| `rawbody.ts` | 모델이 일부만 담는 객체의 원본 본문 보관(`dwgRaw`)과 지문 |
| `writer/*` | DWG 쓰기(아래 "쓰기" 절) |

## 버전별 상태

| 버전 | 표본 | 상태 |
| --- | --- | --- |
| AC1012 (R13) | 없음 | R14와 같은 경로로 읽는다(검증 못 함) |
| AC1014 (R14) | sample_AC1014 | 기준과 일치(알려진 기준 차이 제외) |
| AC1015 (R2000) | sample_AC1015 | 일치 |
| AC1018 (R2004) | sample_AC1018 | 일치 |
| AC1021 (R2007) | sample_AC1021, 예제 5종 | 일치 |
| AC1024 (R2010) | sample_AC1024 | 일치 |
| AC1027 (R2013) | sample_AC1027 | 일치 |
| AC1032 (R2018) | sample_AC1032, 예제·서식 20종 | 일치 |
| AC1009 이전 | — | `dwg.unsupported_version` |

시험:
- `tests/dwg/oracle.test.ts`: 요약 비교(엔진 → DXF → ezdxf). 34개 표본 모두 일치.
- `tests/dwg/deep.test.ts`: 객체 필드 단위 비교(같은 DXF를 DXF 리더로 읽은 것). 34개 모두 일치(제외 필드는 파일 머리말에 근거).
- `tests/dwg/bitstream.test.ts`: 사양 2장의 예(BS·BL·MC·MS·핸들), 압축·CRC.
- `tests/dwg/robust.test.ts`: 빈 파일·다른 형식·AC1009·잘린 파일·바이트 뒤섞기·진행률·도형 수 제한.
- 개발 중에는 AutoCAD가 저장한 `samples-dxf`와도 요약·객체·표·헤더를 맞춰 보았다(`.runtime/dbg/cmp3.ts`, `deep3.ts`, `deep4.ts`).
  기준(엔진)과 AutoCAD DXF가 다를 때는 AutoCAD 쪽을 따랐다.

속도: 1 MB 표본 하나를 처음 읽을 때 30~60 ms, 예열 뒤 11~21 ms(Node 23, M 계열 Mac).

## 사양과 다른 점(표본으로 확인)

- 객체 지도: 구역(최대 2032바이트)마다 핸들·위치 기준을 0으로 되돌린다.
- 헤더 `$MENU`는 R2004 이후에도 있다. R2013+ `REQUIREDVERSIONS`(BLL)의 길이 필드는 3B가 아니라 고정 3비트다.
- 클래스(R2004+): 만든 DWG 버전·유지보수 버전은 BS가 아니라 BL이다.
- R2010+ 객체 크기(MS)는 핸들 흐름 크기(MC) 뒤부터 센다.
- R2007+ 표 레코드에는 외부 참조 번호(BS)가 없다(AutoCAD는 64 비트를 늘 1로 쓴다. 다른 리더는 이 비트가 0이면 번호를 읽는다).
- R13·R14 LAYER의 "켜짐" 비트는 실제로 꺼짐(1 = 꺼짐)이다.
- STYLE: 첫 비트가 쉐이프 파일(70 비트 1), 둘째가 세로 쓰기(비트 4)다.
- ENC 색 0x4000(DBCOLOR 참조)이면 RGB BL이 자료에 없다.
- INSERT·ACAD_TABLE의 소유 객체 수(R2004+)는 속성이 있을 때만 있다.
- MULTILEADER의 화살촉 목록은 R2007까지만 있다. MLEADERSTYLE의 새 형식 필드는 R2010+ 또는 ACAD_MLEADERVER 확장 자료가 있을 때만.
- LEADER: R2010+에는 글 상자 높이·폭이 없다(주석 MTEXT의 실제 범위로 채운다). 걸이선 점은 저장되지 않아
  AutoCAD처럼 마지막 선분이 15°보다 기울면 화살촉 크기만큼 수평선을 덧붙인다.
- R2013+ SPLINE: 맞춤점 방식이면 맞춤 자료가 온다. DXF 70에는 AutoCAD처럼 스플라인 플래그 1을 7비트 올려 더한다.
- R2018 여러 줄 속성: 끼워 넣은 MTEXT의 공통 자료가 entmode부터 오고, 핸들은 문자 스타일 다음에 이어진다.
- R2007 섹션 지도의 이름 길이는 끝 0을 포함한 바이트 수다. R2007 압축의 첫 명령은 소비한 뒤 2바이트를 건너뛴다.
- PDFUNDERLAY 등: 돌출 방향, 삽입점, 회전, 축척 순서(사양에 없음).
- 표 객체의 색(TC)은 모든 버전에서 R2004+ CMC 배치다. R2007+ 값 종류 4(문자열)는 자료 흐름의 BL 바이트 수 + UTF-16LE(끝 0 포함).
- R2007 옛 표 셀에는 문자 TV가 없다(문자는 셀 끝의 값에 있다). 재지정 플래그 0x40000에는 자료가 따르지 않는다.
- R2010+ TABLESTYLE의 셀 스타일 목록은 항목마다 BL 하나(키, ID와 같은 값)가 셀 스타일 앞에 있다. 테두리 모서리 플래그는
  1 위·2 가로 안쪽·4 아래·8 왼쪽·0x10 세로 안쪽·0x20 오른쪽, 셀 스타일 클래스는 1 레이블·2 데이터.
- DIMASSOC(사양에 없음): H 330 치수, BL 90, B 70, RC 71, 점 참조마다 TV 1 클래스, RC 72, BL 경로 수 + H 331…, BS 73, BL 91,
  BL 교차 경로 수 + H 332…, BD 40, 3BD 10, B 75(DXF는 40·10 다음에 332가 온다).
- 주석 축척 컨텍스트 데이터(AcDbObjectContextData): 판(BS 70) 다음 비트 하나가 DXF 290이고 사양의 "확장 사전 파일 있음" 비트는
  없다. 판은 AC1024 이상 4, AC1021 파일 3(표본). 종류별 배치는 아래 "주석 축척 컨텍스트 데이터".
- 동적 블록 객체(사양에 없음): 아래 "동적 블록 객체" 절.
- 익명 블록 이름은 접두("*D")만 저장되고 블록 제어 목록 순번을 붙인다. R2007 이전으로 저장한 동적 블록은
  익명 *U 블록 + AcDbDynamicBlockTrueName 확장 자료이므로 본래 이름으로 되돌린다(이름이 접두 "*U"뿐일 때만.
  "*U17"처럼 번호까지 저장된 이름은 다른 프로그램이 쓴 것으로 보고 그대로 둔다 — 엔진도 그렇게 읽는다).

## 모델 규칙 적용

- 해치 호·타원 경계는 반시계 순서 각도로 바꾼다(시계 방향은 start = 2π − end, end = 2π − start).
- 문자열은 R2007 이전 코드 페이지(`core/codepage.ts`), R2007+ UTF-16. `\U+XXXX`와 MTEXT 서식은 그대로 둔다.
- 2D 폴리선 정점 Z는 폴리선 고도로 채운다. 폴리페이스 면 번호는 끝의 0을 뺀다(DXF와 같게).
- 배치 블록 도형(속성 포함)은 `paperSpace = true`. VIEWPORT `id`는 배치마다 1부터, `status`도 같은 값.
- R13·R14 VIEWPORT 보기 정보는 ACAD "MVIEW" 확장 자료에서 읽는다.
- 트루컬러의 ACI: AutoCAD 팔레트(명도 255·204·153·127·76)로 가장 가까운 색. 색상표 색은 DBCOLOR의 RGB·이름.
  해치 그라데이션 색은 색마다 저장된 ACI(BS)를 쓴다.
- 하이퍼링크(PE_URL), 도면층 설명(AcAecLayerStandard), 도면층 투명도(AcCmTransparency), 문자 스타일 글꼴(ACAD 1000·1071)은 확장 자료에서 꺼낸다.
- R2018 MTEXT 단 높이의 음수 값은 AutoCAD DXF처럼 0으로 둔다. 평면 스플라인은 법선과 70 비트 8을 둔다.
- 비도형 객체의 확장 자료(`xdata`), LAYOUT의 확장 사전·반응자, 표 제어 객체(`tableHeads`: 핸들·확장 사전·반응자·확장 자료)를 담는다.
- MULTILEADER에서 모델에 자리가 없는 값은 DXF 그룹 코드로 `props`(본체·문맥·문맥 텍스트)에 둔다. 도형 재질 핸들은 `material`.
- 원본 본문(`dwgRaw`)은 CRC가 맞는 객체만 남긴다(망가진 파일에서 엉뚱한 크기의 복사를 막는다).

## 객체별 상태

도형: LINE, POINT, CIRCLE, ARC, ELLIPSE, LWPOLYLINE, POLYLINE(2D·3D·메시·폴리페이스, 정점은 `vertices`), SPLINE,
HELIX(SPLINE + `helix`), XLINE, RAY, TEXT, ATTRIB, ATTDEF(R2018 여러 줄 포함), MTEXT(R2018 단 포함), INSERT, MINSERT,
DIMENSION 7종 + ARC_DIMENSION + LARGE_RADIAL_DIMENSION(`overrides` = ACAD DSTYLE), LEADER, MULTILEADER(문맥 자료 전체),
HATCH(다각형·선·호·타원·스플라인 경계, 무늬 선, 그라데이션), SOLID, TRACE, 3DFACE, IMAGE, WIPEOUT, VIEWPORT(동결 도면층),
MLINE, TOLERANCE, SHAPE, ACAD_TABLE(블록·삽입·R2007까지 행·열 크기), OLE2FRAME·OLEFRAME(위치 없음), MESH,
PDF/DWF/DGN UNDERLAY, REGION·3DSOLID·BODY·SURFACE 계열(`AcisEntity`, ACIS 자료는 건너뜀), 프록시·모르는 클래스(`UnknownEntity`, 프록시 그림 바이트).

비도형: 표 제어 객체, LAYER, LTYPE(문자·쉐이프 요소), STYLE, DIMSTYLE(변수 이름·블록/스타일/선종류 이름), VPORT, VIEW, UCS,
APPID, BLOCK_HEADER, VPENT_HEADER, DICTIONARY, ACDBDICTIONARYWDFLT, LAYOUT, PLOTSETTINGS, MLINESTYLE, IMAGEDEF,
PDF/DWF/DGNDEFINITION, SORTENTSTABLE, GROUP, XRECORD(자료 태그), SPATIAL_FILTER, MLEADERSTYLE, SCALE, DBCOLOR, 그 밖은 `GenericObject`.

DXF와 같은 원본 태그(`GenericObject.raw`, ACAD_TABLE은 `TableEntity.raw` + `rawVersion`)로 푸는 객체 — 다른 모듈이 DXF에서 읽은
도면과 같은 길로 쓴다. 표본의 같은 도면 AutoCAD DXF와 태그가 같다(`tests/dwg/rawtags.test.ts`, `tests/dwg/table.test.ts`):
- ACAD_TABLE(모든 버전): AcDbTable 태그(행·열 크기, 셀마다 173 병합 표시·175/176 병합 열·행·재지정 플래그·170·63·64·283·7·140·문자).
  R2010+ 셀 재지정은 내용 형식 → 셀 스타일 → 행 → 열 순으로 고른다(AutoCAD DXF가 셀에 쓰는 값과 같다).
- TABLESTYLE(모든 버전): AcDbTableStyle 태그(R2010+ 셀 스타일 _DATA·_TITLE·_HEADER → 옛 행 스타일 셋).
- FIELD·FIELDLIST(사양 20.4.76·77): `field`(모델 값)도 채운다. 객체의 필드 코드는 `io/fields.ts`의 `fieldCodesOf(doc, entity)`.
- DIMASSOC(사양에 없음, 표본 R14~R2018로 배치를 정함), 주석 축척 컨텍스트 데이터 14종(사양 20.4.89·71·86 + 표본 + 기능 명세, `ctxcodec.ts`).
- 동적 블록 객체 31종(사양에 없음, 표본 R2000~R2018과 공개 짝 도면 R2018로 배치를 정함, `tests/dwg/dynblock.test.ts`): 아래 "동적 블록 객체" 절.
- 주석 축척의 AcDbContextDataManager·ACDB_ANNOTATIONSCALES는 보통 사전(DICTIONARY)이라 원래부터 `entries`로 읽힌다.

## 알려진 빈틈

- AC1012(R13) 표본이 없어 검증하지 못했다.
- ACAD_TABLE: 본문 전체를 푼다(표본 표·스타일 71개가 같은 비트로 다시 써진다). 원본 태그에 담지 못하는 것: 셀 테두리 재지정,
  표 수준 재지정(옛 구조의 93~96), 블록·필드 셀 내용, 사용자 셀 스타일, 한 셀의 여러 내용. 풀지 못한 표는 옛 읽기로 행·열·문자만.
- (옛 기록) 셀 문자는 일부만(R2007까지 옛 구조의 재지정 플래그 0x40000 등
  모르는 비트를 만나면 셀 문자를 버린다). 그림은 익명 *T 블록으로 그린다.
- MPOLYGON은 사양에 없어 `UnknownEntity`로 둔다(프록시 그림이 있으면 그것으로 그린다).
- SHAPE 이름은 SHX 파일이 있어야 알 수 있어 번호(`shapeNumber`)와 스타일 핸들만 담는다.
- OLE2FRAME의 위치(10·11)는 OLE 이진 자료 안에 있어 읽지 않는다.
- R2007 Reed–Solomon 오류 정정은 하지 않는다(손상된 페이지는 경고 후 건너뜀).
- 암호가 걸린 파일(보안 플래그 1, 암호화 섹션)은 `dwg.encrypted`.
- AcDb:SummaryInfo(R2004+)는 모두 읽어 DXF처럼 이름 있는 객체 사전의 `DWGPROPS` XRECORD로 옮기고(내용이 있을 때만, 새 핸들 = `$HANDSEED`),
  `$LASTSAVEDBY`도 둔다. 쓸 때는 그 XRECORD(없으면 머리말의 예전 자리)로 구역을 만든다 — `../dwgprops.ts`. 미리보기 그림은 읽지 않는다.
- `$ACADMAINTVER`는 파일 머리 값이 AutoCAD DXF 값과 맞지 않아 두지 않는다. `$TDUCREATE`·`$TDUUPDATE`는 DWG 헤더에 없다.
- 스플라인의 맞춤점만 있는 경우(맞춤 방식) 조정점을 계산하지 않는다(DXF 리더와 같은 모양으로 맞춤점·접선만 담는다).

## 기준(엔진 → DXF → ezdxf) 쪽 차이 — `tests/dwg/normalize.ts`

기준이 AutoCAD가 저장한 DXF와도 다른 항목만 비교에서 맞춘다: R14 기준 버전 표기, ezdxf가 넣는 기본 항목(Defpoints,
Standard 치수 스타일, R14 화살촉 블록), R2004+ ACIS 도형 누락, MESH를 프록시로 표기, R2013+ SPLINE 플래그,
트루컬러 도면층 ACI(근사 팔레트), 색상표 색의 RGB 누락, `\U+XXXX`·`^J` 표기.
객체 단위 비교(`tests/dwg/deep.test.ts`)는 그 밖에 R2018 MTEXT 단 높이(기준은 DWG의 음수 값, AutoCAD DXF는 0), R2004 MTEXT 배경
(기준이 잃음), LEADER 걸이선·211~213, MULTILEADER 배경·지시선 색, 그라데이션 ACI, SHAPE 이름, PDFUNDERLAY 플래그를 비교하지 않는다.

## 쓰기(`writer/`)

`writeDwg(doc, { version?, onProgress?, raw? }) → { data, warnings }`(`src/io/dwg/index.ts`에서 내보낸다).
쓰는 버전: AC1015(R2000)·AC1018(R2004)·AC1024(R2010)·AC1027(R2013)·AC1032(R2018, 기본). AC1021을 달라고 하면 AC1018,
AC1012·AC1014는 AC1015로 쓰고 `dwg.write_version` 경고를 남긴다(R2007 컨테이너의 Reed–Solomon·R21 압축은 쓰지 않는다).

| 파일 | 내용 |
| --- | --- |
| `bitwriter.ts` | 비트 단위 쓰기(읽기의 짝, 값마다 가장 짧은 형식) |
| `codepage.ts` | R2007 이전 코드 페이지 문자열(TextDecoder로 만든 역표, 없는 글자는 `\U+XXXX`) |
| `lz77enc.ts` | R2004 압축(3바이트 해시 탐욕 방식, 먼 거리 명령은 쓰지 않음) |
| `context.ts` | 쓰기 계획: 핸들 정하기, 필수 항목 만들기, 쓸 객체(live), 원본 본문 사용 여부 |
| `objwriter.ts` | 객체 틀: 종류·핸들·EED·공통 자료·공통 핸들, 크기(MS·RL/UMC)·문자열 흐름·CRC |
| `tables.ts`, `entities.ts`, `objects.ts` | 표 레코드·블록 레코드, 도형, 비도형 객체 |
| `header.ts`, `classes.ts` | AcDb:Header(헤더 변수, 이름 → 핸들), AcDb:Classes |
| `container.ts` | 객체 지도, 보조 헤더, R2000 파일, R2004+ 섹션·페이지(압축, 섹션 지도, 페이지 지도, XOR 머리) |

만드는 것(모델에 없으면): 표 제어 객체(DXF 표 머리 핸들을 이어 씀), 선종류 ByLayer·ByBlock·Continuous, 도면층 0,
도형이 가리키는데 표에 없는 도면층, 문자 스타일 Standard, 치수 스타일(하나도 없을 때), APPID ACAD와 확장 자료의 앱 이름,
*Active 뷰포트, *Model_Space·*Paper_Space 블록과 BLOCK·ENDBLK, 배치(블록마다), 정점·속성 뒤 SEQEND, 루트 사전과
ACAD_GROUP·ACAD_LAYOUT·ACAD_PLOTSETTINGS·ACAD_MLINESTYLE(Standard)·ACAD_PLOTSTYLENAME(Normal 자리 표시자)·
ACAD_MATERIAL·ACAD_COLOR(R2004+)·ACAD_VISUALSTYLE(R2007+), 색상표 색의 DBCOLOR, 클래스 목록(문서 순서를 지킨다).
핸들은 문서 값을 그대로 쓰고 없거나 겹치는 것만 가장 큰 핸들 뒤에서 준다. 쓰지 않는 객체를 가리키는 핸들은 0으로 쓴다.

원본 본문(`dwgRaw`): 읽을 때 CRC가 맞는 객체 중 모델이 일부만 담는 것(모르는 클래스·프록시, ACIS 도형, OLE, ACAD_TABLE,
MULTILEADER, MESH, MLEADERSTYLE, 해석하지 않는 비도형 객체)은 공통 자료 뒤의 자료·문자열·핸들 비트와 프록시 그림을 남긴다.
쓰는 버전이 원본과 같고, 핸들이 같고, 모델 값의 지문이 같으면 공통 자료만 모델에서 다시 쓰고 본문은 그대로 붙인다.
아니면 모델 값으로 쓸 수 있는 것은 쓰고(MULTILEADER·MESH·MLEADERSTYLE·DICTIONARYVAR·DBCOLOR·자리 표시자 등),
ACAD_TABLE·TABLESTYLE·FIELD·FIELDLIST·DIMASSOC·주석 축척 자료 14종(`ctxcodec.ts`)·동적 블록 객체 31종(`dyncodec.ts`)은 모델 값(원본 태그)으로 쓰고,
나머지(ACIS, 프록시, 그 밖의 동적 블록 객체, VISUALSTYLE·MATERIAL 등)는
빼고 경고(`dwg.write_entity_dropped`, `dwg.write_object_dropped`, `dwg.write_table_as_insert`)를 남긴다.
자료가 하나도 없는 객체는 경고 없이 뺀다. TABLECONTENT·TABLEGEOMETRY·CELLSTYLEMAP(DXF·옛 버전의 표 왕복 보조 자료)은
원본 본문이 없으면 조용히 뺀다(표·스타일을 모델 값으로 쓰면 필요 없다).

표 쓰기(`writer/entities.ts` `table`): INSERT 자료(속성 없음) + R2010+ 새 배치(표 내용: 열·행·셀·내용 값·셀 스타일 재지정·병합 범위,
행 셀 스타일 ID 1 제목·2 머리글·3 데이터) 또는 R2000·R2004 옛 배치(셀마다 병합·재지정). 셀 배치는 `io/tablecells.ts`
(앱 표 = OPENCAD_TABLE + 표 스타일, AutoCAD 표 = 원본 태그). 행·열이 없는 표만 블록 참조(`dwg.write_table_as_insert`).
테이블 스타일(`writer/objects.ts`): 원본 태그의 값(없으면 Standard 기본값)으로 R2010+는 셀 스타일 넷(Table·_TITLE·_HEADER·_DATA,
AutoCAD 서식과 같은 배치), 그 전은 옛 배치. 표가 있으면 ACAD_TABLESTYLE 사전과 Standard를 만든다.

읽기 정규화를 되돌려 쓰는 것: 지시선 걸이선 점 빼기, 이미지 다각형 경계의 닫는 점 빼기, 폴리페이스 면 번호 4개로 채우기,
해치 호·타원 각도(시계 방향), MTEXT 방향(회전에서), R2010+ 지시선 글 상자 → 주석 MTEXT 범위, 도면층 투명도·문자 스타일 글꼴
→ 확장 자료, R2013+ 스플라인 플래그(7비트 위), 블록 이름은 번호까지 그대로(*D12, *Paper_Space0).
R2007 이전으로 쓸 때 도면 코드 페이지로 못 쓰는 글자가 있으면 더 맞는 코드 페이지(한·일·중·대만·키릴 …)를 고르고
`dwg.write_codepage` 경고를 남긴다. 그래도 못 쓰는 글자는 `\U+XXXX`.

### 표본으로 확인한 쓰기 규칙(사양과 다르거나 사양에 없음)

- R2007+ 도형 공통 자료: 선종류 BB 다음이 재질 BB, 그다음이 플롯 스타일 BB다(사양 표와 순서가 다름. 리더도 고쳤다:
  예전에는 재질 핸들을 플롯 스타일로 읽었다). 재질 핸들은 모델 `material`에 둔다.
- 표 레코드의 64 비트: AutoCAD는 늘 1을 쓴다. R2007+에서 0이면 다른 리더가 외부 참조 번호(BS)를 더 읽는다.
- DIMSTYLE_CONTROL(R2000+)은 항목 수 뒤에 추가 핸들 수(RC)와 그만큼의 핸들이 더 있다.
- LAYOUT의 뷰포트 수(R2004+)는 RL이 아니라 BL이다. PLOTSETTINGS(R2004+)도 플롯 뷰·(R2007+)시각 스타일 핸들이 있다.
- VIEW: AutoCAD처럼 연결된 UCS(세계 좌표계)를 두고 UCS 핸들 둘을 쓴다.
- MLEADERSTYLE(R2013+)은 끝에 비트 하나가 더 있다. MESH는 주름 값 뒤에 개수(BL) 하나가 더 있다.
- 선종류 ByLayer·ByBlock·Continuous는 R2000+ 표기로 쓴다(R14·R12에서 온 대문자 이름). 이름 없는 STYLE은 쉐이프 파일로 쓴다.
- MULTILEADER 선마다의 재지정 값은 기본값(선종류 0, 화살촉 0)으로 쓴다. 문맥 텍스트의 291·292 순서는 배경색 켜짐, 배경 채우기.
- R2013+ SPLINE: 첫 BL은 늘 1이고 맞춤점 방식은 플래그 비트 1(+8), 매듭 매개변수 2(조정점 방식은 15)다.
- EED 문자열(R2007 이전)의 코드 페이지 2바이트는 높은 바이트가 앞이다.
- XRECORD 280~289는 8비트(리더도 고쳤다), 1004는 길이(RC) + 바이트. DXF에서 읽은 점(10·20·30)은 X 코드 하나로 합친다.
- 해치 그라데이션은 색 두 개를 늘 쓴다. 트루컬러의 ACI 칸은 가장 가까운 색, 표 레코드 CMC의 ACI 칸은 0(AutoCAD와 같다).
- R2004+ 파일 머리 0xEC~0x100은 같은 수열의 0xEC번째부터다(XOR에 쓰는 0x6C바이트 뒤가 아님).
- 압축: 먼 거리 명령(0x10~0x1F)은 쓰지 않는다(사양이 거리 기준을 분명히 하지 않고 다른 리더가 다르게 읽었다).
- R2000 파일: 위치 기록 6개(0 헤더, 1 클래스, 2 객체 지도, 3 없음, 4 MEASUREMENT, 5 보조 헤더), 보조 헤더 0x61, 빈 그림,
  객체 영역 앞 RL 0x0DCA. 둘째 파일 머리(사양 26장)는 쓰지 않는다.
- R2004+ 섹션: SummaryInfo·Preview(비압축), RevHistory·AcDbObjects(RL 0x0DCA로 시작)·ObjFreeSpace·Template·Handles·
  Classes·AuxHeader·Header(압축). AppInfo·FileDepList·Security·VBA는 쓰지 않는다. 0만 있는 페이지는 쓰지 않는다.

### 시험

- `tests/dwg/writer.test.ts`: 비트 쓰기↔읽기(모든 버전), LZ77 압축↔풀기, 객체 지도, 버전 대응·진행률, 새 도면(미터·인치)·
  여러 도형 도면 × 5버전, 원본 본문 사용 조건, 표본 DWG 34개 × 5버전, DXF 원본 53개(표본 DXF 7, 생성 11, 엔진 DXF 34, 앱 예제 1) × 5버전.
  요약(`summarizeDocument`) + 객체 단위 비교(`tests/dwg/writer-compare.ts`, 알려진 손실은 머리말에 근거).
- `tests/dwg/writer-oracle.test.ts`: 위 원본을 쓴 파일(표본 DWG × 5, DXF × 3, 새 도면·여러 도형 × 5)을 엔진 `read_dwg`가
  오류·버린 객체 없이 읽고, 엔진 DXF의 ezdxf 요약이 우리 리더의 요약과 같은지(`normalize.ts`). 결과는 쓴 파일 SHA-1로
  `.runtime/dwg-writer/`에 캐시한다.
- 개발 도구(`.runtime/dwgw/`): `objdiff2.ts`(같은 버전 원본↔쓴 파일을 객체마다 EED·공통·본문·문자열·핸들 구역별 비트 비교),
  `native.ts`(원본 본문 없이 모델 값으로만 쓰기, `raw: false`), 필드별 해석기(`mls.ts`, `ml.ts`, `vp.ts`, `ps.ts` 등).
  모델 값으로 쓴 표본 객체 대부분이 AutoCAD 원본과 비트 단위로 같다(다른 것은 모델에 없는 값: 치수 플래그 8, 범위 등).

### 쓰기의 알려진 빈틈

- R2007(AC1021) 컨테이너는 쓰지 않는다(AC1018로 쓴다).
- ACIS(REGION·3DSOLID·BODY·SURFACE), 프록시, OLE, 연관 객체, 아래 31종이 아닌 동적 블록 객체(구속 매개변수·블록 속성 표 등)와
  확인하지 못한 자료가 든 동적 블록 객체(값 목록이 있는 XY·극좌표 매개변수, 점이 묶인 극좌표 신축)는 같은 버전일 때만 남는다.
  동적 블록 정의는 평가 그래프의 노드를 하나라도 쓰지 못하면 그래프와 노드를 함께 빼서 보통 블록이 된다(`dwg.write_object_dropped`). R2013+ 자료 저장소
  (AcDb:AcDsPrototype_1b)는 쓰지 않아 같은 버전으로 되쓴 ACIS 도형도 형상 자료가 빠질 수 있다(`dataStore` 표지는 그대로).
- ACAD_TABLE을 다른 버전으로 쓰면 셀 테두리 재지정·블록/필드 셀·사용자 셀 스타일이 빠진다(병합·정렬·문자 높이·색·채우기는 남는다).
  VISUALSTYLE·MATERIAL은 다른 버전이면 빠진다. FIELD는 R2004+만 쓴다(값 배치는 사양대로이고 AutoCAD 표본이 없어 우리 쓰기와의 왕복으로만 확인).
- 모델에 없는 값은 기본값으로 쓴다: MTEXT 실제 범위, 치수 플래그 8·화살표 뒤집기, LAYOUT 뷰포트 목록, VPORT 격자 표시 등.
- 미리 보기 그림·AppInfo·파일 의존 목록은 쓰지 않는다. BLOCK·ENDBLK 도형의 확장 자료는 모델에 없어 빠진다.
- MPOLYGON은 HATCH로 쓴다. SHAPE 이름만 있는 경우(DXF) 쉐이프 번호를 모른다.

## 리드에게 요청·보고

- `src/core/color.ts` `ACI_RGB`: 10~249 명도 단계가 [255, 165, 127, 76, 38]인데 AutoCAD 팔레트는 [255, 204, 153, 127, 76]이다
  (예: RGB 9B42EC → AutoCAD DXF는 193, 지금 표의 `nearestAci`는 181). DWG 리더는 자체 표(`color.ts`)를 쓴다.
- 모델 요청(선택): `LeaderEntity`에 걸이선 길이가 따로 없어 걸이선 점을 정점에 넣었다(AutoCAD DXF와 같은 모양).
- DXF 리더에서 본 차이(참고): ATTRIB·ATTDEF의 `generation`에 AcDbAttribute의 71(속성 종류)이 들어간다.
  MULTILEADER 문맥의 `backgroundFill`(291)·`backgroundColor`(91)가 지시선 쪽 291과 섞인다.
- `scripts/oracle/ezdxf_dump.py`는 처음에 3DFACE의 extrusion에서 멈췄다(지금은 고쳐진 것으로 보임).

## 동적 블록 객체(`dyncodec.ts`)

사양에 없는 객체라 DIMASSOC처럼 AutoCAD가 같은 도면을 DWG와 DXF로 저장한 짝을 같은 핸들끼리 맞춰 배치를 정했다.
- ACadSharp `sample_AC1015`~`AC1032`(my-dynamic-block, 참조 ABA = *U18): 그래프·가시성·선형·축척·그립·위치 식·지움 막기·표현 자료.
  판마다 16~18개, 6판 모두 DWG에서 푼 태그가 AutoCAD DXF 태그와 같다(R2004 이전 DXF에는 입체 이력 그래프 둘이 없다).
- 공개 짝 도면(R2018, 확인용으로만 내려받아 쓰고 저장소에는 넣지 않았다): ACadSharp `samples/dynamic-blocks`의
  BLOCK{ALIGNMENT,BASEPOINT,FLIP,LINEAR,LOOKUP,POINT,POLAR,ROTATION,VISIBILITY,XY}PARAMETER.dwg·.dxf(극좌표 짝만 핸들이 달라
  그래프 순서로 맞췄다), LukaStuurman/Techbase-autocad-plugin `validation/RT/RT blocks.dwg·.dxf`(독립 기준점 회전 동작 6개).
  DXF만 있는 공개 도면(EZstruct `drawings/template.dxf`, dxf-file-read `architectural_example-imperial.dxf`)으로 신축 동작의 노드 목록
  코드와 구속 매개변수 배치를 보았다.
- 공개 짝 도면 LibreDWG `test/test-data/2018/Dynblocks.dwg·.dxf`(AutoCAD R2018, 동적 블록 6개): 대리 노드
  (ACDB_DYNAMICBLOCKPROXYNODE)의 배치를 정했고, 102개 객체 모두 DWG에서 푼 태그가 DXF 태그와 같다.
- 그다음 위 도면과 AutoCAD 예제 도면 14개(`all-samples`, R2007·R2018, DWG만)의 동적 블록 객체 1,954개 가운데 1,948개가 남는
  비트 없이 읽히고, 다시 쓴 자료·문자열·핸들 비트가 원본과 같다(남은 6개는 아래 "풀지 않는 경우").

버전: 처음 9종은 R2000~R2018 표본이 모두 같은 배치다(블록 요소 판과 문자열 인코딩만 다르다). 나머지 21종은 R2007(예제 도면)과
R2018(예제·공개 도면)만 보았고, R2000·R2004·R2010·R2013도 같은 배치로 쓴다(엔진 블랙박스가 그 파일을 오류 없이 연다).

DWG 자료 형식(공통 자료 다음, 핸들은 핸들 흐름). DXF와 순서가 다른 곳이 많다:
- AcDbEvalExpr: BL −1(DXF에 없음, 늘 −1), BL 98, BL 99, BS 70 값 종류(−9999 = 값 없음, 40 = BD 값, 70 = BS 값), BL 90 노드 번호.
  DXF는 90, 98, 99 다음 값이 있을 때만 1(빈 문자열)·70 값 종류·값(40이면 140, 70이면 70). DXF는 1.797…e+307을 1.797693134862314E+99로 쓴다.
- AcDbBlockElement: TV 300, BL 98, BL 99, BL 1071. 98·99는 형식을 따른다: AutoCAD 2018은 R2004 이전 DWG·DXF에 25/104,
  R2007 이후에 33/329를 쓴다(예제 도면의 R2007 파일은 27/25). 다른 형식 계열로 쓸 때는 그 계열의 AutoCAD 값으로 바꾼다.
- AcDbBlockParameter: B 280, B 281.
- AcDbBlock1PtParameter: 3BD 1010, 연결 목록 둘(BL 개수 + (BL 노드, TV 속성)…), BL 93. DXF는 1010, 93, 170 + (91, 301)…, 171 + (92, 302)….
- AcDbBlock2PtParameter: 3BD 1010, 3BD 1011, 연결 목록 넷(DXF 171+92/301 … 174+95/304), BL 그립 노드 넷(DXF 170 = 4 + 91…),
  BS 177. DXF는 170·91…이 연결 목록보다 앞이다.
- 값 집합: BL 종류(96·97), BD 최소, BD 최대, BD 증분, BS 개수 + BD 값…. 목록의 DXF 코드는 선형·회전(175 + 144…)만 확인했다.
- 매개변수(DWG 순서, [ ]는 DXF에만 있는 빈 문자열):
  - AcDbBlockLinearParameter: TV 305, TV 306, BD 140, [307], 값 집합(96, 141, 142, 143, 175 + 144…).
  - AcDbBlockVisibilityParameter: B 281, TV 301, TV 302, B 91, BL 93 + H 331…(소프트 포인터), BL 92 상태 수, 상태마다 TV 303,
    BL 94 + H 332…, BL 95 + H 333….
  - AcDbBlockFlipParameter: TV 305 레이블, TV 306 설명, TV 307 기준 상태, TV 308 뒤집힌 상태, 3BD 1012, BL 96 + TV 309.
    DXF 순서는 305~308, 1012, 309, 96.
  - AcDbBlockRotationParameter: TV 305, TV 306, 3BD 1011 기준 각도 점, BD 140, [307], 값 집합(96, 141~143, 175 + 144…).
  - AcDbBlockXYParameter: TV 305 Y 레이블, TV 306 X 레이블, TV 307 Y 설명, TV 308 X 설명(예제 도면의 "높이"·"폭"), BD 141, BD 140,
    [309], 값 집합 Y(97, 146, 147, 148, 176), [410], 값 집합 X(96, 142, 143, 144, 175). AutoCAD는 Y를 먼저 쓴다.
  - AcDbBlockPolarParameter: TV 305 거리 레이블, TV 306 거리 설명, TV 307 각도 레이블, TV 308 각도 설명, BD 140, [309],
    값 집합 거리(96, 141~143, 175), [410], 값 집합 각도(97, 145~147, 176).
  - AcDbBlockPointParameter: TV 303, TV 304, 3BD 1011. AcDbBlockLookUpParameter: TV 303, TV 304, BL 94 조회 동작 노드.
  - AcDbBlockBasepointParameter: 3BD 1011, 3BD 1012. AcDbBlockAlignmentParameter: B 280.
- AcDbBlockGrip: BL 91, BL 92, 3BD 1010, B 280, BL 93. 그다음 AcDbBlockLinearGrip·AcDbBlockAlignmentGrip은 3BD(DXF 140·141·142),
  AcDbBlockFlipGrip은 BL 93, 3BD(DXF 순서 140~142, 93), 가시성·회전·XY·극좌표·조회(AcDbBlockLookUpGrip) 그립은 자료가 없다.
- BLOCKGRIPLOCATIONCOMPONENT: AcDbEvalExpr + AcDbBlockGripExpr BL 91, TV 300.
- AcDbBlockAction: 3BD 1010, BL 71 + H 330…(소프트 포인터), BL 70 + BL 91…. DXF 순서는 70·91…, 71·330…, 1010.
- AcDbBlockActionWithBasePt: 3BD 1011, BL 92 + TV 301, BL 93 + TV 302, B 280, 3BD 1012. DXF 순서는 92, 93, 301, 302, 1011, 280, 1012.
  첫 3BD가 1011(독립 기준점의 오프셋)인 것은 RT blocks 짝의 회전 동작 6개로 확인했다(둘째 3BD는 본 표본 모두 0).
- 동작(DWG 순서):
  - AcDbBlockScaleAction: (BL 94, TV 303), (BL 95, TV 304), (BL 96, TV 305), RC(DXF에 없음, 표본은 모두 0 — 0이 아니면 풀지 않는다).
    DXF 순서는 94, 95, 96, 303, 304, 305. AcDbBlockRotationAction: BL 94, TV 303.
  - AcDbBlockMoveAction: (BL 92, TV 301), (BL 93, TV 302), BD 140 배율, BD 141 각도, RC 280 XY 종류.
  - AcDbBlockStretchAction: (BL 92, TV 301), (BL 93, TV 302), BL 72 + RD2 틀 점(DXF 1011·1021)…, BL 73 + (H 331, BL 74 + BL 94…)…,
    BL 75 + (BL 95 노드, BL 76 + BL 94…)…, BD 140, BD 141, RC 280. 노드 목록이 있는 예제 도면 신축 동작 63개로 DWG 배치를,
    architectural_example DXF로 코드를 확인했다.
  - AcDbBlockFlipAction: (BL, TV) ×4 — DXF는 92~95, 그다음 301~304. AcDbBlockArrayAction: 같은 연결 넷 + BD 140 행 간격(Y),
    BD 141 열 간격(X, 선형·극좌표는 매개변수 방향). 뜻은 공개 도면의 AutoCAD 표현 블록으로 확인했다(아래 "배열 표현").
  - ACDB_DYNAMICBLOCKPROXYNODE(구속 기반 정의의 대리 노드): 평가식뿐(BL −1, BL 98, BL 99, BS −9999, BL 90 = 82비트). DXF는 90·98·99.
    클래스 목록 값 1153, 28/2(Dynblocks·testDrawing).
  - AcDbBlockLookupAction: BL 92 행 수, BL 93 열 수, TV 칸(행 우선, DXF 302)…, 열마다 BL 94 노드, BL 95 값 종류, BL 96, B 282,
    TV 305, B 281, TV 304; 끝에 B 280. DXF는 93 다음에 301, 열 기록 앞마다 303(빈 문자열)을 둔다.
  - AcDbBlockPolarStretchAction: (BL, TV) ×6(DXF 92+301 … 97+306, 섞어서), BL 73 + RD2 틀 점(1011·1021)…, BL 72 + (H, BL n + BL…)…,
    BL 74 + H 332…, BL 75 + (BL 76, BL 78 + …)…, BD 141, BD 140, BS 77.
- ACAD_EVALUATION_GRAPH: BL 96, BL 97, BL 노드 수, 노드마다 BL 91, BL 93, BL 95, H 360(하드 소유), BL 92 ×4,
  BL 간선 수, 간선마다 BL 92, BL 93, BL 94, BL 91 ×2, BL 92 ×5. DXF에는 개수가 없다.
- ACDB_BLOCKREPRESENTATION_DATA: BS 70, H 340(하드 포인터, 정의 블록 레코드).
- ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION: BS 70, H(하드 포인터, 블록 레코드). 이 핸들은 DXF에 없다: 표본·예제 90개는 소유 사전
  (블록 레코드의 확장 사전)의 소유자와 같아서 쓸 때 그 값으로 채운다(공개 짝 하나는 0이었다 — 그래도 블록 레코드를 쓴다).
- 클래스 목록 값(만든 버전·유지보수): 대부분 25/55, 위치 식 25/20, 지움 막기 25/61, 표현 자료 25/58(`writer/classes.ts`).
  DXF 서브클래스 표지는 대소문자를 가리지 않고 받는다(DWG에는 표지가 없다).

DWG 리더는 XRECORD 점을 "x,y,z" 태그 하나로 담는다. 동적 블록 모듈의 캐시 해석(`edit/dynblock/reference.ts` `splitRecord`)은
이를 DXF처럼 10·20·30으로 풀어 읽는다(쓰기는 둘 다 받는다).

### 풀지 않는 경우(같은 버전일 때만 원본 비트 보존)

DXF 짝이 없어 DXF 코드를 확인하지 못한 자료가 든 객체는 풀지 않는다(DWG 배치는 위와 같이 확인했다):
- XY·극좌표 매개변수의 값 목록(개수가 0이 아닐 때). 예제 도면의 구조 블록 XY 매개변수 4개가 여기에 걸린다. 선형과 같은 꼴(증분 코드 + 1:
  XY X 145, Y 149, 극좌표 거리 144, 각도 148)로 짐작되지만 쓰지 않는다(DXF 리더 쪽 정의 해석은 이 짐작 코드로 읽는다).
- 극좌표 신축의 BL 72 목록(점이 묶인 객체, 공개 짝 도면의 두 동작)과 BL 78이 0이 아닌 노드 기록.
- 그 밖에 표본에 없던 값 종류의 평가식, 0이 아닌 축척 동작 끝 바이트.
- 구속 매개변수(BLOCK…CONSTRAINTPARAMETER)와 BLOCKPARAMDEPENDENCYBODY는 DXF 실물(architectural_example-imperial의 창 블록)만
  있고 DWG 짝이 없다. 블록 속성 표(BLOCKPROPERTIESTABLE·BLOCKPROPERTIESTABLEGRIP)와 사용자 매개변수(BLOCKUSERPARAMETER)는 DWG 실물
  (avbrakel/AutoCAD-UpdateBlockPropertyTable-Arx `testDrawing.dwg`·`testDrawingA.dwg`, R2010·R2013)만 있고 DXF 짝이 없다.
  같은 버전이면 원본 비트로 남고, 다른 버전이면 그래프를 뺀다.
- 값 목록이 있는 XY·극좌표 매개변수, 점이 묶인 극좌표 신축은 이번에 찾은 공개 도면(아래)에도 DXF 짝이 없었다.

### 배열 표현(평가 규칙, `edit/dynblock/evaluate.ts`)

공개 도면의 AutoCAD 표현 블록(*U)과 같은 규칙(ACadSharp BLOCKXYPARAMETER 짝, LetsBIMtogether/CADbaseDrawingTemplate
`AG-TEMPLATE-v1-0.dwg`의 선형 배열 블록 넷·표현 50여 개, EZstruct 시험 DXF의 극좌표 배열)로 평가하면 표현 블록과 같은 형상이 된다:
- 개수 = floor(|거리| / 간격)(1 이상). XY는 열 = floor(|X 거리| / 141), 행 = floor(|Y 거리| / 140), 사본은 끝점 쪽(거리 부호)으로.
  선형·극좌표는 141 간격으로 첫 점 → 둘째 점 방향.
- 사본은 원본 뒤에 배열 동작 차례로, XY는 행 바깥·열 안쪽 차례. 사본의 ETag 색인은 원본의 색인(표현 블록에 같은 색인이 여럿),
  1005는 제 핸들, 보이지 않음은 원본을 따른다.
- 매개변수 기준점이 움직이면 선택 객체가 같이 움직인다(XY 표본의 원).
- 정의 블록의 XDATA AcDbBlockArrayActionBEDITTag 객체는 블록 편집기의 미리보기 사본으로, 표현 블록에는 들어가지 않는다.
- 참조 캐시에는 배열 동작 레코드가 없다(XY 표본).

## 주석 축척 컨텍스트 데이터(`ctxcodec.ts`)

객체의 확장 사전 → `AcDbContextDataManager` → `ACDB_ANNOTATIONSCALES` → `*A1`… 사전 항목(보통 DICTIONARY라 원래부터 읽힌다)이
가리키는 축척 표현 레코드. 공통: BS 70 클래스 판, B 290 기본, 핸들 흐름 첫 자리 H 340 SCALE(하드 포인터). DXF는
`100 AcDbObjectContextData`·70·290·`100 AcDbAnnotScaleObjectContextData`·340 다음 종류별 태그.

| 클래스 | DWG(공통 다음) | DXF 태그 | 확인 |
| --- | --- | --- | --- |
| TEXT | BS 70, BD 50(라디안), 2RD 10, 2RD 11 | 70, 50(도), 10·20, 11·21 | 표본 6개(R2010~R2018) 비트·AutoCAD DXF 태그 같음 |
| MTEXTATTRIBUTE | TEXT + B 290 여러 줄. 1이면 포함 객체: BL 반응자 0, (R2004+) B 확장 사전 없음, (R2013+) B 0, H 소유자, (R2000 또는 확장 사전이 있으면) H 확장 사전, MTEXT 레코드(BS 판, B 기본, H 축척, MTEXT 필드) | TEXT + 290, 여러 줄이면 `101 Embedded Object`·70·290·340·MTEXT 필드(표지 없이 — 짐작) | 한 줄: 예제 도면 118개(R2007·R2018)·공개 DXF 252개. 여러 줄: 실물 없음(기능 명세 6.1), 왕복 |
| BLKREF | BD 50, 3BD 10, BD 41·42·43 | 50(도), 10·20·30, 41·42·43 | 예제 도면 52개 비트 같음 |
| MTEXT | BL 70, 3BD 10, 3BD 11, BD 40~43, BL 71(열이면 BL 72, BD 44·45, B 73·74, 동적 열(2)이고 자동 높이가 아니면 열마다 BD 46) | 같은 순서 | 공개 도면 DWG 4개(R2018, 하나는 DXF 짝)의 비트·태그 같음, 공개 DXF 161개 왕복. AutoCAD는 정의 높이가 없는 MTEXT에 71 = 2·72 = 1·73 = 0과 46 하나를 쓴다 |
| ALDIM·ANGDIM·RADIM·DMDIM·ORDDIM·RADIMLRG | 2RD 10 문자 위치, B 294, BD 140, H 2 블록(하드 포인터), B 293·298·291·70·292·71, RC 280, B 295(15비트), B 296·297, 3BD 점(11 / 11·12 / 11·12·13) | `100 AcDbDimensionObjectContextData`, 2 블록 이름, 293, 10·20, 294, 140, 298·291·70·292·71·280·295, 296·297, `100 종류 표지`, 점 | 공개 도면 DWG·DXF 짝 2개(R2013, ALDIM 52·DMDIM 2)의 태그·비트 같음, 공개 DWG(R2018) ALDIM·ANGDIM·DMDIM 4개 비트 같음. 71 = 1·280 = 16 레코드 26개로 71·280의 자리를 정했다(앞 다섯 비트는 실물이 모두 0이라 DXF 순서). RADIM·ORDDIM·RADIMLRG는 실물 없음. 2는 읽은 뒤 build.ts가 블록 이름으로 바꾼다 |
| HATCHSCALE | BL 78, 선마다 BD 53·43·44·45·46, BS 79, BD 49…; BD 40, 3BD 10, BL 90, 루프마다 BL 90·B 290(0이면 풀지 않음 — 실물 없음) | `100 AcDbHatchObjectContextData` + 같은 순서(53은 도) | 공개 도면 DWG(R2018) 3개 비트 같음 |
| HATCHVIEW | HATCHSCALE + H 330 뷰포트(소프트), 3BD 10, BD 51, B 290 | + `100 AcDbHatchViewContextData` | 공개 도면 DWG(R2018) 3개 비트 같음: 관리자 사전의 `ACDB_ANNOTATIONSCALE_VIEW_COLLECTION`(`ACDB_ANNOTATIONSCALES` 앞)에 축척 레코드마다 하나, 축척·기본·패턴 선·루프는 축척 레코드와 같고 40 = 1, 10 = 0 벡터, 330 = 0, 시선 (0, 0, 1), 51 = 0, 290 = 0. 편집은 이 꼴로 다시 만든다(`edit/annoscale/context.ts` `syncHatchViewsOps`) |
| MLEADER | 다중 지시선 컨텍스트 자료(사양 20.4.86): 지시선 루트 → 내용 → 기준 평면 → (R2010+) BS 273·272 | MULTILEADER의 `CONTEXT_DATA{` 안 태그와 같은 순서(내용 → 지시선 → 272·273), 재지정 없는 지시선 선은 91 뒤 특성 없음 | MULTILEADER 본문의 같은 자료로 확인: 표본 R2004~R2018 각 15개가 AutoCAD DXF 태그와 같고 다시 쓴 비트도 같다(R2000은 CMC가 ACI만이라 트루컬러 배경색이 다르다) |
| LEADER | BL 70, 3BD 10…, 3BD 11, B 290, 3BD 12·13 | 같은 순서 | 공개 도면 DWG·DXF 짝 2개(R2010·R2018)와 DWG 2개의 태그·비트 같음(290 = 0, 13이 0이 아닌 것도 있다) |

- 사양과 다른 점: MLeaderAnnotContext의 "문자가 없으면 B 296"은 문자가 있을 때도 B 하나(늘 0)가 있다 — 문자 다음에 B 296을 읽으면
  표본 비트와 맞는다. R2010+ 지시선 선의 재지정 특성은 재지정이 없어도 늘 있다(BS 1, CMC ByBlock, H 0, BL −2, BD 0, H 0, BL 0).
- 클래스 목록 값: 모두 `ObjectDBX Classes`, 프록시 플래그 1153, 만든 버전 27/0(표본의 TEXT·BLKREF·MTEXTATTRIBUTE·ALDIM).
  공개 도면의 ALDIM·ANGDIM·DMDIM·HATCHSCALE·HATCHVIEW·MTEXT 클래스도 `ObjectDBX Classes`·1153.
- 공개 도면에서 본 15번째 종류 `ACDB_FCFOBJECTCONTEXTDATA_CLASS`(공차, DWG 1개·DXF 짝 없음)는 풀지 않는다(원본 비트만).
- 실물 대조 도구(개발 중, 저장소 밖 `.runtime/annoreal/`): 공개 도면 DWG의 레코드를 풀어 같은 도면 DXF의 태그와 맞추고, 다시 쓴
  비트를 원본 본문 비트와 맞춘다(R2010+ 핸들 흐름 끝의 바이트 맞춤 비트는 빼고). 82개 모두 같다.
- 쓰기: R2000부터 쓴다(AutoCAD SAVEFIDELITY 0과 같다). 판은 저장 버전 값. R2018 주석 MTEXT(이 파일에 쓰는 MTEXT 레코드가 있는 것)는
  "주석 아님" 비트 0, 인라인 기록 없음. 주석 치수의 DSTYLE 40은 AutoCAD 값(주석 스타일이면 없음, 아니면 0, `io/annoscale.ts`).
- 코드 페이지 고르기(R2007 이전)에 다중 지시선 문자(객체와 레코드의 304)도 넣는다.
