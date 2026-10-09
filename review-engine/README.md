# 탭 2 · 리뷰 IE

아고다 숙소 페이지에서 **리뷰를 자동으로 모아 분석하고** "화면 밖에서 낼 수 있는 비용"을 보여준다.
사용자는 스크롤도 클릭도 하지 않는다. 패널을 붙이는 순간 시작된다.

```
autoCollect ──▶ runPipeline ──▶ renderInsights
 (조작 없음)     (규칙→NLI→LLM)    (팀원 UI에 mount)
```

---

## 파일 구성

```
review-tab/
├── index.ts        ← 팀원은 이것만 import 하면 된다
│   types.ts · rules.ts · lang.ts · collect.ts
│   analyze.ts · controller.ts · panel.ts        (제품 소스, index 가 물고 들어간다)
├── devpanel.ts     실사이트 테스트용 떠 있는 패널 (제품 코드 아님)
├── run.mjs         명령 실행기
└── test/           parity · collect-test · demo · linkedom (검증용, 제품 그래프 밖)
```

`out/` 은 생성물이라 커밋되지 않는다 — `node run.mjs bundle` / `demo` 로 다시 만든다.

## 어디에 있나

소스는 `review-engine/` 에 있고, **확장(`clearclause/extension`)과는 아직 분리돼 있다.**
프레임워크 의존이 없는 순수 TS라 통합할 때는 둘 중 하나면 된다.

- `lib/review/` 로 복사하고 `@/lib/review` 로 import
- 또는 `tsconfig.json` 의 `paths` 에 이 폴더를 추가

지금 분리해 둔 이유는 팀원 UI 목업이 아직 없어서다. 목업이 나오면 그때 한 번에 옮기는 편이
빌드 설정을 두 번 건드리지 않는다.

## 붙이는 방법

### ① 그리기까지 맡긴다

```ts
import { mountReviewTab } from "review-engine";   // 확장에 넣을 땐 아래 "통합" 참고

const handle = mountReviewTab(document.querySelector("#tab-review")!);
// 탭이 사라질 때
handle.destroy();
```

### ② 데이터만 받고 직접 그린다 — UI 목업을 그대로 쓸 때

```ts
import { createReviewController } from "review-engine";

const ctrl = createReviewController({
  onUpdate: (insights) => myRender(insights),  // 여러 번 불린다
});
```

`onUpdate`는 **수집 단계마다** 불린다. 첫 호출은 보통 수십 ms 안에 오고(이미 DOM에 있는 리뷰),
그 뒤 숫자가 올라간다. `insights.collecting`이 `true`면 아직 모으는 중이다.

주는 데이터는 `ReviewInsights` — 필드는 `types.ts`에 주석과 함께 있다. 화면에 쓸 만한 것:

| 필드 | 뜻 |
|---|---|
| `totalReviews` / `analyzedReviews` | 분모를 정직하게 쓰기 위한 두 숫자 |
| `risks` | 비용 유형별 묶음. `shown`이 노출 기준 통과 여부 |
| `risks[].pageConflict` | 페이지 표기와 어긋나는 경우 그 표기 문자열 |
| `verdictCounts` | mention / ambiguous / negated |
| `stagesRun` | 어떤 층이 돌았는지 |

---

## 화면을 흔들지 않기 위해 지킨 것

이 코드는 **사용자가 보고 있는 페이지 위에서** 돈다. 수집기(`labeling/collect-reviews.js`)와
목적이 다르다 — 그쪽은 개발자가 콘솔에서 돌리는 것이라 스크롤·모달을 마음껏 조작해도 된다.

- `scrollIntoView` / `window.scrollTo` **를 쓰지 않는다.**
- lazy load가 필요하면 **컨테이너 자신의 `scrollTop`** 만 내렸다가 원위치시킨다.
  그런 스크롤 박스가 없으면 아무것도 하지 않는다.
- 카드 안의 "더 보기"는 누른다. 안 누르면 `"…주차비는"` 처럼 **정작 필요한 뒷부분이 잘린 채**
  수집된다.

수집은 3단계로 진행되고 단계마다 결과를 흘려보낸다: `dom` → `expand` → `lazy` → `done`.

---

## 분석 층 — 지금은 규칙, 나중에 모델

`ClaimAnalyzer` 하나를 추가하면 파이프라인에 그대로 꽂힌다.

```ts
createReviewController({
  onUpdate,
  analyzers: [ruleAnalyzer, nliConsistency, llmClaim],
});
```

**규약**: 규칙 층이 후보를 만들고, 뒤 층은 그 후보의 `notes`에 판정을 **덧붙이기만** 한다.
문장을 지우거나 새로 만들지 않는다.

```ts
candidate.notes = [
  { by: "rule-baseline", stage: "rule", verdict: "ambiguous", confidence: 0.35, ... },
  { by: "nli-consistency", stage: "nli", verdict: "mention",  confidence: 0.81, ... },
]
// resolve() 가 최종 하나를 고른다 → decidedBy 에 누가 정했는지 남는다
```

이렇게 한 이유는 두 가지다.

1. 모델을 끼울 때 규칙 코드를 안 건드린다.
2. **같은 문장 위에 층별 판정이 남는다.** "모델이 무엇을 바꿨는지"를 그대로 보여줄 수 있고,
   `ambiguous`를 몇 건 회복했는지가 곧 정량 성과가 된다.

### 다음에 붙일 층

| 층 | 무엇을 푸는가 | 재료 |
|---|---|---|
| `nli-consistency` | "무료 주차라고 써놓고 유료였다" — 페이지 표기 ↔ 리뷰 모순 | `archive/약관/nli_verifier` (6층 RoBERTa 문장쌍 분류기), `input.officialClaims` |
| `llm-claim` | 규칙이 못 가른 `ambiguous` 문장의 의미 판정 | 백엔드 경유 |
| `translate` | 외국어 리뷰를 분석 가능하게 (아래 참고) | `routing.unsupported` |

---

## 외국어 리뷰

실측에서 나온 사실 하나 — **아고다는 표시 언어가 한국어면 리뷰를 자동번역해서 내려준다.**
수집분에 "코스파 좋음", "~라고 생각했습니다" 같은 번역체가 섞여 있던 게 그 증거다.
그래서 실무상 대부분은 한국어로 들어오고, 진짜 외국어로 남는 건 일부다.

남은 외국어는 **분석하지 않고 분모에서 뺀다.** 패널에 "45건 중 31건 분석 · 외국어 14건은 제외"로 쓴다.

영어 키워드 팩을 급조하지 않은 이유: 키워드는 늘릴 수 있어도 판정 단서(`COST_CUE`/`NEG_CUE`)가
한국어라 영어 문장에 안 맞는다. 결과는 정확도 향상이 아니라 **`ambiguous`만 쌓이는 것** —
즉 미측정 구간이 늘어난다. 정직하게 빼두고, `lang.ts`의 `routing.unsupported`가
나중에 번역 층이 들어올 자리다.

번역체는 `looksTranslated()`로 표시만 한다. 판정을 바꾸지 않는다 — 번역체라고 내용이 틀린 건 아니다.

---

## 파이썬과의 일치 (중요)

`rules.ts`는 `labeling/analyze.py`의 포팅이다.
**같은 입력 → 같은 판정**이 나와야 한다. 어긋나면 라벨링해 둔 골드가 무의미해진다.

```bash
node run.mjs parity
```

규칙을 고치면 **양쪽을 같이 고치고** 이걸 돌린다. 파이썬이 없으면 건너뛴다.

---

## 실사이트에서 테스트 (아고다)

확장을 빌드·로드하지 않고 콘솔에 붙여넣어 바로 확인한다.

```bash
node run.mjs bundle      # out/review-panel.console.js 생성
```

1. 아고다 **숙소 상세 페이지**를 연다
2. `F12` → `Console` (경고가 뜨면 `allow pasting` 입력)
3. `out/review-panel.console.js` 전체를 복사해 붙여넣고 Enter

붙여넣는 즉시 패널이 뜨고 수집이 시작된다. 드래그로 옮길 수 있고,
`다시` 로 재수집, `✕` 로 닫는다. 다시 열려면 콘솔에 `openReviewPanel()`.

확인할 것:

| 볼 것 | 실패 신호 |
|---|---|
| 리뷰 건수 | 5건에서 멈춤 = 페이지네이션 실패 |
| 객실 목록 오인 | 본문이 "유연한 예약…" 류 |
| 호텔 답글 혼입 | "Dear ○○, Thank you…" |
| **화면이 튀지 않는가** | 스크롤 위치가 움직임 |

## 눈으로 확인

```bash
node run.mjs demo                       # 내장 샘플
node run.mjs demo ../../review-mining/data/어떤파일.json
```

`out/review-tab.html`이 나온다. 브라우저로 열면 실제 패널이 보인다.
수집 단계는 건너뛰고 **분석 + 렌더링만** 확인한다 — 수집은 실제 사이트에서만 의미가 있다.

---

## 알려진 한계

- **규칙 층은 일부러 약하다.** `ambiguous` 건수가 "모델이 넘어야 할 선"이고 그걸 재는 게 목적이다.
  여기서 억지로 정확도를 올리면 모델의 기여를 측정할 수 없게 된다.
- **노출 기준 2건은 데이터를 많이 요구한다.** 페이지에 리뷰가 10건뿐이면 대부분 기준 미달로 접힌다.
  그건 버그가 아니라 설계다 — 근거 1건으로 비용을 단정하지 않는다.
- `pageConflict`는 지금 **문자열 대조**뿐이다. 진짜 모순 판정은 NLI 층이 붙어야 한다.
