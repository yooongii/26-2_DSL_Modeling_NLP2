# Chrome 웹 스토어 "Privacy practices" 탭 초안

공개 URL(https://dldmsals.github.io/ClearBooking/privacy.html · privacy-en.html)과 함께 아래 내용을
스토어 대시보드 Privacy 탭 각 항목에 옮겨 적으면 됩니다. 실제 코드(manifest.json,
briefing.js, reviewtab.js) 기준으로 작성했으니 기능이 바뀌면 이 문서도 같이 갱신하세요.

## Single purpose (단일 목적 설명)

> 아고다·트립닷컴·부킹닷컴 숙소 예약 페이지에서 세금·수수료를 포함한 실제 결제 총액과 취소 시 예상 손실액을 보여주고, 리뷰에 언급된 숨은 비용을 찾아주며, 무료취소 마감일을 캘린더에 등록할 수 있게 돕는 예약 보조 도구입니다.

## Permission justification (권한별 사용 사유)

| 권한 | 정당화 문구 |
|---|---|
| `activeTab` | 사용자가 아고다·트립닷컴·부킹닷컴 숙소 예약 페이지를 열었을 때 현재 탭의 가격·취소조건·리뷰 텍스트를 읽어 브리핑 카드를 만들기 위해 필요합니다. |
| `storage` | 브리핑 카드 위치 등 사용성 관련 값과 사용자가 직접 저장한 숙소 목록을 사용자의 로컬 브라우저(chrome.storage.local)에만 저장하기 위해 필요합니다. 계정·클라우드 동기화가 없고 개발팀 서버로도 전송하지 않습니다. |
| Host permission `https://*.agoda.com/*`, `https://*.trip.com/*`, `https://*.booking.com/*` | 확장 프로그램의 모든 기능이 아고다(agoda.com)·트립닷컴(trip.com)·부킹닷컴(booking.com) 도메인에서만 동작하도록 범위를 제한하기 위해 필요합니다. 이 세 도메인의 숙소 페이지에서 가격·취소조건을 읽어 카드를 표시하고, 각 사이트 자체의 리뷰 API를 호출해 공개 리뷰를 불러옵니다. 그 외 사이트에서는 아무것도 읽거나 실행하지 않습니다. |

## Data usage disclosure (데이터 사용 공개)

체크리스트는 스토어 대시보드 UI 문구 기준이며, 실제 문구는 버전에 따라 달라질 수 있으니
제출 시 화면에 보이는 문구를 확인하세요.

- **Website content (웹사이트 콘텐츠)** — 예. 페이지의 가격·취소정책·리뷰 텍스트를
  읽습니다. 목적: 앱 핵심 기능(브리핑 카드, 숨은 비용 탐지).
- **Personally identifiable information** — **예**. 별도로 이름·연락처를 요청하진
  않지만, 분류를 위해 자사 서버로 전송하는 문장(리뷰 전문이 아니라 비용 키워드가 든
  문장만 발췌)에 작성자 본인 또는 제3자(숙소 직원 등)의 이름이 포함될 수 있습니다. 처리방식(전송 후 미저장·즉시 폐기, 응답에는
  원문이 포함되지 않음)은 privacy.html에 명시.
- **Financial and payment information** — 아니오.
- **Authentication information (로그인 정보)** — 아니오.
- **Health info / Location / Web history** — 아니오.
- **Personal communications** — 아니오 (챗봇 등 대화형 기능 없음).

체크박스형 서약:
- [x] 이 데이터를 제3자에게 판매하지 않습니다.
- [x] 앱의 핵심 기능과 무관한 목적으로 사용/이전하지 않습니다.
- [x] 신용 평가나 대출 목적으로 사용하지 않습니다.

## 참고 — 서버로 나가는 데이터는 리뷰뿐

`briefing.js`/`reviewtab.js` 기준으로 실제 네트워크 호출은 두 갈래입니다.

1. 예약 사이트 자체 리뷰 API — 아고다(`/api/cronos/property/review/ReviewComments`,
   로그인 쿠키 포함), 트립닷컴(`/restapi/soa2/34308/getHotelCommentInfo`, 쿠키 없음),
   부킹닷컴(GraphQL `ReviewList`, 쿠키 없음). 각 사이트 자체 데이터, 팀 서버로는 안 감.
2. 자사 분류 서버(`/classify`) — 불러온 리뷰에서 비용 키워드가 든 문장만(요청당 최대
   100문장, 언어 코드 ko/en 포함) 숨은 비용 언급 여부를 분류하기 위해 전송. 리뷰 분석 전에
   `/health` 로 서버를 깨우는 상태 확인 요청을 한 번 보내며 데이터는 없음. Google Cloud Run(`https://clear-booking-cost-api-12016686349.asia-northeast3.run.app`,
   기본 내장 주소)에 배포 완료. `manifest.json`의 `host_permissions`에는 별도로 추가하지
   않음 — 서버가 CORS를 열어두고 있어(`Access-Control-Allow-Origin` 응답) 콘텐츠 스크립트
   fetch가 host_permissions 선언 없이도 정상 동작함(팀원이 실제로 검증, CORS preflight
   502 이슈까지 수정 완료 2026-09-16 기준). 콜드스타트(약 20~25초) 대비 30초 타임아웃이 있어 서버
   응답이 그보다 늦으면 규칙 기반 판정으로 조용히 폴백함.

3. 무료취소 마감 캘린더(카드의 "무료취소 마감일 등록" 아래 "Google 캘린더" · "다른 캘린더 (.ics)" 버튼, `briefing.js`
   `buildCalendarEvent`/`googleCalendarUrl`) — **사용자가 버튼을 눌렀을 때만** 동작하고 확장 프로그램이
   직접 보내는 네트워크 요청은 없습니다. `.ics`는 브라우저 안에서 파일로 만들어 저장하기만 하고, "Google
   캘린더"는 `window.open`으로 `calendar.google.com` 새 탭을 여는 것뿐이라 그 순간 일정 내용(숙소명·마감일·체크인·
   예약 금액·예약 페이지 주소)이 주소에 실려 Google로 전달됩니다. 새 권한은 필요 없습니다(manifest 변경 없음).
   privacy.html/privacy-en.html의 1번 표·4번(제3자 제공)에 명시했습니다. 위 체크박스형 서약(판매·무관한 목적
   사용·신용평가 금지)은 그대로 유효합니다. 대시보드 Data usage 문항에서 이 항목을 별도로 표기해야 하는지는
   제출 화면의 문구를 보고 판단하세요.

가격(`pricing.js`)·취소조건(`cancellation.js`) 처리는 네트워크 호출이 없고 브라우저
안에서만 계산합니다 — privacy.html에도 그렇게 명시했습니다.
