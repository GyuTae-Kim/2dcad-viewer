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
| `objects/field.ts`, `objects/rawtags.ts` | FIELD·FIELDLIST, 그리고 DXF 원본 태그로 푸는 객체(DIMASSOC, 문자 주석 축척 자료) |
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
- ACDB_TEXTOBJECTCONTEXTDATA_CLASS: 판(BS 70) 다음 비트 하나가 DXF 290이고 사양의 "확장 사전 파일 있음" 비트는 없다.
  그 뒤 BS 70 수평 정렬, BD 50 회전, RD2 10, RD2 11.
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
- DIMASSOC(사양에 없음, 표본 R14~R2018로 배치를 정함), ACDB_TEXTOBJECTCONTEXTDATA_CLASS(R2010+, 사양 20.4.89·71 + 표본).
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
- AcDb:SummaryInfo는 `$LASTSAVEDBY`만 읽는다(R2004+). 미리보기 그림은 읽지 않는다.
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
ACAD_TABLE·TABLESTYLE·FIELD·FIELDLIST·DIMASSOC·문자 주석 축척 자료는 모델 값(원본 태그)으로 쓰고, 나머지(ACIS, 프록시, 동적 블록 객체, VISUALSTYLE·MATERIAL 등)는
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
- ACIS(REGION·3DSOLID·BODY·SURFACE), 프록시, OLE, 동적 블록·연관 객체는 같은 버전일 때만 남는다. R2013+ 자료 저장소
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
