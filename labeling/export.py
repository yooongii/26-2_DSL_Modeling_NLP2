"""
export.py — 수집한 JSON을 **팀 제출 형식** 텍스트로 바꾼다.

수집기는 JSON을 만들지만 팀에 보낼 건 아래 형식의 텍스트다. 손으로 옮기면 15개 숙소에
한 시간씩 걸리고 오타가 난다.

    [약관 파트]
    [1] 체크인: 2026-09-10 / 숙소: OO호텔 스탠다드룸(리조트)
    원문: "체크인 3일 전 18시까지 무료 취소, 이후 첫 1박 요금 부과"

    [리뷰 파트]
    [1] 숙소: OO호텔(리조트)
    리뷰: "주차비를 따로 냈어요. 방은 깨끗했습니다."

실행:
    python export.py --checkin 2026-11-12 --category 리조트
    python export.py --checkin 2026-11-12 --category 리조트 --all-reviews

기본은 **비용 관련 리뷰만** 추린다(analyze.py와 같은 규칙). 팀 지시가
"청소비·리조트피·주차·조식 관련 있어 보이는 리뷰"라서 그렇다.
숙소당 상한은 --per-listing 으로 조절한다(기본 20건).
"""
import argparse
import json
import pathlib
import sys

# analyze.py의 판정 규칙을 그대로 재사용한다 — 두 벌로 관리하면 반드시 어긋난다
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from analyze import (  # noqa: E402
    find_fee_hits, is_hotel_reply, judge, load_listings, split_sentences,
)

HERE = pathlib.Path(__file__).resolve().parent


def pick_reviews(listing: dict, limit: int, all_reviews: bool) -> list[dict]:
    """비용 언급이 있어 보이는 리뷰를 앞쪽에 놓고 limit개까지 고른다.

    규칙 판정이 mention이면 1순위, ambiguous면 2순위. 팀 지시가 "확실치 않아도
    그냥 포함"이라 ambiguous도 넣는다 — 애매한 게 오히려 라벨링 가치가 크다."""
    ranked: list[tuple[int, dict]] = []
    for r in listing.get("reviews") or []:
        if is_hotel_reply(r):
            continue
        text = r.get("text") or ""
        best = 3  # 3 = 키워드 없음
        for sent in split_sentences(text):
            for _fee, kw, pos in find_fee_hits(sent):
                verdict, _c, _n = judge(sent, kw, pos)
                rank = {"mention": 0, "ambiguous": 1, "negated": 2}[verdict]
                best = min(best, rank)
        if not all_reviews and best == 3:
            continue
        ranked.append((best, r))

    ranked.sort(key=lambda x: x[0])
    return [r for _, r in ranked[:limit]]


def policy_entries(listing: dict) -> list[tuple[str | None, str]]:
    """(객실명, 정책원문) 목록.

    제출 형식이 객실/요금제 단위라 `roomPolicies`(collectPolicies() 결과)를 우선 쓴다.
    그게 없으면 예전 방식(`policy.cancellation`, 객실 구분 없음)으로 떨어진다."""
    rooms = listing.get("roomPolicies")
    if rooms:
        return [(r.get("roomName"), r["policy"]) for r in rooms if (r.get("policy") or "").strip()]
    pol = listing.get("policy") or {}
    return [(None, t) for t in (pol.get("cancellation") or []) if t.strip()]


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--out", default="제출-원고.txt")
    ap.add_argument("--checkin", required=True,
                    help="검색에 쓴 체크인 날짜 (예: 2026-11-12). 약관 파트에 필수 — "
                         "'체크인 3일 전' 같은 상대 표기를 절대 날짜로 바꾸려면 있어야 한다")
    ap.add_argument("--category", default="리조트", help="숙소 종류 표기 (담당 분담용)")
    ap.add_argument("--per-listing", type=int, default=20, help="숙소당 리뷰 상한")
    ap.add_argument("--all-reviews", action="store_true",
                    help="비용 관련 필터 없이 전부 내보낸다")
    ap.add_argument("--no-policy", action="store_true",
                    help="약관·숨은비용 파트를 빼고 리뷰만 내보낸다")
    args = ap.parse_args()

    data_dir = pathlib.Path(args.data_dir)
    if not data_dir.is_absolute():
        data_dir = HERE / data_dir
    if not data_dir.exists():
        print(f"❌ 데이터 폴더가 없습니다: {data_dir}")
        return

    listings = load_listings(data_dir)
    if not listings:
        print(f"❌ {data_dir} 에 읽을 수 있는 .json 이 없습니다.")
        return

    L: list[str] = []
    n_pol = 0
    n_named = 0
    n_fee = 0
    if args.no_policy:
        listings_for_policy: list[dict] = []
    else:
        listings_for_policy = listings
        L.append("[약관 파트]")
    for d in listings_for_policy:
        name = d.get("listingName") or d.get("listingId")
        # 수집 당시 URL의 체크인 날짜를 우선 쓴다 (숙소마다 다를 수 있으므로)
        checkin = d.get("checkIn") or args.checkin
        for room, t in policy_entries(d):
            n_pol += 1
            if room:
                n_named += 1
            label = f"{name} {room}" if room else name
            L.append(f"[{n_pol}] 체크인: {checkin} / 숙소: {label}({args.category})")
            L.append(f'원문: "{t}"')
            L.append("")

    if listings_for_policy and n_pol == 0:
        L.append("(수집된 정책 문장이 없습니다 — collectPolicies()를 실행해 보세요)")
        L.append("")

    # ── 숨은 비용 파트 — [정책] 탭에서 나온 것 ──────────────
    # 리뷰에서 찾으려던 정보가 숙소 공식 안내에 그대로 적혀 있는 경우가 많다.
    # 리뷰(주관적 진술)와 성격이 달라 파트를 나눈다.
    fee_lines: list[str] = []
    for d in listings_for_policy:
        name = d.get("listingName") or d.get("listingId")
        fees = d.get("fees") or {}
        notices = d.get("notices") or []
        if not fees and not notices:
            continue
        fee_lines.append(f"■ {name}({args.category})")
        for k, v in fees.items():
            n_fee += 1
            fee_lines.append(f"  - {k}: {v}")
        for t in notices:
            n_fee += 1
            fee_lines.append(f'  - "{t}"')
        fee_lines.append("")

    if fee_lines:
        L.append("")
        L.append("[숨은 비용 파트 — 숙소 공식 안내]")
        L.extend(fee_lines)

    L.append("")
    L.append("[리뷰 파트]")
    n_rv = 0
    per_listing_counts = []
    for d in listings:
        name = d.get("listingName") or d.get("listingId")
        picked = pick_reviews(d, args.per_listing, args.all_reviews)
        per_listing_counts.append((name, len(picked), len(d.get("reviews") or [])))
        for r in picked:
            n_rv += 1
            L.append(f"[{n_rv}] 숙소: {name}({args.category})")
            L.append(f'리뷰: "{r.get("text", "").strip()}"')
            L.append("")

    out_path = HERE / args.out if not pathlib.Path(args.out).is_absolute() else pathlib.Path(args.out)
    out_path.write_text("\n".join(L), encoding="utf-8")

    print(f"✅ {out_path}")
    print(f"   숙소 {len(listings)}곳 · 약관 {n_pol}건 · 숨은비용 {n_fee}건 · 리뷰 {n_rv}건")
    print()
    print("숙소별 리뷰 선별 결과:")
    for name, picked, total in per_listing_counts:
        mark = "⚠️" if picked < 10 else "  "
        print(f"  {mark} {str(name)[:34]:<34} {picked:>3}건 선별 / 전체 {total}건")

    thin = [c for c in per_listing_counts if c[1] < 10]
    if thin:
        print()
        print(f"⚠️ 10건 미만인 숙소가 {len(thin)}곳입니다.")
        print("   maxPages를 올려 더 수집하거나, 평점 낮은 순 정렬로 불만 리뷰를 더 모으세요.")

    print(f"\n약관: {n_pol}건 (객실명이 붙은 것 {n_named}건)")
    if n_pol < 35:
        need = 35 - n_pol
        print(f"⚠️ 목표 35~40건까지 {need}건 부족합니다.")
        print("   숙소 객실 목록 화면에서 await collectPolicies() 를 돌리면 요금제별로 여러 건이 나옵니다.")
    if n_named < n_pol:
        print(f"⚠️ {n_pol - n_named}건은 객실명을 못 찾았습니다 — 제출 형식엔 객실명이 필요합니다.")
        print("   객실 목록 화면(‘객실 상품 보기’)에서 await collectPolicies() 를 다시 돌려보세요.")


if __name__ == "__main__":
    main()
