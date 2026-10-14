# DXF 쓰기 메모

`writeDxf(doc, options)`는 `CadDocument`를 DXF로 쓴다. AutoCAD DXF 참조서와 AutoCAD가 저장한 표본 DXF의
태그 순서를 따른 독자 구현이다(구조 확인에는 MIT인 ezdxf를 참고했다). 문서는 바꾸지 않는다.

```ts
writeDxf(doc, { version?: 'AC1009'|'AC1015'|'AC1018'|'AC1021'|'AC1024'|'AC1027'|'AC1032', binary?: boolean,
                codepage?: string, escapeNonAscii?: boolean }): { data: Uint8Array; warnings: ReadWarning[] }
entityTags(entity, new WriteContext(doc, { version })): RawTag[]   // 객체 하나(딸린 VERTEX·ATTRIB·SEQEND 포함), 부분 저장용
createNewDocument('metric' | 'imperial'): CadDocument               // src/core/newdoc.ts
```

기본값은 R2018(AC1032) ASCII다. R13·R14(AC1012·AC1014)를 달라고 하면 R2000으로, 모르는 버전은 R2018로 쓰고
`version.changed`로 알린다. 경고(`warnings`)는 종류마다 하나로 모으고 `count`와 `detail.items`(최대 20개)를 붙인다.

## 구성

| 파일 | 내용 |
| --- | --- |
| `writer.ts` | 진입점. HEADER·CLASSES 쓰기, 구역 순서, 모델이 해석하지 않은 구역(THUMBNAILIMAGE·ACDSDATA …) |
| `wcontext.ts` | 쓰기 계획: 핸들 정하기, 쓸 표 항목·블록·배치·객체 고르기, 소유자·사전 항목 정리, 필수 항목 만들기 |
| `wconvert.ts` | 버전에 없는 객체 바꾸기(분해·근사·삽입으로) |
| `wentities.ts` | 객체별 태그(`writeEntity`, `entityTags`), 공통 부분, 확장 자료 |
| `wtables.ts` | TABLES(VPORT·LTYPE·LAYER·STYLE·VIEW·UCS·APPID·DIMSTYLE·BLOCK_RECORD) |
| `wobjects.ts` | OBJECTS(사전·배치·플롯 설정·다중선/다중 지시선/표 스타일·축척·이미지 정의·그룹·XRECORD·공간 필터 …) |
| `tagwriter.ts` | 태그 → 바이트(ASCII·이진), 값 표기, 코드 페이지·`\U+XXXX`, 원본 태그 검사 |
| `headervars.ts` | 헤더 변수 표(버전별 순서·그룹 코드)와 acad.dwt·acadiso.dwt 기본값 |
| `classes.ts` | 문서에 클래스 정보가 없을 때 쓰는 표준 클래스 정의 |

## 핸들·소유자

- 문서의 핸들을 그대로 쓴다. 없거나(빈 문자열) 다른 객체와 겹치면 새 핸들을 붙인다(`handle.duplicate`). 표 머리는
  문서 값이나 AutoCAD 관례 핸들(BLOCK_RECORD 1, LAYER 2, STYLE 3, LTYPE 5, VIEW 6, UCS 7, VPORT 8, APPID 9, DIMSTYLE A)을
  쓰되, 관례 핸들을 문서의 다른 객체가 쓰고 있으면 새로 붙인다.
- `$HANDSEED`는 문서 안 모든 핸들(원본 태그·확장 자료의 핸들 포함)과 쓰는 동안 붙인 핸들(VERTEX·SEQEND 등)보다 크다.
- 다른 객체를 가리키는 핸들(330·340·350·360·390 …)은 그 객체를 실제로 쓸 때만 쓴다. 원본 태그(XRECORD·모르는 객체)의
  320~369·390~399·480·481 핸들이 쓰지 않는 객체를 가리키면 `0`으로 쓴다. 확장 자료의 1005는 손대지 않는다.
- 객체(OBJECTS)는 소유자를 따라 쓸지 정한다. 소유자를 쓰지 않으면(뺀 도형의 확장 사전 등) 그 객체도 뺀다
  (`object.orphan_dropped`). 소유자가 문서에 없는 객체는 어떤 사전의 항목일 때만 그 사전을 소유자로 고쳐 쓴다.
- 사전 항목은 쓰는 객체만 남긴다(`dictionary.entry_dropped`). ACAD_LAYOUT 사전은 쓰는 배치로 다시 만든다.
- 그룹 구성원에는 그룹을 반응자(102 {ACAD_REACTORS)로 붙이고, IMAGE마다 IMAGEDEF_REACTOR를 만들어 서로 잇는다.

## 필수 항목(없으면 만든다)

도면층 0, 선종류 ByBlock·ByLayer·Continuous, 문자 스타일 Standard, 치수 스타일 Standard, APPID ACAD, *Active 뷰포트,
*Model_Space·*Paper_Space 블록과 배치(Model·Layout1), 루트 사전과 ACAD_GROUP·ACAD_LAYOUT·ACAD_MLINESTYLE(Standard)·
ACAD_PLOTSETTINGS·ACAD_PLOTSTYLENAME(기본값 Normal 자리 표시), R2007+는 ACAD_MLEADERSTYLE(Standard),
표가 있으면 ACAD_TABLESTYLE(Standard). 객체가 가리키는데 정의가 없는 선종류·문자 스타일·블록은 빈 정의로 만든다
(`table.linetype_missing`, `table.style_missing`, `block.missing`). 이름 없는 치수 그림 블록은 `*Dn` 빈 블록으로 만든다.

## 헤더

- R2000+는 `headervars.ts`의 표 순서대로 그 버전에 있는 변수를 모두 쓴다. 문서 값이 없으면 acad.dwt 기본값을 쓴다.
  표에 없는 문서 변수는 읽을 때 남긴 그룹 코드(`doc.headerCodes`)로 뒤에 붙인다. R12는 R12 변수만 쓴다.
- 늘 쓰는 값: `$ACADVER`(대상 버전), `$ACADMAINTVER`, `$DWGCODEPAGE`(문서 값, 없으면 ANSI_1252), `$HANDSEED`, `$HANDLING` 1.
- `$CLAYER`·`$CELTYPE`·`$TEXTSTYLE`·`$DIMSTYLE`·`$CMLSTYLE`·`$DIMTXSTY`는 쓰는 표에 있는 이름일 때만, 아니면 기본값.
  핸들 변수(320~369·390~399)는 가리키는 객체를 쓸 때만 쓴다.
- `$INSUNITS`가 없는 문서는 0(단위 없음)으로 쓴다. 날짜($TDCREATE …)·GUID가 없으면 지금 시각·새 GUID를 쓴다.
  `$TDUPDATE`는 문서 값을 그대로 쓴다(저장 시각으로 바꾸려면 쓰기 전에 헤더를 고친다).

## 문자열

- R2007(AC1021)+는 UTF-8. 그 전 버전은 기본으로 모든 비ASCII 문자를 `\U+XXXX`로 써서 파일 전체가 ASCII다
  (`$DWGCODEPAGE`는 문서 값 그대로). `options.codepage`를 주면 그 코드 페이지 바이트로 쓰고 없는 문자만 `\U+XXXX`로 쓴다
  (`text.escaped`). 리더는 이름(도면층·블록·스타일)의 `\U+`만 풀고 문자 내용은 그대로 두므로(렌더러가 푼다),
  R2007 이전으로 쓴 파일을 다시 읽으면 문자 내용이 `\U+XXXX` 표기로 돌아온다.
- 제어 문자(0x00~0x1F)는 AutoCAD처럼 캐럿 표기(`^J`, `^I` …)로 쓴다. DWG의 MTEXT 줄바꿈(LF)은 `^J`가 된다.
- MTEXT 본문은 250자 조각(3 … 3, 마지막 1)으로 나눈다. R2007 이전은 비ASCII 문자를 7바이트(`\U+XXXX`)로 세고,
  서로게이트 쌍은 자르지 않는다.

## 객체(ENTITIES·BLOCKS)

모든 버전 공통: 0 종류, 5 핸들, (R2000+) 102 확장 사전·반응자, 330 소유 블록 레코드, 100 AcDbEntity, 67(종이 공간),
8 도면층, 6 선종류(ByLayer 아니면), 62 ACI, (R2004+) 420 트루컬러·430 색 이름·440 투명도, (R2000+) 370 선가중치
(허용 값으로 맞춤, `entity.lineweight_fixed`)·48 선종류 축척·60 숨김·390 플롯 스타일, 그다음 하위 클래스 자료와
확장 자료(등록된 APPID만, 하이퍼링크는 PE_URL로). R12는 하위 클래스 표지·소유자·R2000+ 코드를 쓰지 않는다.

| 객체 | 쓰는 방식 |
| --- | --- |
| LINE·POINT·CIRCLE·ARC·ELLIPSE·XLINE·RAY | 그대로. ELLIPSE 비율이 1보다 크면 축을 바꿔 1 이하로 |
| LWPOLYLINE | 90·70(닫힘·PLINEGEN)·43(일정 폭)·38·정점(10·20·40·41·42) |
| POLYLINE | 2D·3D·폴리곤 메시·폴리페이스 메시 → POLYLINE + VERTEX(필수 플래그 32·64·128·192 붙임) + SEQEND |
| SPLINE·HELIX | 매듭 수가 맞지 않으면 고른 매듭으로 다시 만든다(`spline.knots_fixed`). HELIX는 R2007+ |
| TEXT | 정렬(72·73)이 있으면 11을 늘 쓴다(없으면 삽입점). 73은 두 번째 AcDbText 뒤 |
| ATTRIB·ATTDEF | R2010+ 버전 280, 잠금 280(R2007+), 74 세로 정렬. 여러 줄 속성(R2018)은 101 Embedded Object MTEXT, 그 전 버전은 한 줄 문자로 |
| MTEXT | 250자 조각, 46 정의 높이(R2007+, 값이 있을 때), 배경(R2004+), 단(R2018 101 Embedded Object; 그 전은 `mtext.columns_dropped`) |
| INSERT·MINSERT | 66·ATTRIB들·SEQEND. 행·열이 있으면 AcDbMInsertBlock |
| DIMENSION | 종류별 하위 클래스(회전·정렬·2선 각도·지름·반지름·3점 각도·세로좌표), ARC_DIMENSION(AcDbArcDimension, 70 종류 값은 R2013까지 5·R2018 8), LARGE_RADIAL_DIMENSION. 재지정(`overrides`)은 ACAD DSTYLE 확장 자료로(원래 확장 자료와 같으면 원래 순서 그대로) |
| LEADER | 76 정점 수·10 정점, 340 주석, 210~213 |
| MULTILEADER | CONTEXT_DATA{ … LEADER{ … LEADER_LINE{ … } } } 전체, 문자·블록 내용, 블록 속성(330·177·44·302). 모델에 없는 값은 `props`(읽을 때 남긴 값)나 AutoCAD 기본값 |
| HATCH·MPOLYGON | 폴리선·모서리 경계(선·호·타원·스플라인), 연관 객체(330), 무늬 선, 씨앗 점, 그라데이션(R2004+). 모델의 호·타원 모서리 각도는 반시계로 정규화되어 있으므로 시계 방향(73 = 0) 모서리는 파일 규칙(보각, 시작·끝 바꿈)으로 되돌린다 |
| SOLID·TRACE·3DFACE | 그대로(3DFACE 70 숨긴 모서리) |
| IMAGE·WIPEOUT | IMAGEDEF·IMAGEDEF_REACTOR 연결, 경계가 없으면 이미지 사각형 |
| VIEWPORT | R2000+ 전체 자료, 동결 도면층 이름 → 341 핸들. R12는 ACAD MVIEW 확장 자료 |
| MLINE | 스타일 핸들(없으면 Standard), 정점마다 요소 매개변수 |
| TOLERANCE·SHAPE | 그대로(SHAPE는 이름이 있을 때만; DWG는 번호만 있어 `entity.shape_dropped`) |
| ACAD_TABLE | 블록 참조 부분은 모델에서. 표 자료는 같은 형식 계열(R2004까지 / R2007+)의 원본 태그가 있으면 그대로(342 표 스타일·343 블록 레코드는 다시 정함), 없으면 행·열·크기·셀 문자로 기본 셀을 만든다(`table.synthesized`) |
| MESH | AcDbSubDMesh(R2010+) |
| PDF·DWF·DGN UNDERLAY | 정의 객체가 있고 버전이 지원할 때(PDF R2010+, DWF·DGN R2007+) |
| ACIS(REGION·3DSOLID·BODY·…SURFACE) | 같은 계열(R2010까지 SAT 문자 / R2013+ SAB) 원본 태그가 있으면 그대로. 없으면 와이어가 있으면 3D 폴리선(`entity.acis_as_wires`), 아니면 뺀다(`entity.acis_dropped`). ACIS 자료를 만들지 않으므로 AutoCAD가 읽지 못하는 빈 ACIS 객체는 쓰지 않는다 |
| OLE2FRAME·OLEFRAME | 모델에 OLE 자료가 없어 뺀다(`entity.ole_dropped`) |
| 모르는 객체·프록시 | 원본 태그(+ 프록시 그림 92/160·310)가 있으면 그대로, 없으면 뺀다 |

## 버전 변환(wconvert.ts)

| 대상 | 바꾸는 것 |
| --- | --- |
| R2007 미만 | MULTILEADER → 3D 폴리선(지시선)·선(걸이)·MTEXT·INSERT로 분해(`entity.mleader_exploded`). HELIX → SPLINE |
| R2004 미만 | ACAD_TABLE·ARC_DIMENSION·LARGE_RADIAL_DIMENSION → 그림 블록의 INSERT(블록이 없으면 뺀다). 트루컬러·투명도·그라데이션·MTEXT 배경은 쓰지 않는다 |
| R2010 미만 | MESH → 폴리페이스 POLYLINE(면이 4점보다 많으면 부채꼴 삼각형). PDFUNDERLAY 빠짐 |
| R2018 미만 | MTEXT 단·여러 줄 속성 정보 빠짐(문자는 남김) |
| R12 | LWPOLYLINE → POLYLINE, ELLIPSE·SPLINE → 2D/3D 폴리선 근사, MTEXT → 줄마다 TEXT, LEADER → 3D 폴리선, 위 변환 모두. XLINE·RAY·HATCH·MPOLYGON·TOLERANCE·MLINE·IMAGE·WIPEOUT 등은 뺀다(`r12.unsupported`). 배치는 하나(*Paper_Space)만, 블록 이름 $MODEL_SPACE·$PAPER_SPACE, 선종류 표에 ByBlock·ByLayer 없음, 하위 클래스 표지·소유자·OBJECTS·CLASSES·BLOCK_RECORD 없음, 확장 자료 1071 → 1070/1040 |

바꾼 첫 객체는 원래 핸들을 이어받는다(그룹·정렬 표가 계속 가리키게). `WriteContext.converted`에 문서 객체 → 쓴 객체들을 남긴다.

## 표·객체(OBJECTS)

- DIMSTYLE: 변수 이름 → 그룹 코드(`core/dimvars.ts`), 버전에 없는 코드는 뺀다. 340(DIMTXSTY)·341~344(블록)·345~347(선종류)은
  이름을 핸들로 바꾼다(없으면 그 변수만 빼고 `dimstyle.ref_missing`). R12는 5·6·7 블록 이름.
- LAYER: 꺼짐은 음수 색, 동결·잠금 70, 플롯 290, 선가중치 370, 플롯 스타일 390(없으면 Normal), 투명도·설명은
  모델 값이 바뀌었을 때만 AcCmTransparency·AcAecLayerStandard 확장 자료를 다시 만든다.
- STYLE: 트루타입 글꼴 이름·플래그는 ACAD 확장 자료(1000·1071).
- BLOCK_RECORD: 340 배치, R2007+ 70 단위·280 분해 가능·281 축척 가능.
- 객체: DICTIONARY·ACDBDICTIONARYWDFLT·LAYOUT(+AcDbPlotSettings)·PLOTSETTINGS·MLINESTYLE·MLEADERSTYLE(원본 태그 또는 모델 값)·
  TABLESTYLE(원본 태그, 없으면 Standard를 버전에 맞게 만든다)·SCALE·IMAGEDEF(+REACTOR)·PDF/DWF/DGNDEFINITION·SORTENTSTABLE·
  GROUP·XRECORD(280 복제 플래그 + 자료)·SPATIAL_FILTER·ACDBPLACEHOLDER, 그 밖의 종류는 읽을 때 남긴 원본 태그(`GenericObject.raw`).
  원본 태그가 없는 종류(DWG 리더가 해석하지 않은 VISUALSTYLE·MATERIAL·DICTIONARYVAR 등)는 뺀다(`object.no_data`).
  DWG의 DBCOLOR(색상표 색)는 원본 태그 없이 색(62·420·430)으로 쓴다(R2004+).
- 버전에 없는 객체 종류(MLEADERSTYLE·SCALE·VISUALSTYLE … R2007+, TABLESTYLE R2004+ 등)는 그 버전에서 뺀다.
- 원본 태그에 구조를 깨는 값(0번 코드, 8비트 정수 280~289가 범위 밖 등)이 있는 XRECORD·모르는 객체는 통째로 뺀다
  (`object.corrupt_dropped`). DWG 리더가 일부 XRECORD 자료를 잘못 풀어 이런 값이 생긴다(아래 알려진 문제).

## 모델이 해석하지 않은 구역

THUMBNAILIMAGE·ACDSDATA 등은 리더가 원본 태그(`doc.rawSections`)로 남기고 쓰기가 그대로 쓴다.
ACDSDATA는 원본과 대상이 모두 R2013+일 때만, THUMBNAILIMAGE는 R2000+일 때만 쓴다. R12에는 쓰지 않는다.

## 리더 보강(왕복용)

- 모르는 객체·ACAD_TABLE·ACIS 객체의 AcDbEntity 다음 원본 태그(`raw`, `rawVersion`), 모르는 OBJECTS 객체의 원본 태그.
- 표 머리(TABLE)의 핸들·확장 사전·반응자·확장 자료(`doc.tableHeads`), 헤더 변수의 원래 그룹 코드(`doc.headerCodes`).
- THUMBNAILIMAGE(구역 이름 뒤 태그가 SECTION 레코드 안에 있다)·ACDSDATA·모르는 구역(`doc.rawSections`).
- MULTILEADER의 모델에 없는 값(`props`), IMAGE의 IMAGEDEF_REACTOR(`imageDefReactor`), XRECORD의 280 복제 플래그,
  ATTDEF·ATTRIB 잠금(R2010+의 두 번째 280), 표 셀 문자(171마다, R2007+ 302 / 그 전 2·3 + 1), IMAGE·WIPEOUT의 340 = 0은 없음으로,
  HELIX의 12(축)를 시작 접선으로 읽지 않음.

## 새 도면(src/core/newdoc.ts)

AutoCAD 기본 서식과 같은 뼈대: 도면층 0, 선종류 ByBlock·ByLayer·Continuous, 문자 스타일 Standard(arial.ttf, Arial),
치수 스타일(미터: ISO-25 현재 + Standard, 인치: Standard), 다중선·다중 지시선·표 스타일 Standard, 축척 목록,
플롯 스타일 이름 사전(Normal), Model + Layout1(미터: ISO A3 420 × 297 mm, 인치: ANSI A 11 × 8.5 in, none_device),
*Active 뷰포트, 헤더(acad.dwt 기본값 + 미터 차이값, `$INSUNITS` 4/1, `$MEASUREMENT` 1/0, `$TEXTSIZE` 2.5/0.2 …).
모든 항목에 핸들·소유자가 있고 `$HANDSEED`가 다음 핸들이다(편집 세션의 `newHandle()`이 이어서 쓴다). finalizeDocument를 거친다.

## 검증(tests/dxf/writer*.test.ts)

- `writer.unit.test.ts`(도면 없이): 모든 버전 ASCII·이진, 문서 불변, `\U+`·코드 페이지, 핸들, MTEXT 조각, TEXT 정렬,
  해치 시계 방향 호, 치수 스타일·뷰포트 핸들, DSTYLE, R12, 버전 변환, ACIS·OLE, 잘못된 XRECORD, 원본 구역, entityTags.
- `writer.roundtrip.test.ts`: 모든 DXF 비교 도면 × AC1015…AC1032(+ AC1015·AC1032 이진).
  `summarize(readDxf(writeDxf(doc)))` = 쓰기가 정한 문서(WriteContext가 바꾼 객체)의 요약, 그리고 구조 검사
  (핸들 겹침 없음, 가리키는 핸들이 모두 있음, `$HANDSEED` > 최대 핸들, 구역·블록·표 짝, R2007 이전 ASCII).
- `writer.ezdxf.test.ts`: 모든 DXF 비교 도면 × AC1009…AC1032(+ 이진): ezdxf가 읽고 audit 오류 없음, 고친 항목 없음
  (아래 허용 항목 제외), ezdxf 요약 = 우리 요약.
- `writer.dwg.test.ts`: DWG 비교 도면(samples·all-samples·templates) → AC1032·AC1015·원본 버전: 왕복 요약·구조·ezdxf.
- `writer.newdoc.test.ts`: 새 도면(미터·인치, 빈 도면·표본 객체를 넣은 도면) × AC1009…AC1032: 왕복·구조·ezdxf(고친 항목 없음).

왕복 비교에서 맞추는 의도된 차이(`writer.helpers.ts`): R2004 이전 트루컬러 없음, 정렬된 TEXT의 11, R2007 이전 `\U+`,
`$DWGCODEPAGE`·`$INSUNITS`를 늘 씀, 제어 문자 캐럿 표기. ezdxf 비교에서 맞추는 표기 차이: `\U+`(ezdxf는 문자열만,
우리 리더는 이름만 푼다), ezdxf가 읽을 때 만드는 Defpoints 도면층.

ezdxf가 고치지만 문제가 아닌 것: 사전(DICTIONARY)에 붙은 확장 사전(AutoCAD에서는 올바른 구조)을 ezdxf는 지우고 그 안의
XRECORD를 "소유자 없음"으로 지운다. 원본 DXF를 읽을 때도 똑같이 고친다.

ezdxf 결과는 파일 내용 해시로 `.runtime/dxfw-cache`에 캐시하고, 쓴 파일은 `.runtime/dxfw-test`에 둔다.

## 알려진 한계

- ACIS 자료를 만들지 않는다(다른 계열 버전으로 쓰거나 DWG에서 온 ACIS 객체는 빠진다). OLE 자료가 없다.
- ACAD_TABLE을 다른 형식 계열로 쓰면 셀 서식이 기본값이 된다(그림 블록은 그대로라 보이는 모양은 같다).
- 표 항목의 모델에 없는 값(LAYER 347 재질·348 시각 스타일, VPORT 348, BLOCK_RECORD 310 미리 보기 그림 등)은 쓰지 않는다
  (AutoCAD가 기본값으로 다시 만든다).
- 원본 태그로 쓰는 객체(모르는 객체·XRECORD·TABLESTYLE 등)는 읽은 버전의 태그 그대로다. 버전을 낮춰 쓸 때 그 객체의
  버전별 차이는 고치지 않는다.
- R2007~R2013의 MTEXT 단 정보는 확장 자료로만 오가고(원본 확장 자료가 있으면 그대로), 모델 값(`columns`)은 R2018에만 쓴다.
- DWG에서 읽은 문서: DWG 리더가 해석하지 않은 객체(VISUALSTYLE·MATERIAL·DICTIONARYVAR 등)는 원본 태그가 없어 빠진다.
  DWG 리더가 XRECORD의 8비트 값(280~289)을 16비트로 읽어 자료가 어긋나는 경우가 있고(예: sample_AC1018.dwg의
  AcDb_Thumbnail_Schema), 그런 XRECORD는 빠진다.
- 대상 버전이 R2004 이전일 때 MULTILEADER 분해는 화살촉을 그리지 않는다(지시선·걸이·문자·블록만).
- R12의 곡선 근사는 크기의 1/1000 허용 오차다.
