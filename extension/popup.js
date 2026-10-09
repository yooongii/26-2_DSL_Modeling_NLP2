// 툴바 아이콘 팝업 — 브리핑 카드의 "☆ 저장" 버튼으로 담은 숙소 목록.
// 데이터는 briefing.js 가 chrome.storage.local["cc_saved_stays"] 에 쌓는 스냅샷 배열이다.
(function () {
  const SAVED_KEY = "cc_saved_stays";
  const SORT_KEY = "cc_popup_sort";

  const listEl = document.getElementById("list");
  const countEl = document.getElementById("count");
  const sortEl = document.getElementById("sort");

  // 카드의 ☰ 버튼이 이 페이지를 iframe(?embed=1)으로 띄울 때 — 닫기 버튼을 달고 부모 페이지에 알린다.
  if (new URLSearchParams(location.search).has("embed")) {
    const close = el("button", "close", "×");
    close.title = "닫기";
    close.addEventListener("click", () => parent.postMessage({ type: "cc-close-saved" }, "*"));
    document.querySelector(".title").appendChild(close);
    document.body.classList.add("embed");
  }

  let items = [];
  let sortBy = "price";
  try { sortBy = localStorage.getItem(SORT_KEY) || "price"; } catch (e) {}

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtWon(n) {
    return n.toLocaleString("ko-KR") + "원";
  }

  function fmtStay(s) {
    if (!s.checkin) return null;
    const { year, month, day } = s.checkin;
    let text = `${month}/${day}`;
    if (s.nights) {
      const out = new Date(year, month - 1, day + s.nights);
      text += ` ~ ${out.getMonth() + 1}/${out.getDate()} · ${s.nights}박`;
    }
    return text;
  }

  // "신라스테이 광화문 (Shilla Stay Gwanghwamun)" → 한글 메인 / 영문 보조.
  // 괄호 순서가 반대인 경우도 받는다. 한글이 없으면 전체를 메인으로 둔다.
  const HANGUL = /[가-힣]/;
  function splitName(name) {
    const m = (name || "").match(/^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/);
    if (m) {
      const [, a, b] = m;
      if (HANGUL.test(a) && !HANGUL.test(b)) return { main: a, sub: b };
      if (HANGUL.test(b) && !HANGUL.test(a)) return { main: b, sub: a };
    }
    return { main: name || "이름 없는 숙소", sub: null };
  }

  // 사이트 이름 → 점 색 클래스. s.site 는 briefing.js 가 저장하는 표시 이름("아고다" 등)이다.
  function siteClass(name) {
    if (/아고다|agoda/i.test(name)) return "agoda";
    if (/트립|trip/i.test(name)) return "tripcom";
    if (/부킹|booking/i.test(name)) return "booking";
    return "";
  }

  // 무료취소 마감 — 예전에 저장한 항목엔 cancelDeadline 이 없어 "M/D까지" 문구에서 복원한다.
  function deadlineOf(s) {
    const d = s.cancelDeadline;
    if (d) return new Date(d.year, d.month - 1, d.day);
    const m = s.cancelLabel?.match(/(\d+)\/(\d+)까지/);
    if (!m) return null;
    const year = s.checkin?.year ?? new Date().getFullYear();
    return new Date(year, +m[1] - 1, +m[2]);
  }

  function daysUntil(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((date - today) / 86400000);
  }

  // D-day 칩 — 색이 곧 의미: 초록=여유, 노랑=3일 이하, 빨강=환불 불가·마감 지남, 회색=모름.
  function cancelInfo(s) {
    const status = s.cancelStatus ?? (s.cancelLabel?.includes("무료취소") ? "free" : s.cancelLabel === "환불 불가" ? "nonrefundable" : null);
    if (status === "nonrefundable") return { tone: "risk", chip: "환불 불가", note: null };
    if (status !== "free") return { tone: "gray", chip: "취소 조건 확인 필요", note: null };
    const dl = deadlineOf(s);
    if (!dl) return { tone: "safe", chip: "무료취소 가능", note: null };
    const days = daysUntil(dl);
    const date = `${dl.getMonth() + 1}/${dl.getDate()}까지`;
    if (days < 0) return { tone: "risk", chip: "무료취소 마감됨", note: `${date}였어요` };
    return {
      tone: days <= 3 ? "warn" : "safe",
      chip: days === 0 ? "무료취소 D-DAY" : `무료취소 D-${days}`,
      note: date,
    };
  }

  function sorted(list) {
    const copy = [...list];
    if (sortBy === "recent") return copy.sort((a, b) => b.savedAt - a.savedAt);
    // 가격순 — 가격을 못 읽은 항목은 맨 뒤
    return copy.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || b.savedAt - a.savedAt);
  }

  function remove(key) {
    chrome.storage.local.get([SAVED_KEY], (r) => {
      const next = (r[SAVED_KEY] ?? []).filter((s) => s.key !== key);
      chrome.storage.local.set({ [SAVED_KEY]: next });
    });
  }

  function renderItem(s, minPrice) {
    const li = el("li", "item");
    const isBest = minPrice != null && s.price === minPrice;
    if (isBest) li.classList.add("best");

    const { main, sub } = splitName(s.name);
    const nameEl = el("div", "name", main);
    nameEl.title = s.name;
    li.appendChild(nameEl);
    if (sub) li.appendChild(el("div", "en", sub));

    // 사이트는 색 점 + 이름, 뒤에 일정. 사이트 이름 문구로 점 색을 고른다(모르는 사이트는 회색 점).
    const meta = el("div", "meta");
    if (s.site) meta.appendChild(el("span", `site ${siteClass(s.site)}`, s.site));
    const stay = fmtStay(s);
    if (s.site && stay) meta.appendChild(el("span", "sep", "·"));
    if (stay) meta.appendChild(el("span", null, stay));
    li.appendChild(meta);

    // 가격 줄 — 가격은 왼쪽, 최저가 배지/최저가와의 차액은 오른쪽. "저장 당시 · 세금 포함"은
    // 한 줄 아래로 내려 가격 줄이 좁은 팝업 폭에서 넘치지 않게 한다.
    const priceRow = el("div", "price-row");
    if (s.price != null) {
      priceRow.appendChild(el("span", "price", fmtWon(s.price)));
      if (isBest) {
        priceRow.appendChild(el("span", "badge", "최저가"));
      } else if (minPrice != null) {
        const diff = el("span", "diff", `+${fmtWon(s.price - minPrice)}`);
        diff.appendChild(el("small", null, "최저가 대비"));
        priceRow.appendChild(diff);
      }
      li.appendChild(priceRow);
      li.appendChild(el("div", "price-note", "저장 당시 · 세금 포함"));
    } else {
      priceRow.appendChild(el("span", "price-note", "가격 정보 없음"));
      li.appendChild(priceRow);
    }

    const c = cancelInfo(s);
    const cancel = el("div", "cancel");
    cancel.appendChild(el("span", `chip ${c.tone}`, c.chip));
    if (c.note) cancel.appendChild(el("span", null, c.note));
    li.appendChild(cancel);

    // 리뷰 기반 추가비용 가능성 — 가격과 합치지 않고 따로 보여준다.
    if (s.reviewNotes?.length) {
      const box = el("div", "reviews");
      box.appendChild(el("b", null, "리뷰에서 확인할 점 "));
      box.appendChild(document.createTextNode(s.reviewNotes.join(" / ")));
      li.appendChild(box);
    }

    const go = el("button", "go", `${s.site} 예약 페이지로 돌아가기 →`);
    go.addEventListener("click", () => chrome.tabs.create({ url: s.url }));
    li.appendChild(go);

    const del = el("button", "del", "×");
    del.title = "목록에서 삭제";
    del.setAttribute("aria-label", `${main} 목록에서 삭제`);
    del.addEventListener("click", () => remove(s.key));
    li.appendChild(del);
    return li;
  }

  function render() {
    listEl.replaceChildren();
    countEl.hidden = !items.length;
    countEl.textContent = `${items.length}곳`;
    sortEl.hidden = items.length < 2;
    sortEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sortBy));

    if (!items.length) {
      const empty = el("li", "empty");
      empty.innerHTML =
        '<div class="star">☆</div><b>아직 저장한 숙소가 없어요</b><br>' +
        "아고다·트립닷컴·부킹닷컴 숙소 페이지의<br>브리핑 카드에서 <b>☆ 저장</b>을 눌러 보세요.";
      listEl.appendChild(empty);
      return;
    }
    // 최저가 비교는 가격 있는 항목이 2곳 이상일 때만
    const prices = items.map((s) => s.price).filter((p) => p != null);
    const minPrice = prices.length >= 2 ? Math.min(...prices) : null;
    sorted(items).forEach((s) => listEl.appendChild(renderItem(s, minPrice)));
  }

  sortEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    sortBy = b.dataset.sort;
    try { localStorage.setItem(SORT_KEY, sortBy); } catch (err) {}
    render();
  });

  chrome.storage.local.get([SAVED_KEY], (r) => {
    items = r[SAVED_KEY] ?? [];
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SAVED_KEY]) return;
    items = changes[SAVED_KEY].newValue ?? [];
    render();
  });
})();
