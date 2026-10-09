"""팀원이 정리한 md 수집 파일을 analyze.py가 읽는 json으로 바꾼다.

    md/*.md  →  data/*.json

왜 변환기를 따로 두는가:
  analyze.py는 collect-reviews.js가 만든 json 스키마만 읽는다. 거기에 md 파서를 끼워넣으면
  판정 로직과 입력 형식이 한 파일에 섞인다. 입구만 바꿔 끼우는 편이 안전하고,
  기존 회귀 테스트도 그대로 산다.

받는 형식 (두 가지 변형 모두 지원):

    ## 약관 파트                          ## [약관 파트]
    [1] 체크인: 2026-10-15 / 숙소: 이름   [1] 체크인: ... / 숙소: 이름
    카드 요약: "..."                      요금제: 트윈룸 / 환불 불가
    전문(자세히 보기): "..."               원문: "..."

    ## 리뷰 파트
    [1] 숙소: 더 캡슐 명동(캡슐호텔)
    리뷰: "..."

숙소 이름의 끝 괄호는 담당자가 붙인 유형 표시다 — `(캡슐호텔)`, `(비환불 특가)`.
이걸 떼어낸 이름으로 숙소를 묶는다. 같은 숙소를 여러 담당자가 맡아도 하나로 합쳐진다.
"""

import argparse
import json
import pathlib
import re
import sys
import unicodedata
from collections import OrderedDict

HERE = pathlib.Path(__file__).resolve().parent

# "## 약관 파트" 와 "## [약관 파트]" 를 모두 받는다
SECTION_RE = re.compile(r"^##\s*\[?\s*(약관|리뷰)\s*파트\s*\]?\s*$", re.M)
ITEM_RE = re.compile(r"^\[\d+\]", re.M)

# 한 항목 안의 필드들. 담당자마다 라벨이 조금씩 다르다.
FIELD_RE = {
    "checkin":  re.compile(r"체크인:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})"),
    "listing":  re.compile(r"숙소:\s*(.+?)\s*$", re.M),
    "roomrate": re.compile(r"요금제:\s*(.+?)\s*$", re.M),
    "card":     re.compile(r"카드 요약:\s*[\"“](.*?)[\"”]", re.S),
    "full":     re.compile(r"(?:전문\(자세히 보기\)|원문):\s*[\"“](.*?)[\"”]", re.S),
    "review":   re.compile(r"리뷰:\s*[\"“](.*?)[\"”]\s*$", re.S),
}

# 담당자가 이름 끝에 붙인 유형 표시 — 숙소 식별에서는 뗀다
TYPE_SUFFIX_RE = re.compile(r"\s*\(([^()]*)\)\s*$")


def strip_type(name: str) -> tuple[str, str]:
    """'더 캡슐 명동(캡슐호텔)' → ('더 캡슐 명동', '캡슐호텔')"""
    m = TYPE_SUFFIX_RE.search(name)
    if not m:
        return name.strip(), ""
    return name[:m.start()].strip(), m.group(1).strip()


def slug(name: str) -> str:
    """숙소 이름 → listingId. 같은 숙소가 같은 id로 떨어져야 analyze.py가 병합한다."""
    s = unicodedata.normalize("NFKC", name).lower()
    s = re.sub(r"[^0-9a-z가-힣]+", "-", s).strip("-")
    return s or "unknown"


def split_items(block: str) -> list[str]:
    """'[1] ...' 로 시작하는 항목들로 자른다."""
    starts = [m.start() for m in ITEM_RE.finditer(block)]
    return [block[s:(starts[i + 1] if i + 1 < len(starts) else len(block))]
            for i, s in enumerate(starts)]


def parse_md(text: str) -> tuple[list[dict], list[dict]]:
    """(리뷰 항목들, 약관 항목들)"""
    marks = [(m.start(), m.end(), m.group(1)) for m in SECTION_RE.finditer(text)]
    sections: dict[str, str] = {}
    for i, (s, e, kind) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        sections[kind] = sections.get(kind, "") + text[e:end]

    reviews = []
    for item in split_items(sections.get("리뷰", "")):
        name = FIELD_RE["listing"].search(item)
        body = FIELD_RE["review"].search(item)
        if not (name and body):
            continue
        raw = body.group(1).strip()
        if raw:
            reviews.append({"listing": name.group(1).strip(), "text": raw})

    policies = []
    for item in split_items(sections.get("약관", "")):
        name = FIELD_RE["listing"].search(item)
        if not name:
            continue
        full = FIELD_RE["full"].search(item)
        card = FIELD_RE["card"].search(item)
        rate = FIELD_RE["roomrate"].search(item)
        ci = FIELD_RE["checkin"].search(item)
        policies.append({
            "listing": name.group(1).strip(),
            "policy": (full.group(1).strip() if full else ""),
            "cardSummary": (card.group(1).strip() if card else ""),
            "roomRate": (rate.group(1).strip() if rate else ""),
            "checkIn": (ci.group(1) if ci else ""),
        })
    return reviews, policies


def attach_policies(listings: "OrderedDict[str, dict]", policies: list[dict]) -> int:
    """약관 항목을 숙소에 붙인다.

    약관의 숙소명은 '호텔명 + 객실명'이라 리뷰 쪽 이름과 정확히 같지 않다
    (예: 리뷰 '더 캡슐 명동' vs 약관 '더 캡슐 명동 Basic Shared Dormitory').
    그래서 **리뷰 쪽 이름으로 시작하는지**를 보고, 가장 긴 것에 붙인다."""
    attached = 0
    keys = sorted(listings, key=lambda k: -len(listings[k]["listingName"]))
    for p in policies:
        base, _ = strip_type(p["listing"])
        target = next((k for k in keys if base.startswith(listings[k]["listingName"])), None)
        if target is None:
            continue
        room = base[len(listings[target]["listingName"]):].strip() or base
        listings[target].setdefault("roomPolicies", []).append({
            "roomName": room,
            "policy": p["policy"],
            "cardSummary": p["cardSummary"],
            "roomRate": p["roomRate"],
            "checkIn": p["checkIn"],
        })
        attached += 1
    return attached


def convert(path: pathlib.Path, out_dir: pathlib.Path, site: str) -> tuple[int, int, int]:
    reviews, policies = parse_md(path.read_text(encoding="utf-8"))

    listings: OrderedDict[str, dict] = OrderedDict()
    for r in reviews:
        base, kind = strip_type(r["listing"])
        key = slug(base)
        if key not in listings:
            listings[key] = {
                "site": site,
                "listingId": key,
                "listingName": base,
                "listingType": kind,
                "source": "md",
                "sourceFile": path.name,
                # md에는 숙소 공식 표기(무료 주차 등)가 없다.
                # 그래서 '표기 vs 실태' 충돌 탐지는 md 입력에서는 동작하지 않는다.
                "official": [],
                "reviews": [],
            }
        # md에는 작성일·평점이 없다. 없는 값을 지어내지 않는다.
        listings[key]["reviews"].append({"text": r["text"], "date": None, "rating": None})

    attached = attach_policies(listings, policies)
    if policies and attached < len(policies):
        # 리뷰 파트에 없는 숙소의 약관은 붙일 데가 없다. 조용히 버리면 나중에
        # "약관 건수가 왜 안 맞지"로 돌아온다.
        print(f"     ↳ 약관 {len(policies) - attached}건은 붙일 숙소가 없어 제외 "
              f"(리뷰 파트에 그 숙소가 없음)")

    out_dir.mkdir(parents=True, exist_ok=True)
    for key, d in listings.items():
        d["reviewCount"] = len(d["reviews"])
        (out_dir / f"md-{path.stem}-{key}.json").write_text(
            json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")

    return len(listings), len(reviews), attached


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description="팀원 md 수집 파일 → analyze.py용 json")
    ap.add_argument("--md-dir", default="md", help="md 파일이 있는 폴더")
    ap.add_argument("--out", default="data", help="json을 넣을 폴더 (analyze.py가 읽는 곳)")
    ap.add_argument("--site", default="agoda")
    args = ap.parse_args()

    md_dir = HERE / args.md_dir if not pathlib.Path(args.md_dir).is_absolute() else pathlib.Path(args.md_dir)
    out_dir = HERE / args.out if not pathlib.Path(args.out).is_absolute() else pathlib.Path(args.out)

    if not md_dir.exists():
        md_dir.mkdir(parents=True, exist_ok=True)
        print(f"📁 md 폴더를 만들었습니다: {md_dir}")
        print("   팀원에게 받은 .md 파일을 여기에 넣고 다시 실행하세요.")
        return

    files = sorted(p for p in md_dir.glob("*.md") if p.name.lower() != "readme.md")
    if not files:
        print(f"❌ {md_dir} 에 .md 파일이 없습니다.")
        print("   팀원에게 받은 수집 파일을 여기에 넣으세요.")
        return

    tl = tr = tp = 0
    for f in files:
        n_listing, n_review, n_policy = convert(f, out_dir, args.site)
        if n_listing == 0:
            print(f"  ⚠️ {f.name} — 리뷰를 못 찾았습니다. '## 리뷰 파트' 제목과 "
                  f"'[1] 숙소: …' / '리뷰: \"…\"' 형식인지 확인하세요.")
            continue
        print(f"  ✅ {f.name} → 숙소 {n_listing}곳 · 리뷰 {n_review}건 · 약관 {n_policy}건")
        tl += n_listing; tr += n_review; tp += n_policy

    print()
    print(f"📦 {out_dir} 에 저장 — 숙소 {tl}곳 · 리뷰 {tr}건 · 약관 {tp}건")
    print("   → 다음: python analyze.py")


if __name__ == "__main__":
    main()
