# DWG 리더 메모

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
| `objects/table.ts` | ACAD_TABLE 셀(R2010+ 표 내용, R2007까지 옛 셀 구조) |
| `build.ts` | 문서 조립(표 → 도형 → 블록 순서·속성·정점·배치·헤더 이름 풀기) |

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
- R2007+ 표 레코드에는 외부 참조 번호(BS)가 없다.
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
- 익명 블록 이름은 접두("*D")만 저장되고 블록 제어 목록 순번을 붙인다. R2007 이전으로 저장한 동적 블록은
  익명 *U 블록 + AcDbDynamicBlockTrueName 확장 자료이므로 본래 이름으로 되돌린다.

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

## 알려진 빈틈

- AC1012(R13) 표본이 없어 검증하지 못했다.
- ACAD_TABLE: 행·열 크기와 표 스타일은 모든 버전에서 읽는다. 셀 문자는 일부만(R2007까지 옛 구조의 재지정 플래그 0x40000 등
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

## 리드에게 요청·보고

- `src/core/color.ts` `ACI_RGB`: 10~249 명도 단계가 [255, 165, 127, 76, 38]인데 AutoCAD 팔레트는 [255, 204, 153, 127, 76]이다
  (예: RGB 9B42EC → AutoCAD DXF는 193, 지금 표의 `nearestAci`는 181). DWG 리더는 자체 표(`color.ts`)를 쓴다.
- 모델 요청(선택): `LeaderEntity`에 걸이선 길이가 따로 없어 걸이선 점을 정점에 넣었다(AutoCAD DXF와 같은 모양).
- DXF 리더에서 본 차이(참고): ATTRIB·ATTDEF의 `generation`에 AcDbAttribute의 71(속성 종류)이 들어간다.
  MULTILEADER 문맥의 `backgroundFill`(291)·`backgroundColor`(91)가 지시선 쪽 291과 섞인다.
- `scripts/oracle/ezdxf_dump.py`는 처음에 3DFACE의 extrusion에서 멈췄다(지금은 고쳐진 것으로 보임).
