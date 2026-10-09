"""
analyze.py — 수집한 리뷰에서 '현장 추가비용 언급' 빈도를 집계한다.

1단계(빈도 실측)의 산출물을 만드는 스크립트이자, 2단계에서 학습 모델과 비교할
**규칙 베이스라인**이기도 하다. 그래서 판정을 3분류로 낸다:

  mention   — 추가비용이 실제로 발생했다고 말하는 문장
  negated   — 같은 키워드가 나오지만 오히려 "무료였다/없었다"는 문장
  ambiguous — 키워드는 있는데 단서가 부족해 규칙으로는 못 가르는 문장

`ambiguous`를 따로 세는 게 핵심이다. 이 숫자가 곧 "규칙으로는 여기까지가 한계"라는
증거이고, 2단계 분류기가 이겨야 할 지점이다. 라벨링 대상도 여기서 우선 뽑는다.

실행:
    python analyze.py
    python analyze.py --data-dir data --out out

입력:  data/*.json      (collect-reviews.js 결과물)
출력:  out/집계.md       실측-로그.md에 붙여넣을 표
       out/후보.jsonl    2단계 라벨링용 문장 (판정·근거 포함)
"""
import argparse
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict
from urllib.parse import urlparse

HERE = pathlib.Path(__file__).resolve().parent

# ---------- 비용 유형별 키워드 ----------
# '주차'처럼 단독으로도 흔한 말은 비용 문맥과 붙었을 때만 의미가 있어서, 아래
# COST_CUE와 함께 걸리는지를 따로 본다(판정 로직 참고).
FEE_KEYWORDS = {
    # 2026-09-24 확장 — review-engine/rules.ts 와 1:1 로 맞춘다
    "주차": ["주차비", "주차 요금", "주차요금", "주차료", "발렛비", "발렛 요금", "발렛파킹", "발레파킹", "발렛", "발레 파킹", "주차"],
    "리조트피": ["리조트피", "리조트 피", "리조트 요금", "resort fee", "시설 이용료", "시설이용료", "리조트 이용료", "시설 사용료"],
    "보증금": ["보증금", "디파짓", "deposit", "예치금", "보증 금액", "선결제 보증"],
    "도시세": ["도시세", "숙박세", "관광세", "city tax", "숙박 세금", "시티택스", "시티 택스", "환경세", "온천세", "입탕세"],
    "청소비": ["청소비", "청소 요금", "청소료", "클리닝 피", "클리닝피"],
    "조식": ["조식", "아침 식사", "아침식사", "브렉퍼스트", "조식권", "조식 뷔페", "조식뷔페", "아침 뷔페"],
    "인원추가": ["인원 추가", "인원추가", "추가 인원", "추가인원", "1인 추가", "인원당", "엑스트라 베드", "엑스트라베드", "추가 침대", "침대 추가", "간이침대", "성인 추가", "아이 추가", "어린이 추가"],
    "세금수수료": ["세금", "수수료", "부가세", "봉사료", "서비스 차지", "서비스차지", "서비스 요금", "택스", "환전 수수료", "카드 수수료"],
    "기타현장결제": ["현장 결제", "현장결제", "현장에서 결제", "체크인 때 결제", "따로 결제", "추가 금액", "추가금액", "추가 요금", "추가요금", "추가 비용", "추가비용", "별도 요금", "별도요금", "별도 비용", "추가로 결제", "추가 결제", "현장 지불", "현금으로 내", "현금 결제"],
}

# ---------- 판정 단서 ----------
# 추가비용이 '실제로 발생했다'는 쪽 단서
COST_CUE = [
    # '유료'는 NEG_CUE의 '무료'와 짝이 되는 단서인데 빠져 있었다(2026-08-30 발견).
    # 실측 718건에서 가장 흔한 비용 단서가 '유료'(11건)라 이게 없으면 가장 흔한 신호를
    # 통째로 놓친다. '무료'의 부분문자열이 아니라 오탐 위험도 없다.
    "유료",
    "별도", "따로", "추가로", "추가 요금", "추가요금", "더 내", "더 냈", "더 받",
    "받더라", "받았", "받습니다", "받아요", "내야", "냈어요", "냈습니다", "지불",
    "결제해야", "청구", "부과", "요구", "달라고", "붙어요", "붙습니다", "포함 안",
    "포함되지 않", "불포함", "미포함", "제외",
    # 2026-09-24 추가: 실제 리뷰에서 자주 쓰는 표현 (rules.ts 와 동일)
    "내라고", "내야 했", "내야했", "지불해야", "결제했", "결제하", "요금이", "비용이", "금액을", "돈을", "돈 내",
    "청구됐", "청구되", "차감", "공제", "선결제", "현금으로",
]
# 오히려 '무료였다'는 쪽 단서 — 이게 없으면 키워드 매칭이 전부 오탐이 된다
NEG_CUE = [
    "무료", "공짜", "없었", "없어요", "없습니다", "없고", "없는", "안 받", "안받",
    "포함되어", "포함돼", "포함이라", "포함이었", "포함해서", "제공", "서비스로",
    "따로 안", "추가 요금 없", "추가요금 없", "부담 없",
    # 2026-09-24 추가 (rules.ts 와 동일)
    "무상", "포함된", "포함입니다", "포함이에요", "0원",
]

# 공식 표기 → 이 표기와 충돌할 수 있는 비용 유형
CLAIM_TO_FEE = {
    "무료 주차": "주차", "무료주차": "주차", "주차 무료": "주차", "무료 주차 공간": "주차",
    "조식 포함": "조식", "조식 무료": "조식", "아침 식사 포함": "조식",
    "세금 및 수수료 포함": "세금수수료", "세금 포함": "세금수수료",
    "추가 요금 없음": None,  # 유형 무관 — 어떤 추가비용 언급과도 충돌
}

SENT_SPLIT = re.compile(r"(?<=[.!?。])\s+|\n+")
WINDOW = 30  # 키워드 주변 몇 글자까지를 '같은 문맥'으로 볼지 (25→30, 2026-09-24, rules.ts 와 동일)

# 호텔이 쓴 답글 — 리뷰 목록에 섞여 들어온다(아고다 실측 2026-08-29).
# 수집기도 표시(isHotelReply)를 붙이지만, 구버전으로 받은 파일에는 없으므로 여기서도 본다.
HOTEL_REPLY_RE = re.compile(
    r"리뷰를?\s*남겨\s*주셔서\s*감사"
    r"|소중한\s*(?:의견|후기|리뷰)"
    r"|이용해\s*주(?:셔서|시고)\s*(?:진심으로\s*)?감사"
    r"|저희\s*(?:호텔|숙소|리조트)"
    r"|다시\s*뵙기를\s*(?:기대|희망)"
    r"|(?:총지배인|매니저|호텔)\s*드림"
    r"|thank you for (?:your (?:review|stay)|choosing)",
    re.IGNORECASE,
)


def is_hotel_reply(r: dict) -> bool:
    if r.get("isHotelReply"):
        return True
    return bool(HOTEL_REPLY_RE.search(r.get("text") or ""))


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in SENT_SPLIT.split(text or "") if s.strip()]


# '조식·주차·세금'은 그 자체로는 비용이 아니라 **편의시설 이름**이다. 호텔 리뷰에
# 지천으로 깔려 있어서("조식 맛있었어요", "주차 편해요") 그대로 두면 후보의 대부분이 소음이 된다.
# 실측(오키나와+푸켓 리조트 383건, 2026-08-29): 후보 102건 중 90건(88%)이 이 소음이었다.
# 그래서 이 유형들은 **문장에 비용 맥락이 같이 있을 때만** 후보로 친다.
AMENITY_TYPES = {"조식", "주차", "세금수수료"}
COST_CONTEXT_RE = re.compile(
    r"요금|가격|비용|금액|\d+\s*(?:원|엔|바트|달러|만원|천원|위안|유로|링깃|동|페소|USD|THB|JPY|EUR|CNY|KRW|₩|\$)"
    r"|유료|무료|결제|지불|청구|부과|추가|별도|불포함|미포함|포함되지|따로|내야|냈|받더"
)


def find_fee_hits(sentence: str) -> list[tuple[str, str, int]]:
    """문장에서 (비용유형, 매칭된 키워드, 위치)를 찾는다. 긴 키워드 우선."""
    has_cost_context = bool(COST_CONTEXT_RE.search(sentence))
    hits = []
    for fee_type, words in FEE_KEYWORDS.items():
        # 편의시설 이름만 나온 문장은 비용 얘기가 아니다
        if fee_type in AMENITY_TYPES and not has_cost_context:
            continue
        for w in sorted(words, key=len, reverse=True):
            i = sentence.find(w)
            if i >= 0:
                hits.append((fee_type, w, i))
                break  # 유형당 한 번만
    return hits


def cues_near(sentence: str, pos: int, kw_len: int, cues: list[str]) -> list[str]:
    """키워드 주변 창(window) 안에 있는 단서만 센다.
    문장 전체를 보면 '주차는 무료인데 조식은 따로 받아요'에서 둘 다 잡혀 판정이 뒤집힌다."""
    lo = max(0, pos - WINDOW)
    hi = min(len(sentence), pos + kw_len + WINDOW)
    scope = sentence[lo:hi]
    return [c for c in cues if c in scope]


def judge(sentence: str, kw: str, pos: int) -> tuple[str, list[str], list[str]]:
    """규칙 베이스라인 판정. (verdict, 비용단서, 부정단서)"""
    cost = cues_near(sentence, pos, len(kw), COST_CUE)
    neg = cues_near(sentence, pos, len(kw), NEG_CUE)

    if cost and not neg:
        return "mention", cost, neg
    if neg and not cost:
        return "negated", cost, neg
    # 둘 다 있거나 둘 다 없으면 규칙으로는 못 가른다 → 2단계 모델이 이겨야 할 구간
    return "ambiguous", cost, neg


def _listing_key(d: dict) -> tuple[str, str]:
    """같은 숙소인지 판정하는 키.

    아고다는 URL에 숫자 id가 없어 listingId가 'unknown'으로 남는 경우가 있다
    (구버전 수집기로 받은 파일). 그때는 URL 경로로 대신 구분한다."""
    site = d.get("site") or "?"
    lid = (d.get("listingId") or "").strip()
    if lid and lid != "unknown":
        return (site, lid)
    return (site, urlparse(d.get("url") or "").path or "?")


def load_listings(data_dir: pathlib.Path) -> list[dict]:
    """파일을 읽어 **숙소 단위로 병합**한다.

    한 페이지에 리뷰가 5개씩만 보이는 사이트(아고다)에서는 같은 숙소를 여러 번에 나눠
    받게 된다. 파일 하나를 숙소 하나로 세면 '숙소 3곳'처럼 집계돼 지표가 망가진다."""
    files = sorted(data_dir.glob("*.json"))
    merged: dict[tuple[str, str], dict] = {}
    order: list[tuple[str, str]] = []

    for f in files:
        if f.name.lower() == "readme.md":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  ⚠️ {f.name} 읽기 실패: {e}", file=sys.stderr)
            continue
        # 리뷰 파일(collectReviews)과 정책 파일(collectPolicies)은 담고 있는 키가 다르다.
        # 정책만 있는 파일도 반드시 받아야 한다 — 안 그러면 약관 수집분이 통째로 버려진다.
        PAYLOAD = ("reviews", "roomPolicies", "fees", "notices", "policy")
        if not isinstance(d, dict) or not any(k in d for k in PAYLOAD):
            print(f"  ⚠️ {f.name} 건너뜀 — 수집기 결과 형식이 아님", file=sys.stderr)
            continue
        d.setdefault("reviews", [])

        key = _listing_key(d)
        if key not in merged:
            d["_file"] = f.name
            d["_files"] = [f.name]
            d["_seen"] = {(r.get("text") or "")[:80] for r in d.get("reviews") or []}
            merged[key] = d
            order.append(key)
            continue

        # 이미 본 숙소 — 새 리뷰만 이어 붙인다
        base = merged[key]
        base["_files"].append(f.name)
        added = 0
        for r in d.get("reviews") or []:
            sig = (r.get("text") or "")[:80]
            if sig in base["_seen"]:
                continue
            base["_seen"].add(sig)
            base["reviews"].append(r)
            added += 1
        # 공식 표기·정책은 합집합 / 먼저 채워진 값 유지.
        # 리뷰 파일과 정책 파일이 같은 숙소로 합쳐지는 게 정상 경로다.
        base["official"] = sorted(set(base.get("official") or []) | set(d.get("official") or []))
        if not base.get("policy") and d.get("policy"):
            base["policy"] = d["policy"]

        # 객실별 취소정책 — 같은 (객실, 정책) 쌍은 한 번만
        rp = base.get("roomPolicies") or []
        seen_rp = {(r.get("roomName"), (r.get("policy") or "")[:70]) for r in rp}
        for r in d.get("roomPolicies") or []:
            k = (r.get("roomName"), (r.get("policy") or "")[:70])
            if k not in seen_rp:
                seen_rp.add(k)
                rp.append(r)
        if rp:
            base["roomPolicies"] = rp

        base["fees"] = {**(d.get("fees") or {}), **(base.get("fees") or {})}
        base["notices"] = list(dict.fromkeys(
            (base.get("notices") or []) + (d.get("notices") or [])))

        for k in ("listingName", "checkIn", "checkInTime", "checkOutTime"):
            if not base.get(k) and d.get(k):
                base[k] = d[k]

        extra = []
        if added:
            extra.append(f"리뷰 {added}건")
        if d.get("roomPolicies"):
            extra.append(f"정책 {len(d['roomPolicies'])}건")
        if d.get("fees"):
            extra.append(f"요금 {len(d['fees'])}항목")
        print(f"  ↳ {f.name} 을(를) {base['_file']} 에 병합 ({', '.join(extra) or '새 내용 없음'})")

    out = []
    for key in order:
        d = merged[key]
        d.pop("_seen", None)
        d["reviewCount"] = len(d.get("reviews") or [])
        out.append(d)
    return out


VERDICT_RANK = {"mention": 0, "ambiguous": 1, "negated": 2}


def analyze(listings: list[dict]) -> dict:
    total_reviews = 0
    mention_reviews = set()          # (파일, 리뷰idx) — 리뷰 단위 중복 방지
    fee_counter = Counter()          # 유형별 mention 수
    verdict_counter = Counter()
    per_listing = defaultdict(int)   # 숙소별 mention 건수
    candidates = []                  # 2단계 라벨링용
    conflicts = []                   # 공식 표기와 충돌하는 후보
    review_records = []              # HTML 리포트용 — 리뷰 단위로 판정을 묶어둔 것
    hotel_replies = 0                # 분석에서 제외한 사업자 답글 수

    for d in listings:
        key = d.get("_file", "?")
        official = d.get("official", []) or []
        # 이 숙소가 공식적으로 약속한 비용 유형들
        claimed_fees = set()
        claim_all = False
        for c in official:
            if c in CLAIM_TO_FEE:
                f = CLAIM_TO_FEE[c]
                if f is None:
                    claim_all = True
                else:
                    claimed_fees.add(f)

        for idx, r in enumerate(d.get("reviews", []) or []):
            # 호텔이 쓴 답글은 소비자 경험이 아니라 사업자 홍보문이다.
            # "이용해 주셔서 진심으로 감사드립니다" 류가 리뷰 목록에 섞여 들어온다(아고다 실측).
            if is_hotel_reply(r):
                hotel_replies += 1
                continue
            total_reviews += 1
            text = r.get("text", "") or ""
            hits: list[dict] = []
            for sent in split_sentences(text):
                for fee_type, kw, pos in find_fee_hits(sent):
                    verdict, cost, neg = judge(sent, kw, pos)
                    verdict_counter[verdict] += 1
                    hits.append({
                        "sentence": sent, "fee_type": fee_type, "keyword": kw,
                        "verdict": verdict, "cost_cues": cost, "neg_cues": neg,
                    })

                    rec = {
                        "file": key,
                        "site": d.get("site"),
                        "listingId": d.get("listingId"),
                        "reviewIdx": idx,
                        "date": r.get("date"),
                        "rating": r.get("rating"),
                        "sentence": sent,
                        "fee_type": fee_type,
                        "keyword": kw,
                        "rule_verdict": verdict,
                        "cost_cues": cost,
                        "neg_cues": neg,
                        # 라벨링용 빈 칸 — 사람이 채운다
                        "gold_is_cost_mention": None,
                    }
                    candidates.append(rec)

                    if verdict == "mention":
                        fee_counter[fee_type] += 1
                        mention_reviews.add((key, idx))
                        per_listing[key] += 1
                        if claim_all or fee_type in claimed_fees:
                            conflicts.append({**rec, "claims": official})

            # 리뷰 단위 대표 판정 — 가장 강한 것 하나 (mention > ambiguous > negated)
            top = min((h["verdict"] for h in hits), key=lambda v: VERDICT_RANK[v], default=None)
            review_records.append({
                "file": key, "site": d.get("site"), "listingId": d.get("listingId"),
                "idx": idx, "text": text, "date": r.get("date"), "rating": r.get("rating"),
                "hits": hits, "top": top, "claims": official,
            })

    return {
        "listings": len(listings),
        "total_reviews": total_reviews,
        "mention_reviews": len(mention_reviews),
        "fee_counter": fee_counter,
        "verdict_counter": verdict_counter,
        "per_listing": dict(per_listing),
        "candidates": candidates,
        "conflicts": conflicts,
        "review_records": review_records,
        "hotel_replies": hotel_replies,
        "policies": [
            {
                "file": d.get("_file"),
                "site": d.get("site"),
                "listingId": d.get("listingId"),
                "listingName": d.get("listingName"),
                "policy": d.get("policy"),
            }
            for d in listings
        ],
    }


def render_markdown(res: dict, listings: list[dict]) -> str:
    total = res["total_reviews"]
    mention = res["mention_reviews"]
    pct = (mention / total * 100) if total else 0.0
    n_listings = res["listings"]
    avg = (mention / n_listings) if n_listings else 0.0

    L = []
    L.append("## 1단계 빈도 실측 결과\n")
    L.append(f"- 수집 숙소: **{n_listings}곳**")
    L.append(f"- 전체 리뷰: **{total:,}건**\n")

    L.append("### 핵심 지표\n")
    L.append("| 지표 | 값 |")
    L.append("|---|---|")
    L.append(f"| 전체 리뷰 수 | {total:,} |")
    L.append(f"| 비용 언급 리뷰 수 | {mention:,} |")
    L.append(f"| **비용 언급 비율** | **{pct:.1f}%** |")
    L.append(f"| 숙소당 평균 언급 건수 | {avg:.1f} |")
    L.append(f"| 공식 표기와 충돌하는 후보 | {len(res['conflicts']):,} |")
    L.append("")

    # 중단 기준 판정 (계획서에 미리 정해둔 값)
    stop = pct < 3.0 and avg < 1.0
    L.append("### 중단 기준 판정\n")
    L.append("> 비용 언급 비율 3% 미만 **그리고** 숙소당 평균 1건 미만이면 이 방향을 접는다.\n")
    L.append(
        f"- 판정: **{'❌ 중단 기준에 걸림 — 방향 전환 검토' if stop else '✅ 통과 — 2단계 진행'}** "
        f"(비율 {pct:.1f}%, 숙소당 {avg:.1f}건)\n"
    )

    L.append("### 규칙 베이스라인 판정 분포\n")
    L.append("| 판정 | 건수 | 의미 |")
    L.append("|---|---|---|")
    vc = res["verdict_counter"]
    meaning = {
        "mention": "추가비용이 실제 발생했다고 본 문장",
        "negated": "같은 키워드지만 '무료였다'는 문장 — 키워드 매칭만 하면 전부 오탐",
        "ambiguous": "규칙으로는 못 가름 — **2단계 모델이 이겨야 할 구간**",
    }
    for v in ("mention", "negated", "ambiguous"):
        L.append(f"| {v} | {vc.get(v, 0):,} | {meaning[v]} |")
    amb = vc.get("ambiguous", 0)
    tot_hits = sum(vc.values())
    if tot_hits:
        L.append("")
        L.append(f"→ 키워드가 걸린 문장 {tot_hits:,}건 중 **{amb / tot_hits * 100:.1f}%가 규칙으로 판정 불가**.")
    L.append("")

    L.append("### 비용 유형 분포 (mention 기준)\n")
    L.append("| 유형 | 건수 |")
    L.append("|---|---|")
    for fee, n in res["fee_counter"].most_common():
        L.append(f"| {fee} | {n:,} |")
    if not res["fee_counter"]:
        L.append("| (없음) | 0 |")
    L.append("")

    L.append("### 숙소별 수집 현황\n")
    L.append("| 숙소 | 사이트 | 파일 | 리뷰 | 언급 | 정책 |")
    L.append("|---|---|---|---|---|---|")
    for d in listings:
        f = d.get("_file", "?")
        nfiles = len(d.get("_files") or [f])
        name = (d.get("listingName") or d.get("listingId") or "?")[:28]
        pol = d.get("policy") or {}
        npol = len(pol.get("cancellation") or [])
        pol_cell = f"{npol}문장" if npol else "❌"
        if pol.get("freeCancelUntil"):
            pol_cell += f" · 무료취소 {pol['freeCancelUntil']}"
        L.append(
            f"| {name} | {d.get('site','?')} | {nfiles} | {len(d.get('reviews') or []):,} | "
            f"{res['per_listing'].get(f, 0)} | {pol_cell} |"
        )
    L.append("")
    if any(len(d.get("_files") or []) > 1 for d in listings):
        L.append("> 같은 숙소를 여러 번에 나눠 받은 파일은 **자동으로 병합**했습니다"
                 "(페이지당 5개씩만 보이는 사이트 대응).\n")

    if res.get("hotel_replies"):
        L.append(f"> 사업자(호텔) 답글 **{res['hotel_replies']}건**은 분석에서 제외했습니다 "
                 "— 소비자 경험이 아니라 홍보문입니다.\n")

    missing = [d for d in listings if not (d.get("policy") or {}).get("cancellation")]
    if missing:
        L.append(f"### ⚠️ 취소정책을 못 받은 숙소 {len(missing)}곳\n")
        for d in missing:
            L.append(f"- {d.get('listingName') or d.get('listingId')} ({d.get('site')})")
        L.append("\n→ 해당 숙소 페이지에서 `await collectPolicy()` 를 따로 실행해 보세요.\n")

    if res["conflicts"]:
        L.append("### 공식 표기와 충돌하는 후보 (3단계 예상 수확량)\n")
        for c in res["conflicts"][:15]:
            L.append(f"- **[{c['fee_type']}]** {c['site']}/{c['listingId']} — \"{c['sentence'][:90]}\"")
            L.append(f"  - 공식 표기: {', '.join(c['claims'][:5])}")
        if len(res["conflicts"]) > 15:
            L.append(f"- … 외 {len(res['conflicts']) - 15}건")
        L.append("")

    return "\n".join(L)


def render_verdict_report(res: dict, verdict: str, title: str, note: str) -> str:
    """특정 판정(ambiguous 등)의 문장만 모아 읽기 좋은 형태로 낸다.
    회의에서 그대로 띄울 수 있게 유형별로 묶고, 왜 그 판정이 났는지 단서를 같이 보인다."""
    rows = [c for c in res["candidates"] if c["rule_verdict"] == verdict]
    L = [f"# {title}\n", note, ""]
    L.append(f"총 **{len(rows):,}건**\n")

    if not rows:
        L.append("_해당 문장이 없습니다._")
        return "\n".join(L)

    by_fee = defaultdict(list)
    for r in rows:
        by_fee[r["fee_type"]].append(r)

    for fee, items in sorted(by_fee.items(), key=lambda kv: -len(kv[1])):
        L.append(f"## {fee} ({len(items)}건)\n")
        for r in items:
            L.append(f"- \"{r['sentence']}\"")
            cues = []
            if r["cost_cues"]:
                cues.append(f"비용단서 {','.join(r['cost_cues'])}")
            if r["neg_cues"]:
                cues.append(f"부정단서 {','.join(r['neg_cues'])}")
            why = " / ".join(cues) if cues else "단서 없음"
            meta = f"{r['site']}/{r['listingId']}"
            if r.get("date"):
                meta += f" · {r['date']}"
            L.append(f"  - `{r['keyword']}` · {why} · {meta}")
        L.append("")

    return "\n".join(L)


HTML_TEMPLATE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>리뷰 수집 결과 — __N__건</title>
<style>
:root{--bg:#f6f7f8;--sf:#fff;--sf2:#eef1f3;--ink:#16202b;--mut:#5c6b7a;--ln:#dde3e8;
--acc:#0f766e;--accs:#dcefec;--wrn:#b45309;--wrns:#fbebda;--good:#15803d;--goods:#def0e4;}
@media(prefers-color-scheme:dark){:root{--bg:#10161c;--sf:#161e26;--sf2:#1d2731;--ink:#e6edf3;
--mut:#93a5b6;--ln:#26313b;--acc:#2dd4bf;--accs:#123833;--wrn:#f0a02a;--wrns:#3a2a12;
--good:#4ade80;--goods:#14301f;}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);margin:0;padding:0 1.2rem 5rem;
font:15px/1.7 -apple-system,"Malgun Gothic",system-ui,sans-serif}
.w{max-width:56rem;margin:0 auto}
h1{font-size:1.7rem;margin:2.4rem 0 .4rem;letter-spacing:-.02em}
.sub{color:var(--mut);font-size:.92rem;margin:0 0 1.8rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.7rem;margin-bottom:1.6rem}
.c{background:var(--sf);border:1px solid var(--ln);border-radius:8px;padding:.9rem 1rem}
.c .k{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);
font-family:ui-monospace,Consolas,monospace}
.c .v{font-size:1.45rem;font-weight:700;font-variant-numeric:tabular-nums;margin-top:.15rem}
.c.hero{border-color:var(--acc)}.c.hero .v{color:var(--acc)}
.verdict{background:var(--sf);border:1px solid var(--ln);border-radius:8px;padding:1rem 1.1rem;margin-bottom:1.6rem}
.verdict b{font-size:1.05rem}
.bars{display:flex;height:9px;border-radius:99px;overflow:hidden;margin:.8rem 0 .5rem;background:var(--sf2)}
.bars i{display:block}
.bars i.m{background:var(--good)}.bars i.a{background:var(--wrn)}.bars i.n{background:var(--mut)}
.lg{display:flex;gap:1rem;flex-wrap:wrap;font-size:.82rem;color:var(--mut);
font-family:ui-monospace,Consolas,monospace}
.lg span::before{content:"■ ";}
.lg .m::before{color:var(--good)}.lg .a::before{color:var(--wrn)}.lg .n::before{color:var(--mut)}
.filters{display:flex;gap:.4rem;flex-wrap:wrap;margin:1.6rem 0 1rem;position:sticky;top:0;
background:var(--bg);padding:.7rem 0;z-index:5;border-bottom:1px solid var(--ln)}
.filters button{background:var(--sf);border:1px solid var(--ln);color:var(--ink);padding:.4rem .8rem;
border-radius:99px;cursor:pointer;font:inherit;font-size:.85rem}
.filters button.on{background:var(--acc);border-color:var(--acc);color:var(--bg);font-weight:600}
.rv{background:var(--sf);border:1px solid var(--ln);border-left-width:3px;border-radius:8px;
padding:.9rem 1.1rem;margin-bottom:.6rem}
.rv[data-v="mention"]{border-left-color:var(--good)}
.rv[data-v="ambiguous"]{border-left-color:var(--wrn)}
.rv[data-v="negated"]{border-left-color:var(--mut)}
.rv[data-v="none"]{border-left-color:var(--ln)}
.rv .hd{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem;
font-size:.78rem;color:var(--mut);font-family:ui-monospace,Consolas,monospace}
.rv .tx{font-size:.95rem;line-height:1.75}
.pill{font-family:ui-monospace,Consolas,monospace;font-size:.68rem;font-weight:600;
padding:.12em .5em;border-radius:4px}
.p-m{background:var(--goods);color:var(--good)}.p-a{background:var(--wrns);color:var(--wrn)}
.p-n{background:var(--sf2);color:var(--mut)}
mark{background:none;padding:0}
mark.kw{background:var(--accs);color:var(--ink);border-radius:2px;padding:.05em .2em;font-weight:600}
mark.cc{border-bottom:2px solid var(--good)}
mark.nc{border-bottom:2px solid var(--mut)}
.why{margin-top:.5rem;font-size:.8rem;color:var(--mut);font-family:ui-monospace,Consolas,monospace;
display:flex;gap:.8rem;flex-wrap:wrap}
.none{color:var(--mut);text-align:center;padding:3rem 1rem}
</style></head><body><div class="w">
<h1>리뷰 수집 결과</h1>
<p class="sub">__SUB__</p>
<div class="cards" id="cards"></div>
<div class="verdict" id="verdict"></div>
<div class="filters" id="filters"></div>
<div id="list"></div>
</div>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const esc = s => String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const LBL = {mention:["비용 발생","p-m"],ambiguous:["판정 불가","p-a"],negated:["무료였음","p-n"]};

document.getElementById("cards").innerHTML = [
  ["숙소", D.listings, 0],["전체 리뷰", D.total, 0],
  ["비용 언급 리뷰", D.mentionReviews, 0],["비용 언급 비율", D.pct.toFixed(1)+"%", 1],
  ["숙소당 평균", D.avg.toFixed(1)+"건", 0],["표기 충돌 후보", D.conflicts, 0],
].map(([k,v,hero])=>`<div class="c${hero?" hero":""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

const vc = D.verdicts, tot = vc.mention+vc.ambiguous+vc.negated || 1;
document.getElementById("verdict").innerHTML =
  `<b>${D.stop?"❌ 중단 기준에 걸림":"✅ 중단 기준 통과"}</b>
   <span style="color:var(--mut);font-size:.88rem"> — 비율 ${D.pct.toFixed(1)}% · 숙소당 ${D.avg.toFixed(1)}건
   (기준: 3% 미만 <i>그리고</i> 1건 미만이면 중단)</span>
   <div class="bars">
     <i class="m" style="width:${vc.mention/tot*100}%"></i>
     <i class="a" style="width:${vc.ambiguous/tot*100}%"></i>
     <i class="n" style="width:${vc.negated/tot*100}%"></i></div>
   <div class="lg"><span class="m">비용 발생 ${vc.mention}</span>
     <span class="a">판정 불가 ${vc.ambiguous} — 규칙의 한계</span>
     <span class="n">무료였음 ${vc.negated} — 키워드만 썼다면 전부 오탐</span></div>`;

const FILTERS = [["all","전체"],["mention","비용 발생"],["ambiguous","판정 불가"],
  ["negated","무료였음"],["none","키워드 없음"]];
let cur = "all";
const fEl = document.getElementById("filters");
function drawFilters(){
  fEl.innerHTML = FILTERS.map(([k,l])=>{
    const n = k==="all" ? D.reviews.length : D.reviews.filter(r=>(r.top||"none")===k).length;
    return `<button data-k="${k}" class="${k===cur?"on":""}">${l} <span style="opacity:.7">${n}</span></button>`;
  }).join("");
  fEl.querySelectorAll("button").forEach(b=>b.onclick=()=>{cur=b.dataset.k;drawFilters();draw();});
}

/** 문장에서 키워드와 단서를 표시한다 — 왜 그 판정이 났는지 눈으로 보이게.
 *  치환이 아니라 위치를 모아서 겹치지 않게 자른다. 단순 문자열 치환을 쓰면
 *  이미 넣은 <mark> 안쪽을 또 치환해서 마크업이 깨진다. */
function markUp(sent, hit){
  const spans = [];
  const add = (word, cls) => {
    if(!word) return;
    let i = sent.indexOf(word);
    while(i >= 0){ spans.push({s:i, e:i+word.length, cls}); i = sent.indexOf(word, i+word.length); }
  };
  add(hit.keyword,"kw");
  (hit.cost_cues||[]).forEach(c=>add(c,"cc"));
  (hit.neg_cues||[]).forEach(c=>add(c,"nc"));
  // 시작 위치 순, 같으면 키워드 우선, 그다음 긴 것 우선
  spans.sort((a,b)=> a.s-b.s || (a.cls==="kw"?-1:b.cls==="kw"?1:0) || (b.e-b.s)-(a.e-a.s));
  let out="", pos=0;
  for(const sp of spans){
    if(sp.s < pos) continue;                    // 앞 표시와 겹치면 건너뛴다
    out += esc(sent.slice(pos,sp.s)) + `<mark class="${sp.cls}">` + esc(sent.slice(sp.s,sp.e)) + `</mark>`;
    pos = sp.e;
  }
  return out + esc(sent.slice(pos));
}

function draw(){
  const rows = D.reviews.filter(r=>cur==="all"||(r.top||"none")===cur);
  const list = document.getElementById("list");
  if(!rows.length){ list.innerHTML = `<div class="none">해당하는 리뷰가 없습니다.</div>`; return; }
  list.innerHTML = rows.map(r=>{
    const v = r.top||"none";
    const pill = LBL[v] ? `<span class="pill ${LBL[v][1]}">${LBL[v][0]}</span>` : "";
    const hits = r.hits.map(h=>`
      <div class="why">
        <span>${h.fee_type}</span>
        <span>${h.cost_cues.length?"비용단서 "+h.cost_cues.join(","):""}</span>
        <span>${h.neg_cues.length?"부정단서 "+h.neg_cues.join(","):""}</span>
        <span>${!h.cost_cues.length&&!h.neg_cues.length?"단서 없음":""}</span>
      </div>`).join("");
    // 판정에 걸린 문장은 강조해서 보여주고, 나머지 본문은 그대로
    let tx = esc(r.text);
    r.hits.forEach(h=>{ tx = tx.split(esc(h.sentence)).join(markUp(h.sentence,h)); });
    return `<div class="rv" data-v="${v}">
      <div class="hd">${pill}<span>${esc(r.site)}/${esc(r.listingId)}</span>
        <span>#${r.idx+1}</span><span>${esc(r.date)||"날짜 없음"}</span>
        <span>★ ${r.rating??"—"}</span></div>
      <div class="tx">${tx}</div>${hits}</div>`;
  }).join("");
}
drawFilters(); draw();
</script></body></html>"""


def render_html(res: dict, listings: list[dict]) -> str:
    """수집된 리뷰와 판정 근거를 눈으로 확인하는 리포트.
    표(집계.md)만으로는 '왜 그렇게 판정됐는지'가 안 보여서, 문장 안의 키워드·단서를
    직접 하이라이트해 보여준다. 라벨링 전에 감을 잡거나 회의에서 띄우는 용도."""
    total = res["total_reviews"]
    mention = res["mention_reviews"]
    pct = (mention / total * 100) if total else 0.0
    n_listings = res["listings"]
    avg = (mention / n_listings) if n_listings else 0.0
    vc = res["verdict_counter"]

    payload = {
        "listings": n_listings,
        "total": total,
        "mentionReviews": mention,
        "pct": pct,
        "avg": avg,
        "conflicts": len(res["conflicts"]),
        "stop": pct < 3.0 and avg < 1.0,
        "verdicts": {k: vc.get(k, 0) for k in ("mention", "ambiguous", "negated")},
        "reviews": res["review_records"],
    }
    # </script> 가 데이터에 섞이면 문서가 깨진다
    data = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

    sub = (f"숙소 {n_listings}곳 · 리뷰 {total:,}건 · "
           f"규칙 판정 {sum(vc.values()):,}건 — 문장 안의 "
           f"키워드와 단서를 하이라이트해서 판정 근거를 보여줍니다.")

    return (HTML_TEMPLATE
            .replace("__DATA__", data)
            .replace("__SUB__", sub)
            .replace("__N__", f"{total:,}"))


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        # 한글 Windows 콘솔(cp949)에서 ✅ 등이 깨지는 걸 방지 (pipeline.py와 동일 처리)
        sys.stdout.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--out", default="out")
    args = ap.parse_args()

    data_dir = (HERE / args.data_dir) if not pathlib.Path(args.data_dir).is_absolute() else pathlib.Path(args.data_dir)
    out_dir = (HERE / args.out) if not pathlib.Path(args.out).is_absolute() else pathlib.Path(args.out)

    def _looks_like_ours(p: pathlib.Path) -> bool:
        """우리 수집기가 만든 파일인지 — 무관한 json까지 안내하면 오히려 헷갈린다."""
        try:
            if p.stat().st_size > 20_000_000:
                return False
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return False
        return isinstance(d, dict) and "reviews" in d and "site" in d

    def _stray_hint() -> None:
        """수집한 json을 data/ 대신 다른 곳(브라우저 기본 다운로드 폴더 등)에 둔 경우가 흔하다."""
        for where in (HERE, HERE.parent, pathlib.Path.home() / "Downloads"):
            try:
                stray = [p for p in where.glob("*.json")
                         if p.parent != data_dir and _looks_like_ours(p)]
            except OSError:
                continue
            if stray:
                print(f"\n💡 {where} 에 수집기 파일이 {len(stray)}개 있습니다:")
                for p in stray[:6]:
                    print(f"     {p.name}")
                print(f"   → 이 파일들을 {data_dir} 로 옮기고 다시 실행하세요.")
                return

    if not data_dir.exists():
        # 없다고 알리기만 하면 사용자가 직접 만들어야 한다. 만들어 두는 편이 낫다.
        data_dir.mkdir(parents=True, exist_ok=True)
        print(f"📁 데이터 폴더를 만들었습니다: {data_dir}")
        print("   collect-reviews.js로 수집한 .json을 여기에 넣고 다시 실행하세요.")
        _stray_hint()
        return

    listings = load_listings(data_dir)
    if not listings:
        print(f"❌ {data_dir} 에 읽을 수 있는 .json 이 없습니다.")
        _stray_hint()
        return

    print(f"📂 {len(listings)}개 숙소 파일 로드")
    res = analyze(listings)

    out_dir.mkdir(parents=True, exist_ok=True)
    md = render_markdown(res, listings)
    (out_dir / "집계.md").write_text(md, encoding="utf-8")

    with (out_dir / "후보.jsonl").open("w", encoding="utf-8") as f:
        for c in res["candidates"]:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    # 판정별 문장 모음 — 회의에서 바로 띄울 수 있는 형태
    reports = {
        "애매한-문장.md": (
            "ambiguous",
            "규칙으로 판정 불가한 문장 (ambiguous)",
            "> 키워드는 걸렸는데 비용단서·부정단서가 없거나 둘 다 있어서 규칙이 못 가른 문장들.\n"
            "> **이 구간이 2단계 분류기가 이겨야 할 지점이고, 라벨링도 여기부터 하는 게 효율적이다.**",
        ),
        "비용언급-문장.md": (
            "mention",
            "추가비용 언급으로 판정된 문장 (mention)",
            "> 규칙이 '실제로 돈을 더 냈다'고 본 문장들. 정탐률 확인용 — 사람이 훑어서 오탐을 걸러낸다.",
        ),
        "무료라는-문장.md": (
            "negated",
            "오히려 무료였다는 문장 (negated)",
            "> 같은 키워드가 걸렸지만 '무료/없었다'는 문장.\n"
            "> **키워드 매칭만 했다면 이게 전부 오탐이 됐을 것** — 부정어 처리의 효과를 보여주는 근거.",
        ),
    }
    for fname, (verdict, title, note) in reports.items():
        (out_dir / fname).write_text(render_verdict_report(res, verdict, title, note), encoding="utf-8")

    report_path = out_dir / "리포트.html"
    report_path.write_text(render_html(res, listings), encoding="utf-8")

    print(md)
    print(f"\n✅ 저장: {report_path}  ← 브라우저로 열면 수집 데이터+판정근거를 볼 수 있습니다")
    print(f"✅ 저장: {out_dir / '집계.md'}  (실측-로그.md에 붙여넣을 표)")
    print(f"✅ 저장: {out_dir / '애매한-문장.md'}  ({res['verdict_counter'].get('ambiguous', 0):,}건) ← 회의용")
    print(f"✅ 저장: {out_dir / '비용언급-문장.md'}  ({res['verdict_counter'].get('mention', 0):,}건)")
    print(f"✅ 저장: {out_dir / '무료라는-문장.md'}  ({res['verdict_counter'].get('negated', 0):,}건)")
    print(f"✅ 저장: {out_dir / '후보.jsonl'}  ({len(res['candidates']):,}건, 라벨링용)")
    print("   → 2단계 라벨링은 후보.jsonl의 gold_is_cost_mention 칸을 채우면 됩니다.")

    # 애매한 문장은 콘솔에도 바로 보여준다 — 파일 안 열고 확인할 수 있게
    amb = [c for c in res["candidates"] if c["rule_verdict"] == "ambiguous"]
    if amb:
        print(f"\n{'─' * 60}\n애매한 문장 미리보기 (최대 10건)\n{'─' * 60}")
        for c in amb[:10]:
            print(f"  [{c['fee_type']}] {c['sentence'][:70]}")
        if len(amb) > 10:
            print(f"  … 외 {len(amb) - 10}건 — {out_dir / '애매한-문장.md'} 참고")


if __name__ == "__main__":
    main()
