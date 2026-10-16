# SketchUp(.skp) 형식 조사 기록

SketchUp 파일은 공개 명세가 없는 비공개 이진 형식이다. 이 문서는 **인터넷에 공개된 표본 파일의 바이트만 직접 들여다보고** 추론한 내용이다(클린룸).
SketchUp SDK·Ruby API·다른 SKP 읽기 프로그램·플러그인의 코드와, 그런 코드를 옮긴 해설 글은 보지 않았다. 설치된 SketchUp도 실행하지 않았다.
목적은 상호 운용(뷰어에서 열기)을 위한 형식 분석뿐이다.

- 해석기: `src/formats/skp/` (`skpToScene(bytes, { name })` → `Scene3d`)
- 시험: `tests/skp/` — 표본 파일은 넣지 않고, 아래 구조를 손으로 옮긴 작은 바이트로 시험한다(`tests/skp/build.ts`).
- 표본 확인 스크립트·표본은 작업 중 `.runtime/skp/`에만 두었고 끝난 뒤 지웠다.

## 결론 요약

| 판 | 그릇 | 상태 |
| --- | --- | --- |
| SketchUp 2021~2026 (21.x~26.x) | 머리 + `VFF` 블록 + ZIP. 안의 `model.dat`가 꼬리표-길이-값(TLV) | **읽는다**: 면(구멍)·모서리·재질 색·그룹/컴포넌트 변환·태그·단위 |
| SketchUp 3~2020 (3.x~20.x) | 머리 + MFC CArchive 꼴 객체 그래프(길이 표시 없음, 압축 없음) | **아직 못 읽는다**: 구조 일부만 확인. 경고와 빈 장면 |

2021 이후 판은 모든 요소에 길이가 붙어 있어 모르는 꼬리표를 건너뛸 수 있다 → 판이 바뀌어도 잘 깨지지 않는다.
2020 이하 판은 객체마다 길이가 없어서, 나오는 모든 클래스의 배치를 알아야 끝까지 읽을 수 있다 → 작업량·위험이 크다.

## 모은 표본

GitHub 코드 검색(`extension:skp`, `extension:skp lfs`)으로 찾은 Git LFS 포인터를 따라 `media.githubusercontent.com`에서 자료 파일만 받았다.
(코드 검색은 이진 파일을 색인하지 않아, 찾힌 것은 대부분 LFS로 올린 파일이다.) 버전은 파일 머리의 버전 문자열로 갈랐다.
머리만 내려받아(범위 요청) 버전을 확인한 SketchUp 파일은 60개 저장소의 266개이고, 그중 31개를 받아 구조를 분석했고(아래 표), 해석기 확인용으로 10개를 더 받았다.

| 버전 | 크기(B) | 저장소 | 경로 | 저장소 사용권 |
| --- | ---: | --- | --- | --- |
| 3.0.1 | 7,584 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v3.skp` | MIT |
| 4.0.1 | 8,490 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v4.skp` | MIT |
| 5.0.1 | 8,525 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v5.skp` | MIT |
| 6.0.1 | 10,580 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v6.skp` | MIT |
| 7.0.1 | 15,967 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v7.skp` | MIT |
| 8.0.1 | 15,986 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v8.skp` | MIT |
| 8.0.1 | 34,016 | alvinquach/jpl-trek-vr | `Models/World/main-table.skp` | 없음 |
| 13.0.1 | 15,988 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v2013.skp` | MIT |
| 14.0.1 | 16,100 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v2014.skp` | MIT |
| 15.0.1 | 16,100 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v2015.skp` | MIT |
| 15.0.1 | 30,412 | ucsdlib/geiselVR | `Assets/Meshes/Book.skp` | MIT |
| 16.0.1 | 16,100 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube_v2016.skp` | MIT |
| 16.1.1449 | 182,995 | MVSE-Outreach/arduino-hedgehog-bot | `body/v1/bodyV2 rough scott.skp` | 없음 |
| 17.0.1 | 74,942 | fardjad/presentation-game | `Assets/Models/Chair/Chair.skp` | 없음 |
| 17.2.2555 | 16,219 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/cube.skp` | MIT |
| 17.2.2555 | 23,274 | DBHeise/fileid.testfiles | `skp/SketchUp/2017/box1.skp` | MIT |
| 17.2.2555 | 36,651 | alvinquach/jpl-trek-vr | `Assets/Models/World/terrain-control-panel-colliders.skp` | 없음 |
| 18.0.16975 | 121,722 | EFG-Game-Jams/gameoff2022 | `src/game/Assets/Scenes/HubScene/panel_enclosure_base.skp` | MIT |
| 20.0.1 | 92,963 | NullBrainReference/DuneTowers_1 | `Assets/Models/Rock.skp` | 없음 |
| 20.1.228 | 1,780,501 | grocky/3d-printing-models | `headphone-stand/headphone-stand.skp` | 없음 |
| 21.0.0 | 160,443 | juriusuu/WAYSREADY | `Assets/Telephone.skp` | 없음 |
| 21.0.339 | 108,036 | juriusuu/WAYSREADY | `Assets/Folder (2).skp` | 없음 |
| 21.0.339 | 466,702 | juriusuu/WAYSREADY | `Assets/FIRST AID KIT.skp` | 없음 |
| 21.1.331 | 1,381,886 | kamangir/blue-bracket | `brackets/genb-r/genb-r.skp` | CC0-1.0 |
| 22.0.354 | 696,214 | pepeutriainen/IP-submaskpeli | `assets/models/tulostin.skp` | 없음 |
| 23.0.367 | 3,863,866 | avolink/coffeepie | `cloud-providers/scalable-hardware/OPEN_STANDARD_CONTAINER_SERVER_BY_GRUPO_3P1.skp` | 표시 없음 |
| 23.1.0 | 924,333 | juriusuu/WAYSREADY | `Assets/Sprites/DSchool/Water Dispenser.skp` | 없음 |
| 25.0.571 | 8,021,880 | juriusuu/WAYSREADY | `Assets/CLASSROOM CRACK.skp` | 없음 |
| 26.0.429 | 5,229,446 | OpenMANET/enclosures | `GIZOisNT_Antenna/Sketchup/GIZOisNT_v1.skp` | 표시 없음 |
| 26.1.194 | 142,033 | Terryoc2/Kinemind | `Assets/Materials3d/Composicao+3+-+A1.skp` | 없음 |
| 26.1.194 | 1,317,630 | Terryoc2/Kinemind | `Assets/Materials3d/Cadre+_2.skp` | 없음 |

해석기 확인용으로 더 받은 2021 이후 표본 10개(같은 방식으로 받아 읽기만 함, 모두 경고 없이 읽힘):

| 버전 | 저장소 | 경로 | 저장소 사용권 |
| --- | --- | --- | --- |
| 21.0.0 | G-P-x/Cagliari_VR | `Assets/Prefabs/FBX_templates/Lampione.skp` | 없음 |
| 21.0.0 | Terryoc2/Kinemind | `Assets/Materials3d/MESA.skp` | 없음 |
| 21.0.0 | juriusuu/WAYSREADY | `Assets/Radio (1).skp`, `Assets/Scripts/DSchool3/FIRE2.skp`, `Assets/Sprites/DSchool/Air Puri.skp`, `Assets/Sprites/DSchool/Speakersd.skp` | 없음 |
| 21.0.339 | juriusuu/WAYSREADY | `Assets/EASY MAZE/EASY MAZE.skp` | 없음 |
| 21.0.339 | oussama-003/BTS-Departement-3D-Interactif | `sketchup data/BTS BLOC1.skp` | 없음 |
| 21.1.331 | kamangir/blue-bracket | `brackets/genb-c-h84/genb-c-h84.skp`(genb-r와 같은 내용) | CC0-1.0 |
| 22.0.353 | kamangir/blue-bracket | `brackets/gen1-dw-b/gen1-dw-b.skp` | CC0-1.0 |

판별 개수(모두 41개): 3·4·5·6·7·13·14·18·25 각 1, 8·15·16·20·22·23 각 2, 26 3, 17 4, 21 13.

- DBHeise/fileid.testfiles는 같은 정육면체를 판마다 저장한 묶음이라 판별 비교에 특히 쓸모가 있었다.
- 사용권이 없거나 표시되지 않은 저장소의 파일도 있다. 형식 분석(상호 운용) 목적으로 이 컴퓨터에서 읽기만 했고 저장소·시험에는 넣지 않았으며 끝난 뒤 지웠다. 더 엄격히 하려면 앞으로의 확인은 MIT·CC0 저장소(DBHeise, ucsdlib, EFG-Game-Jams, kamangir) 표본으로 한정할 수 있다.
- 버린 표본: Building-acoustics-TU-Eindhoven/acousticDE `examples/cube.skp`(22.0.354) — 저장소에 글자 변환된 채 올라가 0x80 이상 바이트가 `?`로 바뀌어 있었다.
- 찾지 못한 판: 9~12(SketchUp 2013 이전의 8.x 다음은 13), 19.x(5MB 이상만 있어 받지 않음), **24.x(2024)**. 24는 23·25·26과 같은 계열로 보이지만 직접 확인하지 못했다.
- SketchUp/testup-2(제조사의 Ruby API 시험 모음) 안의 `invalid.skp`는 쓰지 않았다.

## 공통 머리(모든 판)

```
FF FE FF 0E  "SketchUp Model"(UTF-16LE, 14자)
FF FE FF nn  "{주.부.빌드}"(UTF-16LE), 예: {8.0.1}, {17.2.2555}, {21.0.339}
```

문자열 꼴: `FF` + `FFFE`(유니코드 표시) + 길이(1바이트, `FF`면 뒤에 u16, 그것도 `FFFF`면 u32) + UTF-16LE 글자. 2020 이하 판 본문의 모든 문자열도 같은 꼴이다.

## SketchUp 2021~2026: VFF + ZIP + TLV

### 머리 뒤 VFF 블록

```
"VFF" u16 길이(=8) | u16 1 | u16 하위 판 | u32 ?
```

하위 판(관찰): 21.0 → 8, 21.1 → 11, 22.0·23.0·23.1 → 13, 25.0·26.0·26.1 → 17. 끝 u32는 검사값처럼 보이지만 ZIP 부분의 CRC-32·Adler-32와 맞지 않았다(모름). 블록 바로 뒤에 ZIP이 시작한다.

### ZIP

- 표준 ZIP. 중앙 목록·지역 머리 위치는 **ZIP 시작 기준**(파일 기준 아님) → 끝 레코드 위치 − 중앙 목록 크기 − 중앙 목록 위치로 앞붙이 길이를 구한다.
- 압축은 DEFLATE(방식 8)만 보였다. 일반 목적 깃발 0 또는 6(데이터 서술자 없음). 이름은 비트 11 없이 UTF-8.
- 항목(관찰): `meta/model_thumbnail.png`, `meta/preview_thumbnail.png`, `meta/meta.dat`, `materials/<재질 이름>/material.xml`(+ 무늬 그림 jpg/png), `styles/<스타일>/style.xml`, `thumbnails/<컴포넌트>.png`, `scene_thumbnails/<장면>.png`, `classifications/*.skc`, `model.dat`.
- 해석기는 동기 함수라 DEFLATE를 직접 푼다(`inflate.ts`, RFC 1951만 보고 작성).

### material.xml

```xml
<mat:material name="[Color_A01]" type="0" colorRed="255" colorGreen="0" colorBlue="0"
  colorizeType="0" trans="1" useTrans="0" hasTexture="0" />
```

- 색은 `colorRed/Green/Blue`(0~255). 무늬 재질도 같은 속성이 있다(무늬 평균색으로 보이며 `avgColor`도 있다).
- 투명: `useTrans="1"`일 때 `trans`가 불투명도로 보인다(유리 0.04~0.52). 그런데 `trans="0" useTrans="1"`인 재질(firstaid의 Material__1~5)이 내장 미리보기에서 불투명하게 보여서, 해석기는 0<trans<1일 때만 알파로 쓴다(**확실하지 않음**).
- 태그 색은 `Layer_<태그 이름>` 재질로 들어 있다.
- `model.dat`의 재질 이름(32CC)은 꾸러미 폴더 이름과 같고, XML의 `name`은 원래 이름이다(예: `<Black>` → 폴더·model.dat는 `_Black_`, `*` → `_`, `<auto>` → `_auto_`). 해석기는 폴더 이름으로 먼저, XML 이름으로도 찾는다 — 표본 11개의 재질 240개가 모두 이어졌다. 화면 이름은 XML의 원래 이름을 쓴다.

### model.dat의 TLV 문법

```
[u16 꼬리표][u32 길이][길이 바이트 내용]   (리틀 엔디언)
```

- 뿌리는 꼬리표 `0x01F4`, 길이 = 파일 길이 − 6(모든 표본에서 일치).
- 내용은 자식 TLV의 나열이거나 값이다. 어느 꼬리표가 묶음인지는 적혀 있지 않다(해석기는 아는 경로로만 내려간다).
- 값 꼴: **번호**는 길이 1~n바이트의 가장 짧은 부호 없는 리틀 엔디언 정수(예: `2D1F` = 7981, `693707` = 472937). 좌표·평면·변환은 f64 배열, 이름은 UTF-8, 깃발은 u8, 개수류는 i32.
- 몇몇 목록(`138E`)은 [바이트 수][정수] 쌍의 나열이다.
- 속성 값 묶음 `38A4`의 자식: `38A7` i32, `38A9` f64, `38AA` bool, `38AD` 문자열(관찰).

### 꼬리표 표

뜻은 표본끼리 견주어 붙였다. ✔ = 해석기가 쓰고 표본으로 확인, ◐ = 추정, ? = 모름.

뿌리(`01F4`) 자식:

| 꼬리표 | 뜻 | |
| --- | --- | --- |
| 020A | `meta/meta.dat` 경로 문자열 | ✔ |
| 0209 | 모형 속성 사전(36B1/36B2/36B3: 사전 이름 36B4, 값 36B5 = 열쇠 36B6·값 38A4) | ◐ |
| 0200 | 설정 61A8/61A9/61AA(이름 61AB: UnitsOptions·PageOptions·SlideshowOptions·NamedOptions·PrintOptions, 값 61AC = 열쇠 61AD·값 38A4) | ✔(LengthUnit) |
| 01FA | 카메라 34BC(눈 34BD, 목표 34BE, 위 34BF = f64×3, 그 밖 34C0~34CD) | ◐ |
| 01FB | 렌더링 설정 733C(7380·7381 포함 70여 개 값) | ◐ |
| 0204 | 그림자·위치 6590(도시 6593, 나라 6594, 경도·위도 6595·6596, 시간대 6597, 북쪽 6598) | ◐ |
| 01FC | 좌표축 4650(4651~4654) | ◐ |
| 01F7 | **재질** 30D4/30D5/32C8(번호 05DC/05DE, 이름 32CC, 32CA, 32CB, 32CD) | ✔ |
| 01F8 | **태그** 3A98 ─ 3A99/3C8C(번호, 이름 3C8D, 3C8E, 태그 재질 3C8F/32C8, 3C90), 3A9A 기본 태그 번호, 3A9B 태그 폴더? | ✔(3C8E·3A9B 뜻 모름) |
| 01FD | 글꼴 4E20/4E21/5014('Tahoma', 크기 …) | ◐ |
| 01FE·01FF | 치수·문자 스타일로 보임(57E4, 5FB4) | ◐ |
| 01F9 | **정의** 1770/1771/157C (2023부터 1771 맨 앞에 0063 = u32가 있음) | ✔ |
| 01F6 | **모형 요소** 1388 | ✔ |
| 0206 | 스타일 6978(6B6C: 이름 6B6F) | ◐ |
| 01F5, 0201, 0203, 0205, 0207, 0208, 020C~020F | ? | ? |

정의(`157C`): 요소 1388(그 07D0의 번호 = **정의 번호**), 157D GUID 16바이트, 157E 이름, 157F 설명, 1580 경로?, 1582 ?, 1583(이름이 '그룹#n'인 것만 1 → 그룹 여부로 보임 ◐), 1581 u32 시각, 1B58 동작, 1585 미리보기 카메라.

요소(`1388`) 자식:

| 꼬리표 | 뜻 | |
| --- | --- | --- |
| 07D0 | 바탕: 05DC/05DE 번호(+ 05DD 속성 사전), 07D1 재질, 07D2 태그, 07D3 깃발 | ✔ |
| 1389 / 09C4 | 정점: 번호, 09C5 = f64×3(인치) | ✔ |
| 138A / 0BB8 | 모서리: 바탕, 0BB9 시작 정점, 0BBA 끝 정점, 0BBB 곡선 번호(있을 때) | ✔ |
| 138B / 0DAC | 면: 바탕(07D1 = 앞 재질), 0DAF 뒤 재질, 0DAD 평면 f64×4(a,b,c,d), 0DAE 고리들 | ✔ |
| 0DAE / 1194 / 1195 / 0FA0 | 고리 → 모서리 쓰임: 0FA1 모서리 번호, 0FA2 뒤집힘(u8) | ✔ |
| 138C / 1964 | 그룹 인스턴스 | ✔ |
| 138D / 1D4C / 1964 | 컴포넌트 인스턴스 | ✔ |
| 1964 | 바탕(07D1 인스턴스 재질, 07D2 태그), 1965 이름, 1966 변환 f64×13, 1967 정의 번호, 1968 GUID | ✔ |
| 1396 / 4A38 | 곡선(번호, 4A39 마디 수?, 4A3A, 4A3B·4A3C 첫·끝 모서리?) | ◐ |
| 1397 / 4C2C | 호(4A38 곡선 + 4C2D f64×16: 중심·법선·축·반지름·각도) | ◐ |
| 1391 / 4269 | 보조선(4268 바탕, 426A f64×8: 점·방향·범위 ±1e30) | ◐ |
| 1398 / 55F0 | 문자 꼬리표(55F1 글, 55F5 점, 55F7 벡터, 55F4 글꼴 묶음 5208) | ◐ |
| 1399 / 5BCC | 치수(59D8: 글 59D9 '91.00 mm' …) | ◐ |
| 138E | 요소 차례 목록([바이트 수][번호] 나열) | ◐ |
| 139B, 139E, 139F, 13A0 | ? (139F는 2026, 13A0은 26.0부터만 보임) | ? |

### 확인한 규칙과 근거

- **고리 차례**: 모서리 쓰임을 차례로 따라가며 뒤집힘이면 (끝→시작), 아니면 (시작→끝)으로 잇는다. 표본 6개의 고리 130,813개가 모두 빈틈없이 이어졌다.
- **바깥 고리 = 첫 고리**: 고리가 둘 이상인 면에서 평면 법선 기준 넓이가 첫 고리만 양수·최대였다(면적 0인 퇴화 면 4개 제외).
- **변환 1966**(f64×13): 앞 9개는 3×3 **행 우선**(열이 축 벡터), 다음 3개는 이동, 끝 1개는 나눔수(표본 모두 1). 면에 붙인 컴포넌트에서 원점이 부모 면 위에 있을 때, 행 우선으로 읽은 z축만 면 법선과 맞은 경우 19건, 열 우선만 맞은 경우 0건.
- **깃발 07D3**: 보통 0x06. 비트 0x01 = 숨김(genb의 숨긴 인스턴스 22개가 모두 '3D Printer Build Volume' 안의 프린터 모형 — 한 번에 하나만 보이게 둔 것). 모서리의 0x08·0x10은 부드러운/매끈한 모서리로 보이며(곡면에 몰려 있음) 어느 비트가 어느 쪽인지는 모른다 → 해석기는 둘 중 하나라도 있으면 선을 그리지 않는다. 면의 0x40은 모름.
- **좌표 단위**: 내부 좌표는 언제나 인치(0.787402 = 20 mm 같은 값). 표시 단위 `UnitsOptions/LengthUnit`: 0 인치(meta.dat의 "Inches"와 일치), 2 mm(치수 글 '91.00 mm'와 일치), 3 cm, 4 m. 해석기는 2·3이면 mm, 4면 m로 바꾸고 나머지는 인치로 둔다.
- **기본 태그**: `3A9A`는 모든 표본에서 태그 목록의 첫째(Layer0, 한 표본은 'Layer00')와 같았다. 요소에 07D2가 없거나 이 번호면 감싼 인스턴스의 태그를 따른다.
- **재질 물려받기**: 면 앞 재질이 없으면 감싼 인스턴스 재질을 쓴다(telephone 표본의 버튼 색이 이렇게 해야 미리보기와 같다).
- **눈 확인**: firstaid·telephone·tulostin·classroom·gizo를 소프트웨어로 그려 내장 미리보기와 견주었다 — 형상·배치·색이 맞았다.

### 해석기 범위(`src/formats/skp/`)

| 파일 | 하는 일 |
| --- | --- |
| `header.ts` | 머리 문자열·버전·그릇(zip/mfc) 가르기 |
| `inflate.ts` | 동기 DEFLATE 풀기(RFC 1951) |
| `zip.ts` | 앞붙이가 있는 ZIP의 중앙 목록·항목 읽기(저장·DEFLATE, ZIP64 없음) |
| `tlv.ts` | TLV 읽기 도구 |
| `model.ts` | model.dat → 중간 모형(재질·태그·정의·정점·모서리·면·인스턴스·단위) |
| `materials.ts` | material.xml → 색 |
| `scene.ts` | 인스턴스 펼치기(변환 곱), earcut 삼각화, (태그, 재질)별 Mesh3d·태그별 LineSet3d |
| `index.ts` | `skpToScene(bytes, { name })` |

- 숨긴 요소, 부드러운/매끈한 모서리는 그리지 않는다. 자기 자신을 품는 정의는 64겹에서 끊는다.
- 펼친 면 정점이 1,200만 개를 넘으면 면을, 선분이 300만 개를 넘으면 모서리를 그만 그리고 경고한다. v23_server 표본(인스턴스 26,256번 배치)은 펼쳐서 삼각형 573만 개·선분 281만 개로 다 그려진다(약 0.6초).
- 아직 안 읽는 것: 무늬(텍스처 좌표·그림), 태그 숨김(어느 값인지 모름), 장면(페이지), 문자·치수·보조선·단면, 곡선의 원래 모양(모서리로는 그린다), 스타일.

## SketchUp 3~2020: MFC CArchive 꼴

### 확인한 것

- 압축 없음(본문 안의 zlib 흐름은 PNG 그림뿐). 숫자는 f64 리틀 엔디언(정육면체 표본에서 12.0 = `00..28 40`).
- 머리 문자열 뒤: 16바이트(파일마다 달라 GUID로 보임), 빈 문자열(`FF FE FF 00`), u32(유닉스 시각으로 읽으면 표본 저장 시점 근처).
- 이어서 객체 직렬화. 객체 꼬리표는 MFC CArchive의 공개된 꼴과 일치했다(정육면체 v8에서 번호 계산이 맞음):
  - `FFFF` + u16 스키마 + u16 길이 + ASCII 클래스 이름 = 새 클래스(이어서 그 클래스의 객체 내용)
  - `8000 | k` = 이미 나온 클래스 k의 새 객체
  - 그 밖의 u16 = 이미 나온 객체 번호 참조(0 = 없음)
  - 클래스와 객체가 번호 하나를 같이 센다(정육면체 v8: CEdge 클래스 0x11, 모서리 0x12, CVertex 클래스 0x13, 정점 0x14·0x15, 다음 모서리 0x16 …).
- 첫 객체 `CVersionMap`: (클래스 이름 문자열, i32 스키마) 쌍의 나열이 `End-Of-Version-Map`까지. 판마다 각 클래스의 스키마 번호를 알려 준다(아래 표).
- 이어지는 큰 차례(모든 표본 같음): `CDib`(미리보기 PNG: i32 4, i32 길이, PNG) → 모형 설정(이름 있는 값 묶음: 'PageOptions', 'UnitsOptions' …, 값 앞에 형 바이트 04 i32·06 f64·07 bool) → `CAttributeContainer`/`CAttributeNamed`(속성 사전) → `CCamera` → (렌더링·그림자 설정은 클래스 꼬리표 없이 바로 이어 씀) → `CMaterial`들 → `CLayer`들 → `CComponentDefinition`들(각자 요소 목록) → 모형 요소 목록(개수 i32 + 객체들) → `CSkFont` → `CSkpStyle` …
- 형상 객체(정육면체 v8, CEntity 3·CDrawingElement 9):
  - `CVertex`: [u16 0][f64 x][f64 y][f64 z]
  - `CEdge`: [바탕 12바이트][시작 정점 객체 또는 참조][끝 정점][u16]
  - `CFace`: [바탕 12바이트][f64×4 평면][i32 고리 수?][`CLoop` 객체 …]
  - `CLoop`: [u16 0][u8 1][u8 1] 뒤에 `CEdgeUse`가 줄줄이: [u16 0][모서리 참조][u8 뒤집힘][고리 참조]
  - 2017(CEntity 5)부터 요소 바탕에 [u8 1][u32 영구 번호]가 붙는다(정점 0x0B, 0x0C …).
- 형상 클래스의 스키마는 3~20 내내 같았다(CVertex 0, CEdge 2, CEdgeUse 1, CFace 3, CLoop 1). 바뀐 것은 바탕(CEntity 2→3→5, CDrawingElement 8→9), 인스턴스(CComponentInstance 3→6), 모형·설정(CSketchUpModel 10→29, CRenderingOptions 22→39, CViewPage 6→13) 쪽이다.

| 클래스 | 3 | 4 | 5 | 6 | 7 | 8 | 13 | 14 | 15 | 16 | 17 | 18 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CSketchUpModel | 10 | 12 | 12 | 18 | 22 | 22 | 22 | 24 | 24 | 25 | 26 | 28 | 29 |
| CRenderingOptions | 22 | 25 | 28 | 32 | 35 | 36 | 36 | 36 | 36 | 36 | 36 | 37 | 39 |
| CEntity | 2 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 5 | 5 | 5 |
| CDrawingElement | 8 | 8 | 9 | 9 | 9 | 9 | 9 | 9 | 9 | 9 | 9 | 9 | 9 |
| CComponentInstance | 3 | 3 | 4 | 4 | 4 | 4 | 4 | 5 | 5 | 5 | 5 | 6 | 6 |
| CComponentDefinition | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 11 | 11 |
| CArcCurve | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 3 | 3 | 3 | 3 | 3 |
| CLayer / CLayerManager | 1/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 | 3/7 |
| CMaterial | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 12 |
| CViewPage | 6 | 9 | 9 | 11 | 11 | 12 | 12 | 12 | 12 | 12 | 12 | 12 | 13 |

(2020에는 CCustomLineStyle·CLayerGroup·CLineStyleManager가 새로 나온다.)

### 모르는 것

- 바탕 12바이트 각 칸의 뜻(재질·태그 참조 자리), CFace 평면 뒤 i32의 정확한 뜻, CLoop의 두 바이트.
- CSketchUpModel이 클래스 꼬리표 없이 이어 쓰는 설정 부분(렌더링·그림자·단위 …)의 판별 배치 — 형상까지 가려면 이것을 건너뛰어야 한다.
- 재질(CMaterial + CTexture 그림), 컴포넌트 정의·인스턴스, 그룹, 문자·치수·그림·단면·보조선·곡선의 배치.

## 실현 가능성

- **2021~2026: 됨(이번에 구현).** 길이가 붙은 TLV라 모르는 꼬리표는 건너뛰고, 형상 꼬리표는 21.0~26.1 모든 표본에서 같았다. 남은 일(무늬, 태그 숨김, 장면, 문자·치수)은 같은 방식으로 표본을 더 모으면 하나씩 붙일 수 있다(각 0.5~2일).
- **2020 이하: 할 수 있지만 크다.** 길이 표시가 없는 객체 그래프라 나오는 클래스의 배치를 모두 알아야 하고, 하나라도 틀리면 그 뒤를 못 읽는다.
  - 형상 클래스는 판 사이에 바뀌지 않았고, 클래스·객체 번호 규칙과 문자열·값 꼴은 확인했다.
  - 제안하는 길: 형상에 필요한 앞부분(설정 묶음)을 판별로 풀거나, 'CLayer/CMaterial' 클래스 꼬리표를 닻으로 잡고 그 뒤부터 읽으며 새 클래스의 두 번째 꼬리표로 번호 기준을 거꾸로 맞추는 방법.
  - 어림 작업량: 정육면체·작은 모형 수준(모서리·면·재질 색·컴포넌트) 2013~2020을 3~5일, 3~8과 문자·치수·그림·무늬까지 넓히면 1~2주. 낯선 클래스를 만나면 거기서 멈추고 그때까지의 형상만 돌려주는 방식이면 위험을 줄일 수 있다.
  - 위험: 표본이 GitHub 공개 자료에 치우쳐 있다(Unity 자산 등). 판마다 2~3개 이상의 다양한 표본이 더 필요하다.
