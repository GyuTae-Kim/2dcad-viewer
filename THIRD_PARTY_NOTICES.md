# 함께 배포하는 제3자 자료

| 자료 | 위치 | 라이선스 |
|---|---|---|
| Noto Sans KR(굵기 400으로 고정해 유니코드 범위별로 나눔) | `public/fonts/noto-sans-kr/` | SIL Open Font License 1.1 (`public/fonts/noto-sans-kr/OFL.txt`) |
| Liberation Sans·Serif·Mono 2.1.5(라틴 범위로 줄임) | `public/fonts/liberation/` | SIL Open Font License 1.1 (`public/fonts/liberation/LICENSE`). Arial·Times New Roman·Courier New와 글자 폭이 같아 그 글꼴로 쓴 문자의 배치를 맞추는 데 쓴다. |
| Hershey Roman Simplex 글꼴 자료 | `src/text/strokefont-data.ts` | 공개 도메인. The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards. JSON 자료는 [hersheytext](https://github.com/techninja/hersheytextjs)(MIT)에서 가져왔다. |
| opentype.js | npm 의존성 | MIT |
| earcut | npm 의존성 | ISC |
| pdf.js(pdfjs-dist 6.3.289) | npm 의존성. PDF 언더레이를 연결할 때만 받는 별도 묶음 | Apache License 2.0 (`node_modules/pdfjs-dist/LICENSE`) |
| pdf.js가 쓰는 자료: 표준 글꼴(Foxit·Liberation), CMap, 그림 해독 wasm(OpenJPEG·PDFium JBIG2·qcms), ICC | 빌드 결과 `pdfjs/` (pdfjs-dist에서 복사) | 각 폴더의 LICENSE 파일: Foxit 글꼴과 JBIG2는 PDFium BSD 3조항, Liberation은 SIL OFL 1.1, CMap은 Adobe BSD형, OpenJPEG는 BSD 2조항, qcms는 MIT, ICC 프로필은 CC0, pdf.js 쪽 wasm 래퍼는 Apache 2.0 |

DWG 리더는 Open Design Alliance가 공개한 "Open Design Specification for .dwg files"(5.4.1)를 읽고
이 저장소에서 새로 작성했다. 다른 DWG 구현의 소스 코드는 쓰지 않았다.

ezdxf(MIT)는 개발 중 비교 기준(`scripts/oracle/`)으로만 쓰며 앱에는 들어가지 않는다.
