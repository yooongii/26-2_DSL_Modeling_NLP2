# -*- coding: utf-8 -*-
"""
rules_en.py — analyze.py 영어판 키워드/단서 세트.

analyze.py 의 한국어 상수와 1:1 대응한다. 갈아끼워 쓰면 된다.
fee_type 키는 한국어판과 동일하게 유지했다 — 두 언어 결과를 같은 표에서 합치기 위해서다.
"""
import re

FEE_KEYWORDS_EN = {
    "주차":        ["parking fee", "parking charge", "self-parking", "self parking",
                    "valet parking", "valet fee", "overnight parking", "parking"],
    "리조트피":     ["resort fee", "resort charge", "destination fee", "amenity fee",
                    "facility fee"],
    "보증금":       ["security deposit", "incidental deposit", "deposit hold",
                    "hold on my card", "authorization hold", "deposit"],
    "도시세":       ["city tax", "tourist tax", "occupancy tax", "tourism fee",
                    "local tax", "visitor levy"],
    "청소비":       ["cleaning fee", "housekeeping fee"],
    "조식":         ["breakfast buffet", "continental breakfast", "breakfast"],
    "인원추가":     ["extra person", "additional guest", "per person charge",
                    "extra guest fee", "third person"],
    "세금수수료":   ["taxes and fees", "tax and fees", "service charge", "surcharge",
                    "booking fee", "resort tax", "tax", "fees"],
    "기타현장결제": ["charged at check-in", "charged on arrival", "pay at the property",
                    "paid on site", "pay on arrival", "charged at the front desk"],
}

# 추가비용이 '실제로 발생했다'는 쪽 단서 (한국어판 COST_CUE 대응)
COST_CUE_EN = [
    "not included", "not inclusive", "excluded", "on top of", "in addition to",
    "extra", "additional", "separate", "separately", "surcharge", "hidden",
    "charged", "charge", "charges", "billed", "they charged",
    "had to pay", "have to pay", "must pay", "required to pay", "made us pay",
    "paid extra", "cost us", "per night", "per day", "per person",
    "added to", "tacked on", "upcharge", "mandatory", "non-optional",
    "$", "usd", "eur", "gbp",
]

# 오히려 '무료였다'는 쪽 단서 (한국어판 NEG_CUE 대응)
NEG_CUE_EN = [
    "free", "complimentary", "no charge", "no fee", "no extra", "no additional",
    "at no cost", "included", "inclusive", "was included", "comes with",
    "provided", "on the house", "waived", "did not charge", "didn't charge",
    "no hidden", "without any charge", "gratis",
]

CLAIM_TO_FEE_EN = {
    "free parking": "주차", "parking is free": "주차", "complimentary parking": "주차",
    "breakfast included": "조식", "free breakfast": "조식", "complimentary breakfast": "조식",
    "taxes and fees included": "세금수수료", "tax included": "세금수수료",
    "no extra charges": None,
}

AMENITY_TYPES_EN = {"조식", "주차", "세금수수료"}

# 편의시설 이름만 나온 문장을 거르는 게이트 (한국어판 COST_CONTEXT_RE 대응)
COST_CONTEXT_RE_EN = re.compile(
    r"fee|charge|charged|price|cost|pay|paid|billed|deposit|surcharge"
    r"|free|complimentary|included|extra|additional|separate|per night|per day"
    r"|[$\u20ac\u00a3]\s*\d|\d+\s*(?:usd|eur|gbp|dollars?|euros?)",
    re.IGNORECASE,
)

# 영어 문장 분리 — 약어(Mr. / U.S. / a.m.) 뒤에서 자르지 않는다.
SENT_SPLIT_EN = re.compile(
    r"(?<!\bMr)(?<!\bMrs)(?<!\bMs)(?<!\bDr)(?<!\bSt)(?<!\bJr)(?<!\bSr)"
    r"(?<!\bvs)(?<!\betc)(?<!\ba\.m)(?<!\bp\.m)(?<!\bU\.S)"
    r"(?<=[.!?])\s+(?=[A-Z\"'(])|\n+"
)

HOTEL_REPLY_RE_EN = re.compile(
    r"thank you for (?:your (?:review|stay|feedback)|choosing|taking the time)"
    r"|we (?:appreciate|value) your (?:feedback|review|comments)"
    r"|we (?:hope|look forward) to (?:welcome|see|serve) you"
    r"|(?:general manager|guest relations|front office manager)"
    r"|on behalf of (?:the|our) (?:entire )?team",
    re.IGNORECASE,
)

# 창 크기 — 영어는 한 단어가 길어 한국어(25자)보다 넓게 잡는다.
WINDOW_EN = 60
