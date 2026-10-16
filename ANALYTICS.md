# 방문 유입과 사용 분석

개인 로그인: `gyutae.k1020@gmail.com` · 계정: `GyuTae Kim · Personal` (`412270261`, 조직 없음).
속성: `Portfolio & OpenCAD` (`559257929`) · 웹 스트림: `16144280939` · 측정 ID: `G-51B8MJ5C4C`.
회사 `wedraw` 계정과 연결하지 않는다.

[개인 속성 관리](https://analytics.google.com/analytics/web/?authuser=0#/a412270261p559257929/admin)

홈페이지와 DWG/DXF·NC·STEP·SKP 웹앱은 GA4 속성 하나와 웹 데이터 스트림 하나를 공유한다.
측정 ID는 공개 설정인 `src/app/analytics-config.ts`에 둔다. 공통 코어 라이브러리에는 태그를 넣지 않는다.
GitHub 저장소 방문은 웹앱 통계와 별개이며 저장소의 Insights → Traffic에서 확인한다.

## 수집 범위

- 배포 호스트 `https://gyutae-kim.github.io`에서만 동작한다. 로컬 개발·미리보기·SSR에서는 Google 태그를 불러오지 않는다.
- 방문자가 허용하기 전에는 Google 태그나 이벤트를 보내지 않는다. 거부·철회할 수 있으며, 같은 출처의 홈페이지와 앱들이 선택을 공유한다.
- DNT 또는 Global Privacy Control이 켜져 있으면 수집하지 않는다. 광고 저장·광고 개인화·Google 신호는 사용하지 않는다.
- 파일명, 파일 내용, 로컬 경로, 열린 파일의 주소, 모형 이름과 오류 원문을 이벤트에 전달하지 않는다.
- 앱의 표시 제목에 파일명이 들어가더라도 GA에는 고정된 앱 제목을 보낸다. URL은 공개 페이지 경로와 허용한 UTM 식별자만 남기며 `open`, `name`, 해시를 제거한다.
- 외부 유입은 참조 도메인까지만 보낸다. 링크의 쿼리·사용자 입력은 수집하지 않는다.

## 이벤트

| 이벤트 | 발생 시점 | 값 |
| --- | --- | --- |
| `page_view` | 공개 페이지 방문·홈페이지 경로 변경 | `tool`, 공개 페이지 정보 |
| `viewer_open` | 홈페이지·앱에서 배포 뷰어 링크를 누름 | `tool`, `target_tool` |
| `source_open` | 소스 저장소 링크를 누름 | `tool`, `target_tool` |
| `file_open_start` | 파일 또는 예제를 읽기 시작함 | `tool`, `input_kind`, `file_format` |
| `file_open_success` | 실제 파일을 해석하고 화면에 표시함 | 위 값과 `duration_ms` |
| `file_open_error` | 실제 파일을 열지 못함 | 위 값과 고정 분류인 `error_code` |
| `sample_open_success` | 예제를 표시함 | `tool`, `input_kind=sample`, `file_format`, `duration_ms` |
| `sample_open_error` | 예제를 열지 못함 | 위 값과 `error_code` |
| `export_complete` | 내보내기 다운로드 시작 또는 직접 파일 저장 완료 | `tool`, `export_format` |

`input_kind`는 `local`, `url`, `sample` 중 하나다. 취소되거나 새 요청으로 대체된 열기는 성공으로 집계하지 않는다.
다운로드 방식의 내보내기는 브라우저에 저장을 요청했다는 뜻이며 디스크 저장 완료를 입증하지 않는다. 직접 파일 저장을 지원하는 경우 쓰기를 마친 뒤 기록한다.
일부 앱이 지원하지 않는 내보내기 형식은 계측 대상이 아니다.

## GA4 설정

1. 개인 홈페이지·OpenCAD용 속성을 정하고 시간대를 서울, 통화를 KRW로 설정한다.
2. 홈페이지 루트 주소의 웹 스트림을 만들고 **향상된 측정을 전부 끈다**. 페이지 조회와 클릭·파일 사용은 앱에서 직접 보낸다. 자동 페이지 제목·검색어·다운로드 수집이 파일 정보를 수집하지 않도록 하는 설정이다.
3. 실제 측정 ID를 각 배포 앱의 `GA4_MEASUREMENT_ID`에 같은 값으로 넣는다. ID가 비어 있으면 태그와 설정 UI 모두 비활성화된다.
4. 이벤트 범위 맞춤 측정기준을 `tool`, `target_tool`, `input_kind`, `file_format`, `error_code`, `export_format`으로 등록한다.
5. `duration_ms`는 이벤트 범위 맞춤 측정항목(밀리초)으로 등록한다. `file_open_success`를 주요 이벤트로 지정한다. 예제 성공은 여기에 포함되지 않는다.
6. 이벤트 데이터 보관은 14개월로 설정했다. 홈페이지 루트의 Search Console 속성 `https://gyutae-kim.github.io/`를 같은 웹 스트림에 연결했다.
7. 최초 배포 후 허용/거부, 페이지 이동, 예제·실제 파일 열기, 내보내기를 확인한다. 실시간과 이벤트 요청에서 파일명·주소가 빠져 있는지 확인한 뒤 분석을 시작한다.

## 분석 방법

- 획득 → 트래픽 획득: 세션 소스/매체별 방문과 `file_open_success` 주요 이벤트를 비교한다.
- 참여 → 방문 페이지: 최초 유입 경로가 홈페이지인지 특정 뷰어인지 비교한다.
- 탐색 → 유입경로 탐색: 홈페이지 조회 → `viewer_open` → 앱 조회 → 실제 파일 열기 성공의 흐름을 본다. 뷰어에 바로 들어온 사용자는 별도로 본다.
- 도구별 사용: `tool`로 나누어 실제 파일 열기, 예제 열기, 실패 분류와 내보내기를 비교한다. 실제 파일 열기 성공률은 `sample`을 제외한 열기 시작 대비 성공 비율이다. 취소는 별도 성공·오류로 기록하지 않으므로 이 비율에는 취소의 영향도 포함된다.
- 외부 게시 링크에는 일관된 `utm_source`, `utm_medium`, `utm_campaign`을 붙인다. 홈페이지와 앱 사이의 내부 이동에는 UTM을 붙이지 않는다.

통계는 동의한 방문자와 관측 가능한 유입만 포함한다. 과거 방문을 소급 복원하거나 특정 이메일 발신자의 발견 경로를 입증하지 않는다.

공식 문서: [GA4 구성](https://developers.google.com/analytics/devguides/collection/ga4/reference/config), [SPA 측정](https://developers.google.com/analytics/devguides/collection/ga4/single-page-applications), [맞춤 정의](https://support.google.com/analytics/answer/10075209), [개인정보 수집 방지](https://support.google.com/analytics/answer/6366371).
