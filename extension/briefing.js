// 예약 브리핑 카드 (A) — v3. "결론 → 핵심 리스크 → 더 나은 선택" 3블록으로 단순화하고,
// 취소 조건을 서술문이 아니라 실제 원화 손실액으로 계산해서 보여준다.
//
// v2에서 바뀐 점:
// 1. cancellation.js가 이제 "언제부터 몇 %를 잃는지" 계단식 구간(lossSteps)을 준다 —
//    여기서 현재 가격을 곱해 "오늘 취소 시 X원", "M/D부터 Y원"을 계산한다.
// 2. 포커스 카드에 히스테리시스를 넣었다 — 뷰포트 경계 근처에서 두 카드가 거의 동시에
//    "제일 가깝다"고 판정되며 초록↔빨강이 튀는 걸 막기 위해, 기존 포커스가 아직 화면에
//    보이는 한 계속 유지한다.
// 3. 다른 요금제 추천을 "같은 방(roomLabel)·같은 인원(occupancy)"인지로 강도를 나눈다 —
//    조건이 같으면 "무료취소로 바꾸세요"처럼 강하게, 다르면 "다른 저렴한 옵션이 있어요"
//    정도로만 표현한다(조건이 다른데 "더 나은 선택"이라 단정하지 않는다).
// 4. UI를 결론/핵심 리스크/더 나은 선택 3블록으로 재편 — 원문은 "왜 이런 판단인가?" 토글
//    뒤로 내렸다. 신호등은 가격·취소조건의 확실성만으로 정한다.
//
// v3.1: 다크패턴 탐지(Track4)를 별도 기능으로 완전히 분리했다 — 두 개의 기능처럼 보이는
// 걸 막기 위함. 관련 코드(rules.js/background.js/sidepanel.*, content.js의 판정 로직)는
// 이 저장소에서 제거했고 로컬에만 보관 중이다.

(function () {
  const LIGHT_COLOR = { green: "#1ea03c", yellow: "#d99400", red: "#e61e1e", gray: "#999" };

  // ── 실패 격리 ────────────────────────────────────────────────────────────
  // pricing.js / cancellation.js 는 실제 아고다 DOM을 읽는다. 사이트가 레이아웃을 바꾸면
  // 이 중 한 함수가 던질 수 있는데, 그때 브리핑 전체가 사라지면 사용자는 확장이 죽은 걸로
  // 본다. 호출을 하나씩 감싸서 "그 항목만" 비우고 나머지는 계속 그린다.
  // 같은 지점의 실패는 한 번만 경고한다 — 스캔이 자주 돌아서 콘솔이 넘친다.
  const reportedFailures = new Set();
  function safely(label, thunk, fallback) {
    try {
      const v = thunk();
      return v === undefined ? fallback : v;
    } catch (e) {
      if (!reportedFailures.has(label)) {
        reportedFailures.add(label);
        console.warn(`[cc] ${label} 실패 — 이 항목만 건너뜁니다:`, e);
      }
      return fallback;
    }
  }

  // 취소조건이 실패했을 때 쓸 빈 요약. lossSteps 순회 등 하위 렌더가 깨지지 않도록
  // cancellation.js의 EMPTY_SUMMARY와 같은 모양이어야 한다. 그 모듈이 아예 안 떴을
  // 경우를 대비해 같은 모양을 여기에도 둔다.
  const EMPTY_CANCELLATION = Object.freeze({
    status: "none", deadline: null, penaltyNote: null, lossSteps: [],
    noShowNote: null, noShowPenalty: null, raw: null, node: null,
  });
  const emptyCancellation = () => ({ ...(window.__ccCancellation?.EMPTY_SUMMARY ?? EMPTY_CANCELLATION) });

  // 취소조건 설명이 실패했을 때의 표시. 근거 없이 단정하지 않는다는 원칙에 맞춰
  // 회색 신호등 + "찾지 못했다"로만 말한다.
  const UNKNOWN_CANCELLATION_DESC = Object.freeze({
    light: "gray",
    headline: "정보를 찾지 못했어요",
    detail: "이 요금제의 취소 조건을 읽어내지 못했어요 — 원문을 직접 확인하세요.",
    raw: null,
  });

  // content_scripts 순서가 어긋나거나 한 파일이 로드 중 던지면 window.__ccPricing 자체가
  // 없다. safely()가 전부 fallback을 주므로 카드는 계속 그려지지만, 원인을 모르면
  // 디버깅이 어려우니 한 번은 분명히 알린다.
  let moduleWarned = false;
  function warnIfModulesMissing() {
    if (moduleWarned) return;
    const missing = [];
    if (!window.__ccPricing?.findAllRelevantBlocks) missing.push("pricing.js");
    if (!window.__ccCancellation?.buildCancellationSummary) missing.push("cancellation.js");
    if (!missing.length) return;
    moduleWarned = true;
    console.warn(`[cc] ${missing.join(", ")} 가 로드되지 않았습니다 — manifest.json의 content_scripts 순서를 확인하세요.`);
  }

  // ── 저장소 ───────────────────────────────────────────────────────────────
  // chrome.storage.local 을 쓴다. content script에서 부르는 localStorage는 아고다
  // 오리진의 것이라 (1) 사용자가 사이트 데이터를 지우면 날아가고 (2) 우리가 남의 사이트
  // 저장소에 쓰게 되며 (3) 탭·도메인 사이에 공유되지 않는다.
  // 비동기라 읽기는 콜백으로 받고, 확장이 리로드되어 컨텍스트가 끊기면 호출 자체가
  // 던지므로 전부 감싼다.
  const ccStorage = {
    get(key, cb) {
      try {
        chrome.storage.local.get([key], (r) => {
          if (chrome.runtime.lastError) return cb(null);
          cb(r?.[key] ?? null);
        });
      } catch (e) { cb(null); }
    },
    set(key, value) {
      try { chrome.storage.local.set({ [key]: value }, () => void chrome.runtime.lastError); } catch (e) {}
    },
    // 다른 탭에서 값이 바뀌면 알려준다. 이게 없으면 복원이 content script 초기화 때
    // 한 번만 일어나서, 드래그하기 전에 이미 열려 있던 탭은 끝까지 옛 자리에 머문다.
    onChange(key, cb) {
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[key]) return;
          cb(changes[key].newValue ?? null);
        });
      } catch (e) {}
    },
  };

  // ── 저장한 숙소 ─────────────────────────────────────────────────────────
  // 카드 헤더의 ☆ 버튼으로 담고, 툴바 아이콘 팝업(popup.html)에서 목록으로 본다.
  // 저장 시점의 스냅샷이다 — 가격·취소조건은 나중에 바뀔 수 있으니 팝업에서 "저장 당시"로 표기한다.
  // 리뷰 기반 추가비용은 절대 원칙대로 가격에 합치지 않고 별도 문구(reviewNotes)로만 담는다.
  const SAVED_KEY = "cc_saved_stays";

  // 같은 숙소라도 날짜가 다르면 다른 항목으로 본다(가격·취소조건이 날짜마다 다르다).
  function savedStayKey(doc, dateContext) {
    const site = safely("sites.current", () => window.__ccSites?.current(), null);
    const hid = safely("sites.hotelId", () => site?.hotelId?.(doc), null);
    const ci = dateContext?.checkin;
    const ciStr = ci ? `${ci.year}-${ci.month}-${ci.day}` : "";
    return `${site?.id ?? location.hostname}:${hid ?? location.pathname}:${ciStr}`;
  }

  // 숙소 이름 — 사이트마다 제목 노드가 달라 h1 → og:title → document.title 순으로 본다.
  function extractStayName(doc) {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const h1 = clean(doc.querySelector("h1")?.innerText);
    if (h1 && h1.length <= 120) return h1;
    const og = clean(doc.querySelector('meta[property="og:title"]')?.content);
    const raw = og || clean(doc.title);
    // "호텔명 - 아고다", "호텔명 | Booking.com" 처럼 뒤에 붙은 사이트명을 떼어낸다
    return raw.split(/\s[-|–·]\s/)[0].slice(0, 120) || "이름 없는 숙소";
  }

  // 무료취소 마감을 날짜로 — 팝업이 D-day를 계산한다. cancellation.deadline 은
  // formatDeadline()의 세 형태("YYYY년 M월 D일 …" / "체크인 N일 전" / "M월 D일") 중 하나.
  function resolveCancelDeadline(cancellation, checkin) {
    const d = cancellation?.status === "free" ? cancellation.deadline : null;
    if (!d) return null;
    const toYmd = (dt) => ({ year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate() });
    let m = d.match(/(\d{4})년\s*(\d+)월\s*(\d+)일/);
    if (m) return { year: +m[1], month: +m[2], day: +m[3] };
    m = d.match(/체크인\s*(\d+)일\s*전/);
    if (m && checkin) return toYmd(new Date(checkin.year, checkin.month - 1, checkin.day - +m[1]));
    m = d.match(/(\d+)월\s*(\d+)일/);
    if (m) {
      // 연도 없는 날짜 — 체크인보다 늦은 달이면 전년도(12월 마감 · 1월 체크인)
      const base = checkin ?? toYmd(new Date());
      const year = +m[1] > base.month ? base.year - 1 : base.year;
      return { year, month: +m[1], day: +m[2] };
    }
    return null;
  }

  function buildSavedEntry({ doc, finalPrice, cancellation, verdict, hiddenCost, reviewRisks }) {
    const dateContext = safely("cancellation.buildDateContext", () => window.__ccCancellation.buildDateContext(doc), null);
    const site = safely("sites.current", () => window.__ccSites?.current(), null);
    const ci = dateContext?.checkin;
    const reviewNotes = [
      ...(hiddenCost?.warnings ?? []).map((w) => `${w.label} · 리뷰 ${w.count}건`),
      ...(reviewRisks ?? []).map((r) => `${r.label} · 리뷰 ${r.negativeCount}건`),
    ].slice(0, 3);
    return {
      key: savedStayKey(doc, dateContext),
      name: extractStayName(doc),
      site: site?.displayName ?? location.hostname,
      url: location.href,
      checkin: ci ? { year: ci.year, month: ci.month, day: ci.day } : null,
      nights: dateContext?.nights ?? null,
      price: finalPrice?.amount ?? null,
      cancelLabel: cancellation ? miniCancelLabel(cancellation) : null,
      cancelStatus: cancellation?.status ?? null,
      cancelDeadline: resolveCancelDeadline(cancellation, ci),
      light: verdict?.light ?? "gray",
      headline: verdict?.headline ?? null,
      reviewNotes,
      savedAt: Date.now(),
    };
  }

  // ── 무료취소 마감 → 캘린더 ──────────────────────────────────────────────
  // 무료취소 마감을 잊어서 돈을 잃는 게 이 확장이 막으려는 사고라, 카드가 보여주는 마감을 일정으로 넘긴다.
  //  · .ics 다운로드 — 브라우저 안에서만 만든다(구글·애플·네이버·아웃룩 공통). 새 권한이 필요 없다.
  //  · 구글 캘린더 링크 — 사용자가 누를 때만 새 탭으로 열리고, 그때 숙소명·마감일·설명이 구글로 넘어간다
  //    (개인정보처리방침에 명시). 이 링크는 알림 시점을 지정할 수 없어 구글의 기본 알림을 따른다.
  // 종일 일정으로 마감 "날짜"에 넣는다. 트립닷컴처럼 원문에 시각(23:59)이 있어도 호텔 현지시간이라
  // 호텔 시간대를 모르는 우리가 캘린더 시각으로 옮기면 틀어질 수 있어, 시각은 설명란에만 적는다.
  // 카드가 마감을 확실히 읽은 무료취소(status free + 날짜 해석 성공 + 아직 안 지남)에만 만든다 —
  // 알림은 사용자가 믿고 행동하는 정보라 카드에 표시하는 것보다 틀렸을 때 손해가 크다.
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymdCompact = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

  function buildCalendarEvent({ doc, cancellation, lossProjection, finalPrice }) {
    if (cancellation?.status !== "free") return null;
    const dateContext = safely("cancellation.buildDateContext", () => window.__ccCancellation.buildDateContext(doc), null);
    const ymd = resolveCancelDeadline(cancellation, dateContext?.checkin);
    if (!ymd) return null;
    const last = new Date(ymd.year, ymd.month - 1, ymd.day);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (last < todayStart) return null; // 이미 지난 마감

    const site = safely("sites.current", () => window.__ccSites?.current(), null);
    const name = extractStayName(doc);
    const time = (cancellation.deadline || "").match(/(\d{1,2}):(\d{2})/);
    const ci = dateContext?.checkin;
    const lines = [
      `숙소: ${name}${site?.displayName ? ` (${site.displayName})` : ""}`,
      ci ? `체크인: ${ci.month}월 ${ci.day}일${dateContext.nights ? ` · ${dateContext.nights}박` : ""}` : null,
      `무료취소 마감: ${ymd.year}년 ${ymd.month}월 ${ymd.day}일${time ? ` ${pad2(time[1])}:${time[2]} (호텔 현지시간 기준)` : ""}까지`,
    ];
    const nx = lossProjection?.next;
    if (nx) {
      const what = nx.usesFirstNight
        ? `첫 1박 요금${nx.amount != null ? ` 약 ${fmtWon(nx.amount)}` : ""}`
        : nx.amount != null
        ? `약 ${fmtWon(nx.amount)}`
        : nx.percent != null
        ? `약 ${nx.percent}%`
        : "";
      lines.push(`마감 이후: ${nx.date}부터 위약금${what ? ` ${what}` : ""}`);
    }
    if (finalPrice?.amount) lines.push(`예약 금액: ${fmtWon(finalPrice.amount)} (세금·수수료 포함)`);
    lines.push("※ 예약 조건은 바뀔 수 있어요. 정확한 마감은 예약 페이지의 취소 정책 원문으로 꼭 확인하세요.");
    return {
      uid: `cc-${hashString(`${savedStayKey(doc, dateContext)}|${ymdCompact(last)}`)}@clearbooking`,
      name,
      title: `무료취소 마감 — ${name}`,
      start: last,
      end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
      description: lines.filter(Boolean).join("\n"),
      url: location.href,
    };
  }

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // RFC 5545: TEXT 는 \ ; , 줄바꿈을 이스케이프하고, 한 줄은 75옥텟을 넘기면 접는다(UTF-8 글자 중간에서 자르지 않는다).
  const icsEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  function icsFold(line) {
    const enc = new TextEncoder();
    let out = "", bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 75) { out += "\r\n "; bytes = 1; }
      out += ch;
      bytes += b;
    }
    return out;
  }

  function buildIcs(ev) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ClearBooking//Free Cancellation Deadline//KO",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymdCompact(ev.start)}`,
      `DTEND;VALUE=DATE:${ymdCompact(ev.end)}`,
      `SUMMARY:${icsEscape(ev.title)}`,
      `DESCRIPTION:${icsEscape(ev.description)}`,
      `URL:${ev.url}`,
      // 종일 일정의 시작(0시) 기준 -15시간 = 마감 하루 전 오전 9시
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape("무료취소 마감이 내일이에요 — " + ev.name)}`,
      "TRIGGER:-PT15H",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }

  function downloadIcs(ev) {
    const blob = new Blob([buildIcs(ev)], { type: "text/calendar;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `무료취소마감_${ev.name.replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60)}.ics`;
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
  }

  // 한글은 주소에서 글자당 9자(%XX×3)로 늘어난다 — 설명을 그대로 넣으면 금세 만 자를 넘긴다.
  // 주소 전체를 예산 안에 두고, 중요한 줄부터 넣다가 넘치면 멈춘다. 예약 페이지 주소는 맨 끝(가장
  // 덜 중요, 사용자는 이미 그 페이지에 있다)에 두고 예산이 남을 때만 붙인다.
  const GOOGLE_URL_BUDGET = 3500;
  function googleCalendarUrl(ev) {
    const base = "https://calendar.google.com/calendar/render?";
    const fixed = { action: "TEMPLATE", text: ev.title, dates: `${ymdCompact(ev.start)}/${ymdCompact(ev.end)}` };
    const build = (details) => base + new URLSearchParams({ ...fixed, details }).toString();
    const parts = [...ev.description.split("\n"), ev.url];
    let details = "";
    for (const part of parts) {
      const next = details ? `${details}\n${part}` : part;
      if (build(next).length > GOOGLE_URL_BUDGET) continue; // 이 줄만 건너뛰고 뒤의 짧은 줄은 계속 시도
      details = next;
    }
    return build(details);
  }

  // 카드 헤더 ☰ → 저장 목록 창. 툴바 팝업을 페이지 버튼으로 직접 여는 chrome.action.openPopup 은
  // 크롬 버전·포커스 조건에 따라 실패할 수 있어, 같은 popup.html 을 iframe 으로 카드 옆에 띄운다.
  let savedPanelEl = null;

  function placeSavedPanel() {
    if (!savedPanelEl) return;
    const W = 360, GAP = 10, M = 8;
    const H = savedPanelEl.getBoundingClientRect().height;
    const r = cardEl?.isConnected ? cardEl.getBoundingClientRect() : null;
    let left, top;
    if (r && r.left - W - GAP >= M) left = r.left - W - GAP;            // 카드 왼쪽
    else if (r && r.right + GAP + W <= innerWidth - M) left = r.right + GAP; // 카드 오른쪽
    else left = Math.max(M, (innerWidth - W) / 2);                        // 자리 없으면 가운데
    top = r ? r.top : (innerHeight - H) / 2;
    top = Math.min(Math.max(M, top), Math.max(M, innerHeight - H - M));
    savedPanelEl.style.left = `${Math.round(left)}px`;
    savedPanelEl.style.top = `${Math.round(top)}px`;
  }

  function closeSavedPanel() {
    savedPanelEl?.remove();
    savedPanelEl = null;
    document.querySelector("#cc-briefing-wrap #cc-list")?.classList.remove("on");
  }

  function openSavedPanel() {
    const src = extensionUrl("popup.html?embed=1");
    if (!src) return; // 확장이 리로드돼 컨텍스트가 끊긴 경우
    ensureBriefingStyle();
    savedPanelEl = document.createElement("div");
    savedPanelEl.id = "cc-saved-panel";
    savedPanelEl.className = "cc-ui";
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.title = "저장한 숙소";
    savedPanelEl.appendChild(frame);
    document.body.appendChild(savedPanelEl);
    placeSavedPanel();
    document.querySelector("#cc-briefing-wrap #cc-list")?.classList.add("on");
  }

  function toggleSavedPanel() {
    if (savedPanelEl) closeSavedPanel();
    else openSavedPanel();
  }

  // ☰ — 우선 진짜 툴바 팝업을 연다(popup-opener.js). 크롬이 거절하면 카드 옆 창으로 대신.
  function openSavedList() {
    if (savedPanelEl) return closeSavedPanel();
    try {
      chrome.runtime.sendMessage({ type: "cc-open-popup" }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          if (debugOn()) console.log("[cc] 툴바 팝업 열기 실패 → 카드 옆 창으로 대체", chrome.runtime.lastError?.message ?? res?.error);
          openSavedPanel();
        }
      });
    } catch (e) {
      openSavedPanel(); // 확장 리로드로 컨텍스트가 끊긴 경우엔 이것도 조용히 실패한다
    }
  }

  // 닫기: iframe 안의 × (postMessage) · Esc · 창과 카드 바깥 클릭
  window.addEventListener("message", (e) => {
    if (e.data?.type !== "cc-close-saved") return;
    const origin = extensionUrl("")?.replace(/\/$/, "");
    if (origin && e.origin === origin) closeSavedPanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && savedPanelEl) closeSavedPanel();
  });
  document.addEventListener("mousedown", (e) => {
    if (!savedPanelEl) return;
    if (e.target.closest?.("#cc-saved-panel, #cc-briefing-wrap")) return;
    closeSavedPanel();
  }, true);
  window.addEventListener("resize", placeSavedPanel);

  function paintSaveButton(btn, saved) {
    btn.classList.toggle("on", saved);
    btn.innerHTML = saved ? `<span class="cc-star">★</span>저장됨` : `<span class="cc-star">☆</span>저장`;
    btn.title = saved ? "저장 취소" : "이 숙소 저장 — 툴바 아이콘을 눌러 목록을 볼 수 있어요";
  }

  function fmtWon(n) {
    return n.toLocaleString("ko-KR") + "원";
  }
  function fmtMD(d) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  // 디버그 로그 전용 — toISOString()은 UTC로 바꿔 찍어서, 로컬 자정(예: KST 0시)의 날짜가
  // 하루 당겨 보이는 혼란을 준다(실측: 원인 추적 중 실제로 헷갈렸다). 로컬 기준 YYYY-MM-DD.
  function fmtLocalISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  // ---- 아이콘/상태 표시 ---------------------------------------------------------
  // 💸📉📌 같은 이모지와 🔴🟡🟢 신호등이 뒤섞이면 디자인 언어가 통일되지 않아 프로토타입
  // 처럼 보인다(사장님 지적). 이모지를 완전히 없애는 대신 한 종류의 line icon(Lucide류
  // 스타일 — 얇은 선, 둥근 끝, 단색)으로 통일하고, 색은 상태(초록/주황/빨강)에만 쓴다.
  // 빌드 스텝이 없는 순수 JS 확장이라 아이콘 라이브러리를 번들링하는 대신, 같은 시각
  // 언어(24×24, stroke-width 2, currentColor)로 직접 그린 최소 SVG 세트를 쓴다.
  function icon(name, opts) {
    const size = opts?.size ?? 14;
    const color = opts?.color ?? "currentColor";
    const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"`;
    const paths = {
      card: `<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>`,
      warning: `<path d="M12 3 L22 20 L2 20 Z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17.01"/>`,
      calendar: `<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>`,
      sparkle: `<path d="M12 3 L14 10 L21 12 L14 14 L12 21 L10 14 L3 12 L10 10 Z"/>`,
      pin: `<circle cx="12" cy="9" r="5"/><line x1="12" y1="14" x2="12" y2="21"/>`,
      chevronDown: `<polyline points="6 9 12 15 18 9"/>`,
      arrowRight: `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>`,
    };
    return `<svg ${common}>${paths[name] ?? ""}</svg>`;
  }

  // 🔴🟡🟢 이모지 신호등 대신 쓰는 작은 상태 dot — 실제 SaaS 제품에 가까워 보이게 하기
  // 위함(사장님 제안). 색만 상태를 나타내고, 도형 자체는 항상 동일하다.
  function statusDot(light, opts) {
    const size = opts?.size ?? 8;
    return `<span style="display:inline-block; width:${size}px; height:${size}px; border-radius:50%; background:${LIGHT_COLOR[light] ?? "#999"}; flex-shrink:0;"></span>`;
  }

  // "총 금액" 라벨을 찾다 보면 "1박당 총 금액"까지 같이 걸린다 — 1박이면 그게 곧 전체
  // 결제액이라 문제없지만, 2박 이상이면 "총 금액"이라는 말과 달리 실제로는 1박치 가격이라
  // 최종 결제액을 실제보다 훨씬 적게 보여주게 된다(사장님 실측 확인). 체크인/체크아웃으로
  // 이미 계산해둔 박수(dateContext.nights)로 보정한다 — 1박당 가격인지는 매칭된 노드의
  // 원문에 "1박당"/"박당"이 실제로 있는지 확인해서 판단하고, 박수를 모르면(체크아웃 날짜를
  // 못 찾은 경우 등) 단정하지 않고 그대로 둔다.
  function correctForPerNightPrice(finalPrice, nights) {
    if (!finalPrice?.node) return finalPrice;
    const isPerNight = /1박당|박당/.test(finalPrice.node.innerText || "");
    if (!isPerNight || !nights || nights <= 1) return finalPrice;
    return { ...finalPrice, amount: finalPrice.amount * nights, perNightAmount: finalPrice.amount, nights };
  }

  // ---- 손실액 계산: cancellation.js의 lossSteps(퍼센트 또는 "첫 1박 요금") × 실제 가격 ----
  // usesFirstNight 구간은 퍼센트가 아니라 카드에 적힌 "1박당 총 금액"을 직접 쓴다 —
  // 숙박 일수로 (총액÷박수)를 역산하는 것보다 안정적이다(사장님 제안). 1박 요금을 못
  // 찾으면 그 구간의 금액은 null로 두고 "계산 불가"로 정직하게 표시한다(단정 금지).
  function resolveStepAmount(step, priceAmount, perNightAmount) {
    if (step.amount != null) return step.amount; // 원문이 금액을 직접 적은 사이트(Trip.com)
    if (step.usesFirstNight) return perNightAmount ?? null;
    return step.percent != null ? Math.round((priceAmount * step.percent) / 100) : null;
  }

  // 실측(2026-09-22): 예전엔 여기서 today/sd를 둘 다 자정으로 깎아 "날짜"만 비교했다.
  // 아고다의 thresholdDate는 항상 자정으로 만들어지므로(마감 "시각"을 애초에 안 읽는다)
  // 이 truncation은 아고다에는 있으나 마나였다 — "자정 기준 오늘 >= 자정 sd"와 "정확한
  // 지금 시각 >= 자정 sd"는 정확히 같은 순간(그 날 00:00:00)에 참이 된다.
  // 그런데 Trip.com처럼 마감에 실제 시각(예: 18:00)이 있는 사이트에서는 이 truncation이
  // "마감일 = 하루 종일 이미 위약금"으로 오판을 만들었다(실사용자 리포트: 22일 15시인데
  // "오늘 취소하면 손실" 표시). truncation을 없애고 정확한 시각으로 비교한다 — 아고다는
  // 위 이유로 동작이 그대로고, Trip.com은 18:00 전/후가 정확히 갈린다.
  function computeStepProjection(lossSteps, priceAmount, perNightAmount) {
    const today = new Date();
    let passedStep = null; // 지난 구간 중 가장 늦은(=심한) 것
    let nextStep = null;
    for (const s of lossSteps) {
      const sd = new Date(s.thresholdDate);
      if (today >= sd) passedStep = s;
      else if (!nextStep) nextStep = s;
    }
    const resolve = (s) => {
      if (!s) return null;
      const amount = resolveStepAmount(s, priceAmount, perNightAmount);
      // "첫 1박 요금"류는 원문에 퍼센트가 안 적혀 있지만, 실제 금액을 구했으면 그게 총
      // 결제액의 몇 %인지 역산해서 보여줄 수 있다 — "1박 요금 상당 · 총 결제액의 50%"처럼
      // 사용자가 그 금액의 의미(왜 그 액수인지)를 바로 이해하게 해준다(사장님 제안).
      const derivedPercent =
        (s.usesFirstNight || s.amount != null) && amount != null && priceAmount ? Math.round((amount / priceAmount) * 100) : null;
      return {
        date: fmtMD(new Date(s.thresholdDate)),
        percent: s.usesFirstNight ? null : s.percent,
        amount,
        usesFirstNight: !!s.usesFirstNight,
        derivedPercent,
      };
    };
    const passed = resolve(passedStep);
    const next = resolve(nextStep);
    return {
      hasPenaltyToday: !!passed, // 구간엔 들어섰는지(퍼센트/금액을 못 구했어도 이건 확실히 앎)
      todayPercent: passed?.percent ?? null, // "첫 1박 요금"류는 비율을 몰라 null일 수 있음
      todayAmount: passed ? passed.amount : 0, // 지난 구간 자체가 없으면 확실히 0원
      todayCertain: !passed || passed.amount != null, // 지난 구간은 있는데 금액을 못 구했으면 false
      todayUsesFirstNight: passed?.usesFirstNight ?? false,
      todayDerivedPercent: passed?.derivedPercent ?? null,
      next,
    };
  }

  /**
   * "오늘 취소하면 얼마 잃는지"를 계산한다. 확신 없이 숫자를 만들지 않는다 —
   * 계산할 근거(퍼센트+날짜, 또는 명백한 환불불가)가 없으면 null을 반환하고,
   * UI는 그 경우 "계산 불가 — 원문 확인"으로 정직하게 표시한다.
   */
  function buildLossProjection(cancellation, finalPrice, perNightPrice) {
    if (!finalPrice) return null;
    const price = finalPrice.amount;
    const perNight = perNightPrice?.amount ?? null;
    if (cancellation.status === "nonrefundable") {
      return { hasPenaltyToday: true, todayAmount: price, todayPercent: 100, todayCertain: true, next: null, certain: true };
    }
    if (cancellation.lossSteps.length) {
      const proj = computeStepProjection(cancellation.lossSteps, price, perNight);
      return { ...proj, certain: proj.todayCertain };
    }
    if (cancellation.status === "free") {
      // 마감일은 알지만 그 이후 정확한 퍼센트를 텍스트에서 못 뽑은 경우 — 오늘(마감 전)
      // 손실은 0원이라고 확신할 수 있지만, 이후 금액은 단정하지 않는다.
      return { hasPenaltyToday: false, todayAmount: 0, todayPercent: 0, todayCertain: true, next: null, certain: false };
    }
    return null; // collapsed / none / (lossSteps 없는) unclear — 계산 불가
  }

  /**
   * 취소 리스크 타임라인용 지점들 — [{label, amount, unresolved}]. 설명을 안 읽어도
   * "오늘 취소하면 얼마, 마감 넘기면 얼마"가 한눈에 보이게 하는 게 목적이다(사장님 제안,
   * "설명을 읽을 필요가 없어서 데모 효과가 좋다"). nonrefundable/lossSteps 없음 등
   * 계단식 구간이 아예 없으면 null을 반환하고, UI는 타임라인 자체를 숨긴다.
   */
  function buildTimelinePoints(cancellation, finalPrice, perNightPrice) {
    if (!finalPrice || !cancellation.lossSteps.length) return null;
    const price = finalPrice.amount;

    // 환불불가는 "언제부터" 손실이 시작되는 게 아니라 처음부터 끝까지 전액이다. 그런데
    // 단계 앵커가 체크인 날짜(미래)에 찍혀 있어서, 지난 구간만 누적하는 아래 로직으로는
    // "오늘 = 0원"이 나온다 — 헤드라인("지금 취소하면 전액을 잃어요")과 정면으로 모순된다
    // (실측 리포트 버그 1건). 전환점이 없는 유형이므로 평평한 선으로 그린다.
    if (cancellation.status === "nonrefundable") {
      const last = [...cancellation.lossSteps].sort((a, b) => a.thresholdDate - b.thresholdDate).pop();
      const end = last?.thresholdDate ? fmtMD(new Date(last.thresholdDate)) : "체크인";
      return [
        { label: "오늘", amount: price, unresolved: false },
        { label: end, amount: price, unresolved: false },
      ];
    }

    const perNight = perNightPrice?.amount ?? null;
    const sortedSteps = [...cancellation.lossSteps].sort((a, b) => a.thresholdDate - b.thresholdDate);

    // "오늘" 지점도 0원 고정이 아니라 이미 지난 구간이 있으면 그 손실액을 반영한다
    // (computeStepProjection의 passedStep 판단과 동일한 로직) — 마감을 이미 넘긴 상태에서
    // 타임라인을 열어도 "오늘 = 0원"이라고 거짓으로 보이면 안 되기 때문.
    // truncation을 없앤 이유는 computeStepProjection 쪽 주석 참고 — 아고다는 무해하고
    // Trip.com 같은 시각 포함 마감을 정확히 비교하기 위해서다.
    const today = new Date();
    let todayAmount = 0;
    let todayUnresolved = false;
    for (const step of sortedSteps) {
      const sd = new Date(step.thresholdDate);
      if (today < sd) break;
      const amount = resolveStepAmount(step, price, perNight);
      todayAmount = amount ?? todayAmount;
      todayUnresolved = amount == null;
    }

    // 점은 날짜순으로 놓고 "오늘"을 그 사이에 끼운다 — 예전엔 "오늘"을 항상 맨 앞에 두고
    // 이미 지난 구간(예: 9/22)을 그 뒤에 붙여서, 24일인데 "오늘 → 22일 → 26일"처럼 시간이
    // 거꾸로 읽혔다. 지난 구간은 오늘 앞에, 남은 구간은 오늘 뒤에 둔다.
    //  · 예약 즉시 적용 구간(immediate)과 오늘 날짜에 시작한 구간은 "오늘" 지점과 같은 값이라
    //    따로 점을 만들지 않고 오늘에 합친다.
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const points = [];
    let cumulative = 0;
    let todayPushed = false;
    const pushToday = () => {
      points.push({ label: "오늘", amount: todayAmount, unresolved: todayUnresolved });
      cumulative = todayAmount;
      todayPushed = true;
    };
    for (const step of sortedSteps) {
      const sd = new Date(step.thresholdDate);
      const isPast = today >= sd;
      if (!isPast && !todayPushed) pushToday();
      if (isPast && (step.immediate || sameDay(sd, today))) continue;
      const amount = resolveStepAmount(step, price, perNight);
      if (amount != null) cumulative = amount;
      points.push({ label: fmtMD(sd), amount: amount ?? cumulative, unresolved: amount == null });
    }
    if (!todayPushed) pushToday();
    return points;
  }

  // 가격·취소조건의 확실성만으로 신호등을 정한다 — 다크패턴 탐지 건수는 반영하지 않는다.
  // lossProjection.todayPercent는 "첫 1박 요금"류에서 null일 수 있어(비율은 몰라도 구간에는
  // 들어섰음을 앎), hasPenaltyToday를 신호등 판단 기준으로 쓴다 — todayPercent > 0 비교만
  // 쓰면 이런 경우 손실이 있는데도 초록불로 잘못 뜬다.
  // headline과 sub를 하나로 합쳐서 반환한다 — 예전엔 verdict.headline("취소 위약금
  // 구간에 들어섰어요 — 지금 취소하면 141,750원 손실")과 별도의 "오늘 취소 시 손실액
  // 141,750원(41%)" bigStat이 같은 정보를 두 번 다른 방식으로 말하고 있었다(사장님 지적:
  // "둘 중 하나만 메인으로 남기는 게 좋아"). 이제 headline이 "오늘 취소하면 141,750원
  // 손실" 하나로 결론을 말하고, sub가 "취소수수료 41%"처럼 그 숫자의 의미만 보탠다.
  // 상태 자체("위약금 적용 중" 등)는 별도의 작은 배지(statusBadgeLabel)로 내린다.
  function buildVerdict({ priceGap, cancellation, lossProjection, bestAlt, finalPrice }) {
    if (cancellation.status === "nonrefundable") {
      // 배지("환불 불가")·헤드라인·서브가 전부 같은 말을 반복하고 있었다(실측 리포트:
      // "환불 불가"가 문자 그대로 두 번). 세 줄이 각각 다른 정보를 말하도록 —
      //   배지: 종류 / 헤드라인: 이 요금제를 고른 대가 / 서브: 금액.
      // 환불불가는 보통 "싸니까 못 무른다"는 거래인데, 무료취소 요금제보다 오히려 비싼
      // 경우가 실제로 있다(실측: 449,876원 vs 373,068원). 그 사실을 맨 위로 올린다.
      const freeAlt = bestAlt?.entry?.cancellation?.status === "free" ? bestAlt.entry : null;
      const gap = freeAlt && finalPrice ? finalPrice.amount - freeAlt.amount : null;
      const headline =
        gap == null
          ? "취소해도 환불되지 않아요"
          : gap > 0
          ? `무료취소 요금제보다 ${fmtWon(gap)} 비쌈`
          : `무료취소 요금제보다 ${fmtWon(-gap)} 저렴`;
      const sub = finalPrice ? `취소해도 ${fmtWon(finalPrice.amount)} 전액 부담` : "취소 시점과 무관하게 전액 부담";
      return { light: "red", headline, sub };
    }
    if (priceGap) {
      return { light: "red", headline: "화면 가격과 실제 총액이 달라요", sub: "결제 전 다시 확인하세요" };
    }
    if (lossProjection?.hasPenaltyToday) {
      const headline =
        lossProjection.todayAmount != null ? `오늘 취소하면 ${fmtWon(lossProjection.todayAmount)} 손실` : "위약금 구간 — 정확한 금액은 아래에서 확인";
      let sub = null;
      if (lossProjection.todayPercent != null) sub = `취소수수료 ${lossProjection.todayPercent}%`;
      else if (lossProjection.todayUsesFirstNight) sub = "1박 요금 상당";
      return { light: "red", headline, sub };
    }
    if (cancellation.status === "free") {
      // 예전엔 배지("무료취소 가능")와 헤드라인("오늘 취소해도 위약금 없음")이 같은 말을
      // 두 번 하고, 정작 행동에 필요한 마감일은 제일 작은 서브라인에 있었다(사장님 지적).
      // 세 줄이 각각 다른 정보를 말하도록 재배치한다 —
      //   배지: 종류 / 헤드라인: 언제까지 뭘 받는지 / 서브: 그 이후엔 어떻게 되는지.
      const headline = cancellation.deadline
        ? `${cancellation.deadline}까지 전액 환불`
        : "오늘 취소해도 위약금 없음";
      // penaltyNote는 "그 이후엔 위약금 약 30%가 발생할 수 있어요." 형태 — 서브에 맞게 줄인다.
      const after = cancellation.penaltyNote
        ? cancellation.penaltyNote
            .replace(/^그\s*이후엔\s*/, "그 이후 ")
            // "…50%가 발생할 수 있어요." / "…첫 1박 요금이 취소 수수료로 부과될 수 있어요."
            // 처럼 조사부터 끝까지 잘라야 꼬리가 안 남는다.
            // 조사는 앞 글자에 붙어 있어야 한다((?<=\S)) — 안 그러면 "그 이후"의 "이"를
            // 조사로 잘못 보고 문장 전체를 날려버린다.
            .replace(/(?<=\S)(?:이|가)\s+[^.]*?(?:발생|부과)[^.]*\.?\s*$/, "")
            .trim()
        : null;
      return { light: "green", headline, sub: after };
    }
    if (cancellation.status === "none") {
      return { light: "yellow", headline: "이 요금제의 취소 조건을 아직 확인 못했어요", sub: null };
    }
    if (cancellation.status === "collapsed") {
      return { light: "yellow", headline: "취소 조건이 목록엔 안 보여요", sub: "클릭해서 확인하세요" };
    }
    return { light: "yellow", headline: "취소 조건을 정확히 확인하지 못했어요", sub: null };
  }

  // 헤드라인 옆 작은 상태 배지("● 위약금 적용 중")용 — cancellation.status는 요금제
  // "종류"(무료취소형인지)를 나타내고 마감이 지나도 안 바뀌므로, hasPenaltyToday(오늘
  // 실제로 위약금 구간인지)를 함께 봐야 "이미 무료취소 기간이 지난 free 요금제"를
  // 정확히 "위약금 적용 중"으로 표시할 수 있다.
  function statusBadgeLabel(cancellation, lossProjection) {
    if (cancellation.status === "nonrefundable") return "환불 불가";
    if (lossProjection?.hasPenaltyToday) return "위약금 적용 중";
    if (cancellation.status === "free") return "무료취소";
    if (cancellation.status === "collapsed") return "조건 미확인";
    return "조건 확인 필요";
  }

  // ---- 방 이름·인원 표시 (조건이 다른 옵션을 "더 나은 선택"이라 단정하지 않기 위한 근거) ----
  function extractRoomLabel(card) {
    const labeled = card.querySelectorAll ? card.querySelectorAll("ul[aria-label]") : [];
    for (const el of labeled) {
      const label = el.getAttribute?.("aria-label");
      if (!label) continue;
      const withoutOffer = label.replace(/\s*특가\s*\d+\s*$/, "").trim();
      return withoutOffer.replace(/\s*\([A-Za-z][^)]*\)/g, "").trim();
    }
    return null;
  }

  function extractOccupancy(card) {
    if (!card.querySelectorAll) return null;
    const candidates = card.querySelectorAll("p, span, div");
    for (const el of candidates) {
      const text = (el.innerText || "").trim();
      if (!text || text.length > 20) continue;
      const m = text.match(/성인\s*\d+\s*명(?:\s*,?\s*(?:아동|어린이)\s*\d+\s*명)?/);
      if (m) return m[0];
    }
    return null;
  }

  // ---- 방 속성 비교 ("뭘 포기하는지" — 가격만 비교하지 않기 위함, 사장님 제안) ----
  // 카테고리별로 키워드 하나만 매칭한다 — roomLabel 텍스트 안에 "시티뷰"와 "디럭스"가
  // 같이 있어도 "뷰"와 "등급"은 서로 다른 카테고리라 각각 독립적으로 비교된다.
  const ROOM_ATTR_CATEGORIES = [
    {
      name: "view",
      keywords: [
        "오션뷰", "바다뷰", "Ocean View", "시티뷰", "City View", "가든뷰", "Garden View",
        "마운틴뷰", "Mountain View", "풀뷰", "Pool View", "뷰 없음", "No View",
      ],
    },
    { name: "bed", keywords: ["더블", "Double", "트윈", "Twin", "싱글", "Single", "킹", "King", "퀸", "Queen", "트리플", "Triple"] },
    {
      name: "grade",
      keywords: ["디럭스", "Deluxe", "슈페리어", "Superior", "스탠다드", "Standard", "프리미엄", "Premium", "스위트", "Suite", "이코노미", "Economy"],
    },
  ];

  function findAttr(label, category) {
    if (!label) return null;
    for (const kw of category.keywords) {
      if (label.includes(kw)) return kw;
    }
    return null;
  }

  // 두 roomLabel을 카테고리별로 비교해 실제로 달라진 속성만 뽑는다. 둘 중 하나라도
  // 키워드를 못 찾은 카테고리는(파싱 실패인지 원래 없는 속성인지 구분 안 됨) 단정하지
  // 않고 건너뛴다 — "확실히 다른 것"만 보여줘야 사용자가 신뢰할 수 있다.
  function diffRoomAttributes(currentLabel, altLabel) {
    if (!currentLabel || !altLabel) return [];
    const diffs = [];
    for (const cat of ROOM_ATTR_CATEGORIES) {
      const from = findAttr(currentLabel, cat);
      const to = findAttr(altLabel, cat);
      if (from && to && from !== to) diffs.push(`${from} → ${to}`);
    }
    return diffs;
  }

  // 지금 옵션을 늦게 취소했을 때 "최대 얼마까지 잃을 수 있는지" — 무료취소 대안을
  // "보험 가치"로 프레이밍할 때 쓴다("+8,000원으로 최대 198,000원 리스크를 피해요").
  function getMaxLoss(cancellation, finalPrice, perNightPrice) {
    if (!finalPrice) return null;
    if (cancellation.status === "nonrefundable") return finalPrice.amount;
    if (!cancellation.lossSteps.length) return null;
    const perNight = perNightPrice?.amount ?? null;
    let max = 0;
    for (const step of cancellation.lossSteps) {
      const amount = resolveStepAmount(step, finalPrice.amount, perNight);
      if (amount != null) max = Math.max(max, amount);
    }
    return max || null;
  }

  // buildComparison은 페이지의 모든 카드마다 가격 추출+취소조건 분류를 새로 돌리는,
  // 이 파일에서 제일 무거운 계산이다 — 방이 많은 페이지에서 스크롤할 때마다(스캔이
  // 900ms마다 다시 돎) 매번 전부 다시 계산하니 5초 넘게 걸리는 지연이 실측됐다. 스크롤만
  // 했을 뿐 방 목록 자체(allBlocks)와 체크인 날짜(dateContext)가 그대로면 결과도 그대로일
  // 수밖에 없으므로, 캐시해서 진짜 달라졌을 때만 다시 계산한다.
  let comparisonCache = { blocks: null, dateContext: null, result: [] };

  function sameNodeList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function sameDateContext(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ca = a.checkin, cb = b.checkin;
    const checkinSame = ca === cb || (ca && cb && ca.year === cb.year && ca.month === cb.month && ca.day === cb.day);
    return checkinSame && a.nights === b.nights;
  }

  // 검색한 인원(성인 N명). URL 파라미터를 먼저 보고, 없으면 검색창 문구에서 읽는다.
  function searchedAdults() {
    const p = new URLSearchParams(location.search);
    for (const k of ["adults", "numberOfAdults", "adultCount", "dAdultCnt"]) {
      const v = parseInt(p.get(k) || "", 10);
      if (v > 0) return v;
    }
    const m = document.body.innerText.match(/성인\s*(\d+)\s*명/);
    return m ? parseInt(m[1], 10) : null;
  }

  // 객실이 수용 가능한 최대 성인 수. "최대 성인 1명" 표기를 읽는다.
  // "최대 성인 1명" 표기는 요금제 블록이 아니라 그 위쪽 객실 헤더에 있는 경우가 많다
  // (실측: 요금 블록만 보면 못 찾아 필터가 통과돼버렸다). 조상을 몇 단계 올라가며 찾되,
  // 너무 넓게 올라가 옆 객실 정보를 읽지 않도록 텍스트 길이로 제한한다.
  function maxAdultsOf(card) {
    let cur = card;
    for (let up = 0; up < 6 && cur; up++, cur = cur.parentElement) {
      const t = cur.innerText || "";
      if (t.length > 2500) break;
      const m = t.match(/최대\s*성인\s*(\d+)\s*명/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function buildComparison(doc, allBlocks, dateContext) {
    if (
      comparisonCache.blocks &&
      sameNodeList(comparisonCache.blocks, allBlocks) &&
      sameDateContext(comparisonCache.dateContext, dateContext)
    ) {
      return comparisonCache.result;
    }

    const allEntries = [];
    for (const card of allBlocks) {
      const rawPrice = safely("pricing.computeFinalPrice(비교)", () => window.__ccPricing.computeFinalPrice(doc, card), null);
      if (!rawPrice) continue;
      // 메인 카드와 똑같이 "1박당 총 금액"이면 박수를 곱해 진짜 총액으로 맞춘다 — 이걸
      // 빼먹으면 2박 숙소를 "1박 가격"인 채로 비교해서 실제로는 같은 가격인데 훨씬 싼
      // 것처럼 잘못 추천하게 된다(사장님 지적 — 정확히 이 버그가 있었다). 체크인/체크아웃
      // 날짜는 검색 조건 하나로 페이지의 모든 방에 똑같이 적용되므로 dateContext.nights를
      // 그대로 재사용해도 안전하다.
      const price = correctForPerNightPrice(rawPrice, dateContext?.nights);
      const cancellation = safely("cancellation.buildCancellationSummary(비교)", () => window.__ccCancellation.buildCancellationSummary(doc, card, dateContext), emptyCancellation());
      allEntries.push({
        amount: price.amount,
        cancellation,
        roomLabel: extractRoomLabel(card),
        occupancy: extractOccupancy(card),
        maxAdults: maxAdultsOf(card),
        node: card,
        anchorNode: rawPrice.node,
      });
    }

    // "다른 옵션" 추천 목록(entries)은 가격이 겹치는 카드를 하나로 합쳐 중복 항목을
    // 피한다 — 다만 이 dedup을 카드마다 하나씩 붙는 인라인 배지(allEntries)에는 적용하면
    // 안 된다. 우연히 같은 가격인 두 방 중 하나가 배지를 통째로 잃어버리게 되기 때문이다.
    const seenAmounts = new Set();
    const entries = [];
    for (const e of allEntries) {
      if (seenAmounts.has(e.amount)) continue;
      seenAmounts.add(e.amount);
      entries.push(e);
    }
    entries.sort((a, b) => a.amount - b.amount);

    comparisonCache = { blocks: allBlocks, dateContext, result: entries, allEntries };
    return entries;
  }

  function getAllComparisonEntries() {
    return comparisonCache.allEntries ?? [];
  }

  /**
   * 가장 유리한 대안 1개를 고른다. "같은 방 + 같은 인원"이면 직접 비교 가능하다고 보고
   * 강하게(strong) 추천하고, 방이나 인원이 다르면 조건이 다를 수 있다는 뜻이라 약하게
   * (weak) — "다른 저렴한 옵션" 정도로만 — 표현한다. "더 좋은 선택"이라고 단정하지 않는다.
   */
  function buildBestAlternative(comparison, finalPrice, cancellationStatus, maxLoss) {
    if (!comparison.length || finalPrice == null) return null;
    const current = comparison.find((e) => e.amount === finalPrice.amount) ?? null;
    let candidates = comparison.filter((e) => e.amount !== finalPrice.amount);
    if (!candidates.length) return null;

    // 검색 인원을 수용 못 하는 객실은 "N원 절약"의 전제가 달라진다(실측 리포트 6번:
    // 성인 2명 검색인데 싱글룸을 대안으로 제시). 아예 후보에서 뺀다 — 고지만으로는
    // 절약액 숫자가 먼저 눈에 들어와 오해를 만든다.
    // 수용 인원은 이미 extractOccupancy가 "성인 1명"처럼 뽑아 비교 목록에 표시하고 있다
    // (실측 리포트에서 "싱글룸(성인 1명)"으로 확인). 조상 탐색(maxAdults)은 요금 블록
    // 바깥의 표기를 못 잡는 경우가 있었으므로, 검증된 occupancy를 1순위로 쓴다.
    const adultsOf = (e) => {
      const m = (e.occupancy || "").match(/성인\s*(\d+)\s*명/);
      if (m) return parseInt(m[1], 10);
      return e.maxAdults ?? null;
    };
    const needAdults = searchedAdults();
    if (needAdults) {
      candidates = candidates.filter((e) => {
        const a = adultsOf(e);
        return a == null || a >= needAdults;
      });
    }
    if (!candidates.length) return null;

    const green = candidates.filter((e) => e.cancellation.status === "free").sort((a, b) => a.amount - b.amount);
    let best = null;
    let reason = null;
    if (green.length && (green[0].amount < finalPrice.amount || cancellationStatus !== "free")) {
      best = green[0];
      const diff = best.amount - finalPrice.amount;
      if (diff <= 0) {
        reason = `${fmtWon(-diff)} 더 저렴하면서 무료취소도 가능해요.`;
      } else {
        // "보험 가치" 프레이밍 — 단순히 "무료취소로 바꿀 수 있다"가 아니라, 지금 옵션을
        // 늦게 취소하면 최대 얼마를 잃을 수 있는지(maxLoss)까지 보여줘야 추가 비용이
        // 왜 합리적인지 판단할 수 있다(사장님 제안: "보험 가치로 프레이밍").
        reason = maxLoss
          ? `+${fmtWon(diff)}으로 최대 ${fmtWon(maxLoss)}의 취소 리스크를 피할 수 있어요.`
          : `+${fmtWon(diff)}으로 무료취소 가능한 옵션으로 바꿀 수 있어요.`;
      }
    } else {
      const cheaper = candidates.filter((e) => e.amount < finalPrice.amount).sort((a, b) => a.amount - b.amount);
      if (cheaper.length) {
        best = cheaper[0];
        reason = `${fmtWon(finalPrice.amount - best.amount)} 더 저렴한 다른 옵션이 있어요.`;
      }
    }
    if (!best) return null;

    const sameRoom = current?.roomLabel && best.roomLabel && current.roomLabel === best.roomLabel;
    const sameOccupancy = !current?.occupancy || !best.occupancy || current.occupancy === best.occupancy;
    const strength = sameRoom && sameOccupancy ? "strong" : "weak";

    // "뭘 포기하는지" — 가격 차이만 보여주지 않고 방 속성(뷰/베드/등급)과 취소조건이
    // 실제로 어떻게 달라지는지 같이 보여준다(사장님 제안: 단순 가격비교 지양).
    const attrDiffs = diffRoomAttributes(current?.roomLabel, best.roomLabel);
    const currentCancelStatus = current?.cancellation?.status ?? cancellationStatus ?? null;
    const cancellationSame = currentCancelStatus != null && currentCancelStatus === best.cancellation.status;

    return {
      entry: best,
      reason,
      strength,
      othersCount: candidates.length - 1,
      attrDiffs,
      cancellationSame,
      currentCancelStatus,
    };
  }

  // ---- 인라인 배지 (요금제 줄마다 "🟢 무료취소 · 총 256,298원") ----------------------
  // 페이지 자체가 "AI 분석이 덧씌워진 화면"처럼 보이게 하는 게 목적(사장님 제안). 카드
  // 컨테이너에 통째로 뭔가를 끼워넣지 않고, badges.js(검색결과 안전도 배지)가 이미 같은
  // 사이트에서 검증한 것과 똑같은 패턴 — 가격 리프 노드 바로 뒤에 작은 <span> 하나만
  // insertAdjacentElement로 붙인다 — 을 그대로 따른다. 카드를 통째로 감싸거나 새 줄을
  // 만드는 삽입은 사이트마다 레이아웃이 달라 깨질 위험이 커서 피한다.
  function inlineCancelLabel(cancellation) {
    if (cancellation.status === "free") return "무료취소";
    if (cancellation.status === "nonrefundable") return "환불 불가";
    return "취소조건 확인 필요";
  }

  let inlineBadgeEls = [];
  let lastBadgeComparison = null;

  function clearInlineBadges() {
    for (const el of inlineBadgeEls) {
      if (el.isConnected) el.remove();
    }
    inlineBadgeEls = [];
  }

  function renderInlineBadges(allEntries) {
    // buildComparison의 캐시가 그대로면(스크롤만 하고 방 목록/날짜가 안 바뀌면) 같은
    // 배열 참조가 그대로 돌아온다 — 매번 지웠다 다시 그리면 그 사이 깜빡임이 생기니
    // 참조가 바뀌었을 때만 다시 그린다.
    if (allEntries === lastBadgeComparison) return;
    lastBadgeComparison = allEntries;
    clearInlineBadges();

    for (const entry of allEntries) {
      if (!entry.anchorNode || !entry.anchorNode.isConnected) continue;
      const badge = document.createElement("span");
      badge.className = "cc-ui cc-inline-badge";
      const color = LIGHT_COLOR[altColor(entry.cancellation.status)];
      badge.style.cssText = `
        display: inline-flex; align-items: center; gap: 4px; margin-left: 8px;
        padding: 2px 8px; border-radius: 10px; background: #f5f5f5;
        border-left: 3px solid ${color}; font-size: 11px; font-weight: 600;
        color: #333; white-space: nowrap; vertical-align: middle; cursor: default;
      `;
      // 상태는 border-left 색으로만 표시한다(이모지 신호등 대신 — 색은 상태에만
      // 쓰고, 나머지는 텍스트로).
      badge.textContent = `${inlineCancelLabel(entry.cancellation)} · 총 ${fmtWon(entry.amount)}`;
      // 가격 리프가 요금제 선택 버튼/링크 안에 있는 경우가 흔해서, 배지를 눌렀을 때
      // 그 버튼의 클릭(요금제 선택/이동)까지 같이 발동하지 않도록 막는다 — 배지는
      // 정보 표시 전용이라 클릭 자체는 의도한 동작이 없다.
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      entry.anchorNode.insertAdjacentElement("afterend", badge);
      inlineBadgeEls.push(badge);
    }
  }

  // ---- 렌더링 ----------------------------------------------------------------
  // 카드가 요금제 목록을 가리는 문제(사장님 실측) 해결: 평소엔 한 줄 미니 배지(.cc-mini)만
  // 보이다가, 마우스를 올리면 전체 카드(.cc-full)로 펼쳐지고 벗어나면 다시 접힌다. 순수
  // CSS :hover로 처리하는 이유 — runBriefing이 스캔마다(~900ms) cardEl을 통째로 새로
  // 만드는데, JS로 마우스오버 상태를 직접 추적하면 재생성 시점에 마우스가 그대로 카드
  // 위에 있어도 새 mouseenter 이벤트가 안 와서 깜빡이거나 다시 접혀버린다. :hover는 커서
  // 위치 기반으로 매 프레임 재계산되므로 노드가 재생성돼도 끊김이 없다. 📌 고정 버튼은
  // pinned를 모듈 스코프에 저장해 재생성 후에도 유지한다.
  let cardEl = null;
  let cardOpen = false; // 펼침 여부 — 클릭으로만 바뀐다
  let activeTab = "brief"; // 카드 재생성 후에도 유지되도록 모듈 스코프

  // 카드 위치를 사용자가 옮길 수 있게 한다(헤더/미니배지를 잡고 드래그).
  // cardEl은 스캔마다 새로 만들어지므로 위치는 모듈 스코프 + chrome.storage.local에 남긴다.
  // chrome.storage는 비동기라 첫 렌더가 값보다 먼저 일어날 수 있다 — 값이 도착하면
  // applyCardPos를 다시 불러 그때 자리를 잡는다.
  const CARD_POS_KEY = "cc_card_pos";
  let cardPos = null;
  const validPos = (v) => v && typeof v.left === "number" && typeof v.top === "number" ? v : null;
  ccStorage.get(CARD_POS_KEY, (v) => {
    cardPos = validPos(v);
    if (cardPos) applyCardPos();
  });
  // 다른 탭에서 옮기면 이 탭도 따라간다.
  ccStorage.onChange(CARD_POS_KEY, (v) => {
    cardPos = validPos(v);
    applyCardPos();
  });
  let suppressNextClick = false;

  // 패널 크기 — 위치(cc_card_pos)와 같은 방식으로 다룬다.
  // 기본값은 고정 322px 이었는데 "너무 작고 글자가 많다"는 실측 피드백이 있었다.
  const CARD_SIZE_KEY = "cc_card_size";
  // 기본 너비는 한 곳에서만 정한다. 예전엔 renderCard 의 cssText 에 322px 를 박아두고
  // applyCardSize 가 "저장값 없음"일 때 full.style.width = "" 로 지웠는데, 둘이 같은
  // 인라인 style 속성이라 그 한 줄이 방금 준 322px 까지 날렸다. 너비가 auto 가 되면
  // 카드가 내용만큼 퍼져서 화면 절반을 덮었다(실측: 트립닷컴에서 1000px 이상).
  // 그래서 이제 applyCardSize 는 어떤 경우에도 **항상 명시적인 px 값**을 넣는다.
  const CARD_W_DEFAULT = 380;
  const CARD_W_MIN = 300, CARD_W_MAX = 540;
  const CARD_H_MIN = 320;
  let cardSize = null;
  let isResizing = false;
  const validSize = (v) => (v && typeof v.w === "number" && typeof v.h === "number" ? v : null);
  ccStorage.get(CARD_SIZE_KEY, (v) => {
    cardSize = validSize(v);
    if (cardSize) applyCardSize();
  });
  ccStorage.onChange(CARD_SIZE_KEY, (v) => {
    cardSize = validSize(v);
    applyCardSize();
  });

  function applyCardSize() {
    if (!cardEl) return;
    const full = cardEl.querySelector(".cc-full");
    if (!full) return;
    // 저장한 창보다 작은 화면에서 열 수 있으므로 항상 지금 창에 맞춰 자른다.
    //
    // 세로는 화면의 96%까지 허용한다. 다만 카드를 직접 옮겨둔 상태(cardPos)라면 그
    // 위치에서 화면 아래까지의 남은 공간이 진짜 상한이다 — 그보다 크게 잡으면 카드
    // 아래쪽이 화면 밖으로 나가 손잡이째 사라진다.
    const vh = window.innerHeight;
    let hMax = Math.round(vh * 0.96);
    if (cardPos) hMax = Math.min(hMax, Math.max(CARD_H_MIN, vh - cardPos.top - 8));
    // 저장값이 없으면 기본값을 쓴다 — 비우지 않는다(위 CARD_W_DEFAULT 주석 참고).
    const w = Math.max(CARD_W_MIN, Math.min(CARD_W_MAX, cardSize?.w ?? CARD_W_DEFAULT));
    const h = Math.max(CARD_H_MIN, Math.min(hMax, cardSize?.h ?? Math.round(vh * 0.8)));
    full.style.width = w + "px";
    // 가로는 늘 고정폭인데 세로만 max-height 였다. 그래서 내용이 짧으면 아래 변을
    // 끌어도 카드가 안 커져 "고장난 것 같다"는 피드백이 나왔다(실측).
    //
    // 직접 조절한 경우에만 정확한 높이를 준다. 한 번도 안 건드린 기본 상태까지
    // 고정하면 내용이 짧아도 카드가 늘 화면의 80% 를 차지해 허옇게 빈다.
    if (cardSize) {
      full.style.height = h + "px";
      full.style.maxHeight = "";
    } else {
      full.style.height = "";
      full.style.maxHeight = h + "px";
    }
    // 안쪽 스크롤 영역의 높이는 이제 flex 가 맡는다(.cc-full 이 세로 flex, .cc-pane 이
    // 남는 공간을 채운다). 헤더·탭·하단 고지 높이를 빼서 계산하던 --cc-pane-max 는
    // 객실명이 두 줄이 되는 등 헤더가 커지면 어긋나서 내용이 잘렸다.
  }

  function applyCardPos() {
    if (!cardEl) return;
    if (cardPos) {
      // 저장한 창보다 작은 창에서 열면 좌표가 화면 밖일 수 있다 — 항상 보이는 곳으로 당긴다.
      // appendChild 전에 불리면 offsetWidth가 0이라 기본값을 쓴다.
      const w = cardEl.offsetWidth || 322;
      const h = cardEl.offsetHeight || 200;
      const left = Math.max(4, Math.min(cardPos.left, window.innerWidth - w - 4));
      const top = Math.max(4, Math.min(cardPos.top, window.innerHeight - Math.min(h, 44) - 4));
      cardEl.style.left = left + "px";
      cardEl.style.top = top + "px";
      cardEl.style.right = "auto";
      cardEl.style.bottom = "auto";
    } else {
      cardEl.style.left = "";
      cardEl.style.top = "";
      cardEl.style.right = "";
      cardEl.style.bottom = "";
    }
  }

  function makeDraggable(handle) {
    handle.style.cursor = "grab";
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("#cc-pin")) return;
      const rect = cardEl.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const ox = sx - rect.left, oy = sy - rect.top;
      let moved = false;
      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        moved = true;
        handle.style.cursor = "grabbing";
        cardPos = {
          left: Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - ox)),
          top: Math.max(4, Math.min(window.innerHeight - 44, ev.clientY - oy)),
        };
        applyCardPos();
        ev.preventDefault();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.style.cursor = "grab";
        if (moved) {
          suppressNextClick = true; // 드래그 끝의 click이 펼침 토글로 새지 않게
          ccStorage.set(CARD_POS_KEY, cardPos);
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  // 크기 조절 손잡이. 구현은 makeDraggable 과 같은 모양이다 —
  // mousedown → document 의 mousemove/mouseup, 4px 임계, 끝에서 저장.
  // 크기 조절 손잡이 여덟 개(네 변 + 네 모서리).
  //
  // 방향에 따라 카드의 **위치까지** 움직여야 한다. 카드는 left/top 으로 자리를 잡으므로,
  // 왼쪽 변을 왼쪽으로 끌면 폭이 늘면서 left 는 그만큼 줄어야 오른쪽 모서리가 제자리에
  // 있는 것처럼 보인다. 위쪽도 같다. 이걸 빼먹으면 카드가 커지면서 통째로 밀려난다.
  //
  // 실제 적용값은 applyCardSize 가 다시 자르므로(최소·최대·화면 밖 방지), 위치 보정은
  // 자른 뒤의 크기로 계산한다 — 안 그러면 한계에 닿은 뒤에도 카드가 계속 밀린다.
  const RZ_DIRS = [
    ["n", 0, -1], ["s", 0, 1], ["w", -1, 0], ["e", 1, 0],
    ["nw", -1, -1], ["ne", 1, -1], ["sw", -1, 1], ["se", 1, 1],
  ];

  function makeResizable(fullEl) {
    for (const [dir, dx, dy] of RZ_DIRS) {
      const grip = document.createElement("div");
      grip.className = "cc-rz cc-rz-" + dir;
      if (dir === "se") grip.title = "드래그해서 크기 조절 · 더블클릭하면 기본 크기";
      fullEl.appendChild(grip);

      grip.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        cardSize = null;
        applyCardSize();
        ccStorage.set(CARD_SIZE_KEY, null);
      });

      grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation(); // 헤더 드래그(이동)로 새지 않게
        const rect = fullEl.getBoundingClientRect();
        // 기본 상태의 카드는 right/bottom 기준이라, 그대로 두면 손잡이를 끌 때 카드가
        // 반대 방향으로 자란다. 시작할 때 좌표 기준을 left/top 으로 바꿔 방향을 맞춘다.
        if (!cardPos && cardEl) {
          const cr = cardEl.getBoundingClientRect();
          cardPos = { left: cr.left, top: cr.top };
          applyCardPos();
        }
        const sx = e.clientX, sy = e.clientY;
        const w0 = rect.width, h0 = rect.height;
        const left0 = cardPos ? cardPos.left : rect.left;
        const top0 = cardPos ? cardPos.top : rect.top;
        isResizing = true; // 끄는 동안 스캔이 카드를 새로 그리지 않게 한다

        const onMove = (ev) => {
          cardSize = { w: w0 + dx * (ev.clientX - sx), h: h0 + dy * (ev.clientY - sy) };
          applyCardSize();
          // 잘린 뒤의 실제 크기로 위치를 보정한다(위 주석 참고).
          if (dx < 0 || dy < 0) {
            const now = fullEl.getBoundingClientRect();
            cardPos = {
              left: dx < 0 ? left0 - (now.width - w0) : left0,
              top: dy < 0 ? top0 - (now.height - h0) : top0,
            };
            applyCardPos();
          }
          ev.preventDefault();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          isResizing = false;
          if (cardSize) ccStorage.set(CARD_SIZE_KEY, cardSize);
          if (cardPos) ccStorage.set(CARD_POS_KEY, cardPos);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
  }
  let pinned = false;
  let detailOpen = false;
  let othersOpen = false;
  // 사용자가 지금 우리 카드 위에 마우스를 올려둔 상태인지 — true인 동안은 runBriefing이
  // 카드를 통째로 재생성하지 않는다(아래 설명 참고).
  let isWrapHovered = false;

  // 페이지에 남긴 표시를 모두 걷는다(카드가 사라질 때).
  // 확장 안의 파일 주소. 확장이 새로고침되면 컨텍스트가 무효화돼 여기서 던질 수 있다
  // (ccStorage 가 같은 이유로 try/catch 를 두르고 있다).
  function extensionUrl(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch (e) {
      return null;
    }
  }

  // 확장 버전. 확장 컨텍스트가 무효화되면 getManifest 가 던진다(extensionUrl 과 같은 이유).
  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return "?";
    }
  }

  // 헤더 브랜드마크. 확장 아이콘을 그대로 쓰고, 못 읽으면 글자로 대체한다.
  function brandMarkHtml() {
    const url = extensionUrl("icon48.png");
    return url
      ? `<img class="cc-brandmark" src="${escapeHtml(url)}" alt="ClearBooking" draggable="false">`
      : `<span class="cc-brandmark">C</span>`;
  }

  function clearSelectionMark() {
    if (typeof paintOfferMarks === "function") { hoveredOffer = null; paintOfferMarks(); }
  }

  function removeCard() {
    if (cardEl && cardEl.isConnected) cardEl.remove();
    cardEl = null;
  }

  // 스타일 주입.
  //
  // 예전엔 `이미 있으면 그냥 return` 이었다. 그런데 이 <style> 은 **페이지의 DOM**에
  // 남는다 — 확장을 새로고침해도 페이지를 완전히 다시 읽지 않으면 그대로다.
  // 그래서 새 코드가 새 마크업을 그리는데 화면엔 옛 CSS 가 걸려 있는 상태가 됐다
  // (실측: 헤더가 남색이 안 되고 금액이 기본 크기로 나옴 — 옛 CSS 에는 cc-headamount
  //  같은 새 클래스가 아예 없으니 스타일이 안 붙는다).
  //
  // 이제 내용에 도장을 찍어두고, 다르면 갈아끼운다. UI 를 고칠 때마다 CC_STYLE_REV 를
  // 올리면 옛 스타일이 남은 페이지도 다음 스캔에 저절로 따라온다.
  const CC_STYLE_REV = "2026-09-24-collapsefix";

  function ensureBriefingStyle() {
    const prev = document.getElementById("cc-briefing-style");
    if (prev && prev.dataset.rev === CC_STYLE_REV) return;
    if (prev) prev.remove();
    const style = document.createElement("style");
    style.id = "cc-briefing-style";
    style.dataset.rev = CC_STYLE_REV;
    style.textContent = `
      #cc-briefing-wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; }
      /* 펼침/접힘은 display 로만 가른다. 페이지 CSS 에 지지 않도록 !important 를 붙이는데,
         그러면 우리 쪽 다른 규칙도 이걸 못 이겨야 한다 — display 를 정하는 곳은 여기뿐이다.
         (실측: 아래 .cc-full 모양 규칙에 display:flex !important 가 있어서 접기 버튼을
          눌러도 카드가 안 닫히고 미니 배지만 위에 더 떴다.) */
      #cc-briefing-wrap .cc-mini { display: flex !important; }
      #cc-briefing-wrap .cc-full { display: none !important; }

      /* 펼침은 오직 클릭으로만 토글한다(.cc-open).
         호버로 펼치던 기존 방식은 "스크롤 중 강제 축소"와 정면으로 충돌했다 —
         카드가 작아지면 커서가 박스 밖으로 밀려 :hover가 풀리고, 스크롤이 멈추면
         다시 커지며 :hover가 걸려, 스크롤하는 내내 열렸다 닫혔다를 반복했다
         (실측: "마우스가 오른쪽에 있으면 패널이 지멋대로 열렸다 닫혔다").
         크기 변화가 호버 상태를 바꾸는 구조라 호버를 쓰는 한 못 없앤다. */
      #cc-briefing-wrap.cc-open .cc-mini { display: none !important; }
      /* 펼쳤을 때만 세로 flex — 헤더·탭·하단 고지는 제 높이를 갖고 가운데 패널이 남는
         공간을 채운다. 카드 높이를 직접 지정해도 내용이 잘리거나 허옇게 남지 않는다. */
      #cc-briefing-wrap.cc-open .cc-full {
        display: flex !important; flex-direction: column !important;
      }

      /* 스크롤 중에도 크기는 그대로 두고 살짝 투명하게만 — 목록을 가리지 않으면서
         기하학적 변화가 없으니 호버/클릭 상태가 흔들리지 않는다. */
      #cc-briefing-wrap.cc-scrolling { opacity: 0.55; transition: opacity 0.12s ease; }
      /* 리뷰 목록이 길어도 카드 안에서 스크롤되도록 — 바깥으로 스크롤이 새지 않게 한다 */
      /* 안쪽 스크롤 영역의 높이는 카드 높이를 따라간다(applyCardSize 가 값을 넣는다).
         크기를 조절하지 않았으면 예전 기본값 62vh 를 그대로 쓴다. */
      /* min-height:0 이 없으면 flex 항목이 내용 높이 밑으로 안 줄어들어 스크롤이 안 생긴다. */
      #cc-briefing-wrap .cc-pane {
        flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
      }
      /* 크기 조절 — 네 변과 네 모서리 전부에서 잡힌다.
         우측 하단 한 곳만 있던 때는 "조절하기 어렵다"는 피드백이 있었다.
         변은 6px, 모서리는 14px 폭의 띠를 카드 바깥쪽으로 걸쳐 둔다 — 안쪽으로만 두면
         스크롤바·버튼과 겹쳐 그쪽이 먼저 잡힌다. */
      #cc-briefing-wrap .cc-full { position: relative; }
      #cc-briefing-wrap .cc-rz { position: absolute; z-index: 4; }
      #cc-briefing-wrap .cc-rz-n  { left: 12px; right: 12px; top: -3px;    height: 8px;  cursor: ns-resize; }
      #cc-briefing-wrap .cc-rz-s  { left: 12px; right: 12px; bottom: -3px; height: 8px;  cursor: ns-resize; }
      #cc-briefing-wrap .cc-rz-w  { top: 12px; bottom: 12px; left: -3px;   width: 8px;   cursor: ew-resize; }
      #cc-briefing-wrap .cc-rz-e  { top: 12px; bottom: 12px; right: -3px;  width: 8px;   cursor: ew-resize; }
      #cc-briefing-wrap .cc-rz-nw { top: -3px; left: -3px;   width: 15px; height: 15px; cursor: nwse-resize; }
      #cc-briefing-wrap .cc-rz-ne { top: -3px; right: -3px;  width: 15px; height: 15px; cursor: nesw-resize; }
      #cc-briefing-wrap .cc-rz-sw { bottom: -3px; left: -3px;  width: 15px; height: 15px; cursor: nesw-resize; }
      #cc-briefing-wrap .cc-rz-se { bottom: -3px; right: -3px; width: 15px; height: 15px; cursor: nwse-resize; }
      /* 우측 하단에만 꺾쇠를 그려 "여기를 끌 수 있다"를 알린다(나머지는 커서로 안다) */
      #cc-briefing-wrap .cc-rz-se::after {
        content: ""; position: absolute; right: 4px; bottom: 4px; width: 8px; height: 8px;
        border-right: 2px solid var(--cc-edge); border-bottom: 2px solid var(--cc-edge);
        border-bottom-right-radius: 3px;
      }
      #cc-briefing-wrap .cc-rz-se:hover::after { border-color: var(--cc-navy); }
      /* 저장 버튼 — 짙은 헤더 위에 놓이므로 흰 알약이 아니라 반투명 칩으로 둔다.
         (원래는 밝은 헤더 전제라 흰 배경 + 짙은 글자였다. 헤더가 남색이 되면서
          그대로 두면 하얀 덩어리가 툭 튀어나온다.)
         담긴 상태는 노란 별로 드러낸다 — 배경까지 노랗게 하면 헤더가 시끄러워진다. */
      #cc-briefing-wrap .cc-save {
        all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
        padding: 5px 10px; border-radius: 999px;
        font-size: 11.5px; font-weight: 600; line-height: 1;
        color: #c3cedf; background: rgba(255,255,255,.14);
        transition: background .12s, color .12s;
      }
      #cc-briefing-wrap .cc-save .cc-star { font-size: 13px; }
      #cc-briefing-wrap .cc-save:hover { background: rgba(255,255,255,.24); color: #fff; }
      #cc-briefing-wrap .cc-save.on { background: rgba(240,180,0,.18); color: #ffd76a; }
      #cc-briefing-wrap .cc-save.on .cc-star { color: #ffc93c; }
      /* 저장 목록 버튼(☰) — 저장 칩과 같은 반투명 톤, 아이콘만 */
      #cc-briefing-wrap .cc-listbtn {
        all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 23px; border-radius: 999px;
        color: #c3cedf; background: rgba(255,255,255,.14); transition: background .12s, color .12s;
      }
      #cc-briefing-wrap .cc-listbtn:hover, #cc-briefing-wrap .cc-listbtn.on { background: rgba(255,255,255,.24); color: #fff; }

      /* 저장 목록 창 — 툴바 팝업(popup.html)을 그대로 iframe으로 띄운다.
         카드는 스캔마다 다시 그려지므로 카드 밖(body 직속)에 둔다. */
      #cc-saved-panel {
        position: fixed; z-index: 2147483001; width: 360px; height: min(560px, calc(100vh - 16px));
        border-radius: 14px; overflow: hidden; background: #fffefa;
        border: 1px solid #dfe2e7; box-shadow: 0 18px 50px rgba(29,49,85,.22);
      }
      #cc-saved-panel iframe { display: block; width: 100%; height: 100%; border: 0; }
      #cc-briefing-wrap .cc-progress {
        height: 3px; border-radius: 999px; background: #e2eaf9; overflow: hidden; margin-top: 10px;
      }
      #cc-briefing-wrap .cc-progress i {
        display: block; height: 100%; width: 40%; border-radius: 999px; background: var(--cc-navy);
        animation: cc-slide 1.1s ease-in-out infinite;
      }
      @keyframes cc-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
      #cc-briefing-wrap .cc-elapsed { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-faint); }
      #cc-briefing-wrap { transition: opacity 0.18s ease; }

      /* ---- 디자인 토큰 (2026-09 개편: 금융앱형) ----------------------------
         폰트는 시스템 폰트만 쓴다. 웹폰트를 받으면 (1) 남의 사이트 CSP 에 걸릴 수
         있고 (2) 카드 하단 고지의 "어디로도 전송하지 않습니다" 와 어긋나며
         (3) 늦게 오면 글자가 한 번 바뀌어 보인다.
         스택 순서가 중요하다 — Segoe UI 를 한글 폰트보다 **앞**에 둔다. 숫자는
         영문 글립이라 Windows 에서 Segoe UI(Black 까지 있음)를 타고, 한글만
         맑은 고딕(Bold 까지)으로 떨어진다. 둘을 바꾸면 숫자까지 Bold 에서 막힌다. */
      #cc-briefing-wrap {
        --cc-font: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif;
        --cc-ink: #14171c; --cc-muted: #6b7381; --cc-faint: #98a0ac;
        --cc-line: #eceef1; --cc-edge: #dfe2e7; --cc-paper: #ffffff;
        --cc-head: #17243c; --cc-head-sub: #9fb0c6;
        --cc-navy: #1d4ed8;
        /* 초록·빨강은 두 단계로 나눈다 — 진한 채움은 점·선에만, 글자는 읽히는 선까지만
           낮춘다(실사용 피드백 "색이 좀 연했으면"). 글자까지 연하게 하면 작은 글씨의
           대비가 4.5:1 아래로 떨어져 안 읽힌다. */
        --cc-safe: #1b7a52; --cc-safe-fill: #55b189; --cc-safe-bg: #f2faf6; --cc-safe-chip: #dcf0e5;
        --cc-risk: #c24a3a; --cc-risk-fill: #e8967f; --cc-risk-edge: #d9705c; --cc-risk-bg: #fdf5f3;
        --cc-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      /* 폰트·글자 렌더링을 카드 **안쪽 전부**에 못박는다.
         사이트마다 글자(특히 숫자)가 다르게 보이던 원인 — 우리는 카드 바깥쪽 세 곳에만
         font-family 를 줬는데, 안쪽 요소는 상속에 기대고 있었다. 남의 사이트가
         div 전체를 잡는 넓은 규칙으로 font-family 를 주면 상속 대신 그쪽이 이긴다.
         font-smoothing 과 font-variant-numeric 도 사이트마다 달라서 같은 폰트인데도
         숫자 굵기·폭이 달라 보인다 — 셋 다 여기서 고정한다. */
      #cc-briefing-wrap, #cc-briefing-wrap * {
        font-family: var(--cc-font) !important;
        font-variant-numeric: normal !important;
        font-feature-settings: normal !important;
        -webkit-font-smoothing: antialiased;
      }
      /* 진행 표시의 경과 시간만 예외로 고정폭 글꼴을 쓴다(숫자가 흔들리지 않게). */
      #cc-briefing-wrap .cc-elapsed { font-family: var(--cc-mono) !important; }
      #cc-briefing-wrap .cc-full {
        background: var(--cc-paper) !important;
        border: 0 !important;
        border-radius: 18px !important;
        box-shadow: 0 8px 26px rgba(20,24,30,.15) !important;
        color: var(--cc-ink) !important;
        overflow: hidden !important;
        /* display 는 여기서 정하지 않는다 — 위 .cc-open 규칙이 펼쳤을 때만 flex 로 만든다. */
      }
      #cc-briefing-wrap .cc-head, #cc-briefing-wrap .cc-tabs { flex: 0 0 auto; }
      /* 헤더 — 짙은 남색 블록. 예약 금액까지 이 안에 들어간다. */
      #cc-briefing-wrap .cc-head {
        background: var(--cc-head) !important;
        border-bottom: 0 !important;
        padding: 14px 20px 17px !important;
        display: block !important;
      }
      #cc-briefing-wrap .cc-headrow { display: flex; align-items: center; gap: 8px; }
      #cc-briefing-wrap img.cc-brandmark {
        width: 19px; height: 19px; border-radius: 6px; display: block; flex: 0 0 auto;
      }
      #cc-briefing-wrap span.cc-brandmark {
        display: grid; place-items: center; width: 19px; height: 19px; border-radius: 6px;
        background: #fff; color: var(--cc-head); font-size: 11px; font-weight: 900;
      }
      #cc-briefing-wrap .cc-head-title { font-size: 13px; font-weight: 700; color: #fff; letter-spacing: -.02em; }
      #cc-briefing-wrap .cc-live { display: none; }
      #cc-briefing-wrap #cc-pin {
        width: 23px; height: 23px; border-radius: 7px; background: rgba(255,255,255,.14);
        display: grid !important; place-items: center; color: #c3cedf !important; font-size: 0 !important;
      }
      #cc-briefing-wrap .cc-headlabel { font-size: 11.5px; font-weight: 500; color: var(--cc-head-sub); margin-bottom: 4px; }
      #cc-briefing-wrap .cc-headamount {
        font-size: 36px; font-weight: 800; color: #fff; letter-spacing: -.045em; line-height: 1;
      }
      #cc-briefing-wrap .cc-headamount .cc-won { font-size: 21px; font-weight: 700; margin-left: 1px; }
      #cc-briefing-wrap .cc-headsub { font-size: 11.5px; color: var(--cc-head-sub); margin-top: 7px; line-height: 1.55; }
      #cc-briefing-wrap .cc-mini {
        background: var(--cc-paper) !important;
        border: 1px solid var(--cc-edge) !important;
        box-shadow: 0 10px 28px rgba(20,24,30,.16) !important;
        color: var(--cc-ink) !important;
      }
      #cc-briefing-wrap .cc-seclabel {
        font-size: 11.5px; font-weight: 700; letter-spacing: 0; color: var(--cc-muted); text-transform: none;
      }
      #cc-briefing-wrap .cc-bigval {
        font-size: 26px !important; font-weight: 800 !important;
        letter-spacing: -1.1px !important; line-height: 1.15 !important;
      }
      #cc-briefing-wrap .cc-bigsub { color: var(--cc-muted) !important; font-size: 11.5px !important; }
      /* 부킹닷컴에서 탭이 한쪽으로 쏠리던 문제 — 그 사이트가 button 에 text-align/padding/
         margin 을 주는데 우리는 가운데 정렬을 기본값에만 맡기고 있었다. 버튼이 자기 칸을
         꽉 채우고 가운데 정렬하도록 전부 명시한다. */
      #cc-briefing-wrap .cc-tabs {
        display: grid !important; grid-template-columns: 1fr 1fr !important;
        gap: 0 !important; border-bottom: 1px solid var(--cc-line); padding: 0; margin: 0;
      }
      #cc-briefing-wrap .cc-tabs button {
        appearance: none; border: 0; background: none; cursor: pointer;
        display: block !important; width: 100% !important; box-sizing: border-box !important;
        margin: 0 !important; min-width: 0;
        padding: 11px 0 !important; text-align: center !important;
        font: 600 12.5px var(--cc-font); line-height: 1.4 !important;
        color: var(--cc-faint); border-bottom: 2.5px solid transparent;
      }
      #cc-briefing-wrap .cc-tabs button.on { color: var(--cc-ink); font-weight: 700; border-bottom-color: var(--cc-head); }
      #cc-briefing-wrap .cc-tabcount {
        display: inline-block; margin-left: 4px; padding: 1px 6px; border-radius: 999px;
        background: var(--cc-line); color: var(--cc-muted); font-size: 10px; font-weight: 700;
      }
      #cc-briefing-wrap .cc-pane[hidden] { display: none; }
      #cc-briefing-wrap .cc-review-empty {
        padding: 26px 16px; text-align: center; color: var(--cc-muted);
        font-size: 12px; line-height: 1.7;
      }
      /* 상태 블록 — 테두리를 없애고 연한 바탕만. 뱃지도 진한 알약 대신 연한 칩. */
      #cc-briefing-wrap .cc-statusbox {
        margin-top: 15px; padding: 14px 16px;
        border: 0; background: var(--cc-safe-bg); border-radius: 14px;
      }
      #cc-briefing-wrap .cc-statusbox.cc-risk { background: var(--cc-risk-bg); }
      #cc-briefing-wrap .cc-statusdot { display: none; }
      #cc-briefing-wrap .cc-status-badge {
        display: inline-flex; align-items: center; gap: 5px; margin-bottom: 9px;
        padding: 4px 10px; border-radius: 999px; background: var(--cc-safe-chip);
        font-family: var(--cc-font); font-size: 11px; font-weight: 700; letter-spacing: 0;
        color: var(--cc-safe); text-transform: none;
      }
      #cc-briefing-wrap .cc-statusbox.cc-risk .cc-status-badge { background: #fbe7e2; color: var(--cc-risk); }
      #cc-briefing-wrap .cc-status-title { font-size: 20px; font-weight: 800; line-height: 1.3; letter-spacing: -.035em; color: var(--cc-ink); }
      #cc-briefing-wrap .cc-status-sub { margin-top: 4px; font-size: 12px; line-height: 1.55; color: var(--cc-muted); }
      /* 하단 버튼 — 꽉 찬 남색 + 조용한 글자 버튼 */
      #cc-briefing-wrap .cc-datanotice { flex: 0 0 auto; }
      #cc-briefing-wrap .cc-cta {
        display: block; background: var(--cc-head); color: #fff; border-radius: 11px;
        padding: 13px 0; text-align: center; font-size: 13.5px; font-weight: 700;
        text-decoration: none; letter-spacing: -.02em;
      }
      #cc-briefing-wrap .cc-cta:hover { background: #0f1a2c; }
    `;
    document.head.appendChild(style);
  }

  // 스크롤 중엔 즉시(스캔의 900ms 디바운스를 기다리지 않고) 미니 배지로 강제 축소한다 —
  // position:fixed 카드는 스크롤해도 화면 위치가 그대로라, 스캔이 끝날 때까지 기다리면
  // 그 사이 요금제 목록이 카드 밑을 지나가며 계속 가려진다. 스크롤이 멈추고 200ms 동안
  // 추가 스크롤이 없으면 원래 상태(호버/고정 여부)로 복귀한다.
  let isScrolling = false;
  let scrollEndTimer = null;
  // 마지막 페이지 스크롤 시각 — 자동 펼치기가 "스크롤이 멈춘 뒤"에만 열리도록 하는 데 쓴다.
  let lastScrollAt = 0;
  function handleScrollForMini(e) {
    // 리스너가 capture:true 라 카드 **안쪽** 스크롤(리뷰 목록 등)까지 잡혔다. 그래서
    // 카드를 읽으려고 스크롤하면 그 카드가 흐려지고, 스크롤도 제대로 안 먹는 것처럼
    // 느껴졌다(실측 피드백). 우리 UI에서 난 스크롤은 페이지 스크롤로 치지 않는다.
    const t = e && e.target;
    if (t && t.closest && t.closest(".cc-ui")) return;
    lastScrollAt = Date.now();
    // isScrolling 은 카드를 흐리게 할지뿐 아니라 "✓ 버튼을 숨길지"와 "자동 펼치기를
    // 미룰지"도 결정한다. 그러니 카드가 펼쳐져 있든 아니든 항상 세워야 한다 —
    // 아래 cardOpen early return 보다 반드시 앞이다.
    isScrolling = true;
    clearTimeout(scrollEndTimer);
    scrollEndTimer = setTimeout(() => {
      isScrolling = false;
      if (cardEl) cardEl.classList.remove("cc-scrolling");
      paintOfferMarks(); // 멈췄으니 ✓ 버튼을 다시 띄운다
    }, 500); // 트랙패드 미세 스크롤에 계속 깜빡이지 않도록 여유를 둔다
    // 스크롤이 끝나면 커서 밑의 요금을 다시 잡는다(scheduleRehoverAfterScroll 주석 참고).
    scheduleRehoverAfterScroll();
    // 카드를 펼쳐 읽는 중이면 흐리게 만들지 않는다 — 일부러 연 것이므로.
    if (cardOpen) return;
    if (cardEl) cardEl.classList.add("cc-scrolling");
  }
  window.addEventListener("scroll", handleScrollForMini, { capture: true, passive: true });

  // 페이지의 개별 요금제 카드에 직접 마우스를 올리면(꼭 지금의 포커스 카드가 아니어도)
  // 그 카드의 브리핑을 즉시 펼쳐 보여준다("스크롤·호버가 페이지 탐색과 자연스럽게
  // 이어지게" — 사장님 제안). 카드 노드는 우리 카드와 달리 스캔마다 재생성되지 않는
  // 페이지 자체의 노드라 리스너를 한 번만 붙이면 되고, 중복 바인딩 방지를 위해 노드에
  // 플래그를 남긴다. 스캔의 900ms 디바운스를 기다리지 않도록 호버 자체가 즉시
  // runBriefing을 다시 호출해 갱신한다(짧은 디바운스만 걸어 인접 카드 사이를 빠르게
  // 지나갈 때 과도하게 재계산하지 않도록 한다).
  // 호버 체류시간으로 모달을 열지 말지 가르던 HOVER_DWELL_MS 는 선택(pick) 모델로
  // 바뀌면서 없앴다 — 이제는 사용자가 ✓ 를 누른 것만 연다.
  let hoverDebounceTimer = null;
  let lastDoc = null;
  let lastDarkFindings = [];
  function scheduleHoverRescan() {
    clearTimeout(hoverDebounceTimer);
    hoverDebounceTimer = setTimeout(() => {
      if (lastDoc) runBriefing(lastDoc, lastDarkFindings);
    }, 60);
  }

  // 자동 펼치기(collapsed → 클릭 시뮬레이션) — 실측 결론(개발자도구 Network+Console 확인):
  // "취소 정책" 라벨을 클릭하기 전엔 정책 원문이 네트워크 응답에도, DOM에도 전혀 없다.
  // 숨은 API도 SSR로 미리 심어둔 JSON도 없어서, 자동 계산의 유일한 방법은 라벨을 대신
  // 클릭해 모달을 열고 읽은 뒤 바로 닫는 것뿐이다(화면이 잠깐 깜빡이는 건 감수하기로
  // 결정됨). 사이드이펙트를 줄이기 위한 제약:
  //  - 카드(노드)당 딱 한 번만 시도한다(WeakSet) — 실패해도 같은 스캔 주기 안에서 계속
  //    재시도하지 않는다.
  //  - 호버 미리보기(isHoverPreview) 중엔 절대 실행하지 않는다 — 마우스로 요금제 목록을
  //    스쳐 지나가기만 해도 몇 초 안에 여러 카드를 연달아 클릭하게 되는데, 이건 화면
  //    깜빡임 수준을 넘어 사이트에 부담을 줄 수 있다. 스크롤로 실제로 머무른(포커스) 카드
  //    에 대해서만 연다.
  //  - 사용자가 이미 뭔가(다른 모달)를 열어놓은 상태라면 절대 건드리지 않는다.
  // 캐시 키는 "요금제 카드(scope)"다. 취소 문구 노드로 키를 잡으면, 같은 객실인데도
  // 어떤 블록이 선택됐느냐에 따라 캐시를 못 찾아 방금 열어본 결과가 다시 ?로 돌아간다
  // (실측: 오른쪽 호버에선 82,812원이 나오다가 카드 전체가 선택되면 ?).
  //
  // 2026-09: 키를 "요금제 카드 노드"에서 **내용 서명**으로 바꿨다.
  // 실측 증상 — 누르지도 않은 정책 모달이 스크롤할 때마다 저절로 떴다 사라진다.
  // 원인: 아고다는 스크롤할 때마다 요금 행을 새로 그린다. 노드를 키로 쓰면 새 노드에는
  // "이미 눌러봤다"는 기억도, "읽어둔 결과" 캐시도 없어서 같은 요금제를 계속 다시 클릭했다.
  // 가격 + 취소 라벨은 재렌더돼도 그대로이므로 이걸 키로 쓴다.
  const collapsedRevealCache = new Map(); // 서명 -> 모달에서 읽어낸 진짜 취소조건
  const collapsedRevealAttempted = new Set(); // 서명
  const AUTO_REVEAL_TIMEOUT_MS = 2000;

  // 같은 요금제를 가리키는 안정적인 이름. 노드가 갈려도 값이 같으면 같은 요금제로 본다.
  function revealSignature(result) {
    const label = (result?.cancellation?.raw || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!label) return null; // 라벨조차 없으면 식별이 불가능하다 — 열지 않는다
    return `${result?.finalPrice?.amount ?? "?"}|${label}`;
  }

  // ── 자동 펼치기 속도 제한 ────────────────────────────────────────────────
  // 게이트가 사실상 없던 상태였다. 예전 조건은
  //   (!isHoverPreview || 경과 >= 150ms)
  // 였는데, 호버가 아니면 **대기 없이 즉시** 통과했고 호버 중이어도 150ms는 목록을
  // 훑기만 해도 넘는 값이라 걸러내지 못했다. 요금제가 12개면 12번 연달아 터졌다.
  //
  // 실사용자 리포트(2026-09-22): 그 뒤 "선택(pick) 모델" 개편으로 펼치기가 더 이상
  // 스크롤·호버만으로는 절대 안 일어난다 — 사용자가 "✓ 이 요금제 보기"를 직접 눌러야만
  // 시작된다(MAX_PICKS=1이라 한 번에 하나). 즉 "12개를 훑으면 12번 연달아 터진다"던
  // 원래 위험이 클릭 모델에서는 구조적으로 사라졌는데, 그 위험을 막으려던 값(700ms/1500ms)은
  // 그대로 남아 있어서 "요금제를 골랐는데 왜 이렇게 느리게 열리지"로 체감됐다. 클릭이
  // 이미 사람 손 속도로 자연스럽게 제한돼 있으므로 dwell/간격을 다시 낮춘다 — 폭주
  // 차단기(REVEAL_MAX_PER_PAGE)는 최후의 안전장치로 그대로 둔다.
  const REVEAL_DWELL_MS = 150;        // 같은 요금제에 이만큼 머물러야 연다
  const REVEAL_MIN_INTERVAL_MS = 500; // 연속 발사 차단
  const REVEAL_MAX_PER_PAGE = 12;      // 최후의 차단기 — 폭주하면 아예 멈춘다
  const REVEAL_AFTER_SCROLL_MS = 400;  // 스크롤이 멈추고 이만큼 지나야 연다
  let revealSigSeen = null;
  let revealSigSince = 0;
  let lastRevealAt = 0;
  let revealCount = 0;

  // 자동 펼치기 안내 한 줄. 카드를 다시 그리지 않고 DOM만 토글한다 —
  // 펼치는 도중에 재렌더를 돌리면 스캔이 겹쳐 또 다른 사고가 난다.
  let revealInProgress = false;
  function showRevealNotice(on) {
    revealInProgress = on;
    const el = cardEl?.querySelector?.("#cc-reveal-note");
    if (el) el.hidden = !on;
  }

  // 아고다는 모달을 닫아도 DOM에서 제거하지 않고 숨기기만 한다. 존재 여부로만 판단하면
  // 첫 자동 펼치기 이후 숨은 dialog가 계속 남아 "이미 모달 열림"이 되고, 그 뒤 모든
  // 객실의 자동 펼치기가 영구히 차단된다(실측: 첫 객실만 금액이 뜨고 그다음부터 ?).
  // 그래서 "실제로 화면에 보이는" 모달만 열린 것으로 센다.
  function visibleModals(doc) {
    const list = visibleDialogs(doc);
    // 사이트 어댑터가 알려준 취소 정책 모달(role="dialog" 표기가 없을 수 있다)을 맨 앞에 둔다.
    // 닫기(closeAnyOpenModal)가 [0] 을 쓰므로, 우리가 연 모달이 먼저 닫히게 한다.
    const siteModal = window.__ccSites?.cancellationModal(doc);
    if (siteModal && !list.includes(siteModal)) list.unshift(siteModal);
    return list;
  }

  function visibleDialogs(doc) {
    return [...doc.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter((el) => {
      if (el.closest(".cc-ui")) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return false;
      const st = getComputedStyle(el);
      return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
    });
  }

  function isAnyModalOpen(doc) {
    return visibleModals(doc).length > 0;
  }

  // 클릭 핸들러가 라벨 자신, 감싼 조상(button/a), 또는 자식 아이콘 쪽 중 어디에 있는지
  // 사이트마다 다를 수 있어 세 군데를 순서대로 찾아본다. 셋 다 없으면 라벨 자체를
  // 클릭한다 — React가 div에 직접 onClick을 바인딩하는 경우도 실측에서 흔했다(badges.js/
  // pricing.js의 "버튼 없이 클릭 가능한 div" 교훈과 동일).
  function findClickTarget(node) {
    if (node.matches?.("a, button, [role='button']")) return node;
    const inner = node.querySelector?.("a, button, [role='button']");
    if (inner) return inner;
    let ancestor = node.parentElement;
    for (let depth = 0; depth < 4 && ancestor; depth++) {
      if (ancestor.matches?.("a, button, [role='button']")) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return findDetailTrigger(node) ?? node;
  }

  // 어떤 요금제는 취소 문구 옆이 아니라 카드 안 별도 위치에 "자세히 보기"가 있고, 그게
  // button도 a도 아닌 순수 <div>다(실측: role 없는 div 17개 = 요금제 카드 수만큼).
  // 조상을 한 칸씩 올라가며 후보를 세다가 "정확히 하나"인 지점이 그 카드의 경계다 —
  // 두 개 이상 보이면 카드 밖으로 나간 것이므로 옆 카드를 잘못 여는 대신 포기한다.
  const DETAIL_TRIGGER_RE = /^(자세히\s*보기|더\s*보기|정책|취소\s*정책|취소\/환불\s*정책)$/;
  function findDetailTrigger(node) {
    let cur = node.parentElement;
    for (let depth = 0; depth < 8 && cur; depth++, cur = cur.parentElement) {
      const found = [...cur.querySelectorAll("a, button, div, span")].filter((el) => {
        if (el.closest(".cc-ui")) return false;
        return DETAIL_TRIGGER_RE.test((el.innerText || "").replace(/\s+/g, " ").trim());
      });
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  }

  function closeAnyOpenModal(doc) {
    const modal = visibleModals(doc)[0];
    if (!modal) return;
    const closeBtn = modal.querySelector('[aria-label*="닫기"], [aria-label*="Close" i], button[class*="close" i]');
    if (closeBtn) {
      closeBtn.click();
      return;
    }
    // 셋 다 없으면(아고다는 여기서 끝 — 실측으로 X 버튼이 항상 찾아졌고, Escape는 눌러도
    // 안 먹혔다) 사이트 어댑터가 자기 사이트용 닫기 방법을 알려주는지 확인한다.
    // 실측(Trip.com, 2026-09): X 버튼 셀렉터는 안 맞았지만 Escape 키로는 닫혔다.
    // "전역 Escape 위험"은 여기서 생기지 않는다 — 이 어댑터가 지금 켜져 있는 사이트일
    // 때만, 우리가 이 모달을 방금 열었다고 확신하는 이 순간에만 호출되기 때문이다.
    const customClose = window.__ccSites?.current()?.cancellation?.closeModal;
    if (customClose) {
      try {
        customClose(modal);
        dbg("모달 닫기 — 어댑터 제공 방식 사용");
      } catch (e) {
        dbg("어댑터 모달 닫기 실패:", e.message);
      }
      return;
    }
    // 닫기 방법이 전혀 없으면 그냥 둔다 — 남의 UI를 임의로 닫으려 시도하는 것보다 낫다.
    dbg("모달 닫기 버튼을 찾지 못함 — 그대로 둔다");
  }

  // 디버그 스위치. 우선순위는 window.__ccDebug (확장 콘솔) → chrome.storage.local.
  // 팀 개발 중에는 페이지 콘솔에서 localStorage.cc_debug = "1" 로도 켤 수 있게 남겨뒀다 —
  // 읽기만 하고 쓰지는 않으므로 남의 사이트 저장소를 건드리지 않는다.
  let debugFlag = false;
  ccStorage.get("cc_debug", (v) => { debugFlag = v === "1" || v === true; });

  function debugOn() {
    if (window.__ccDebug || debugFlag) return true;
    try { return localStorage.getItem("cc_debug") === "1"; } catch (e) { return false; }
  }

  // 로드 확인용 배너 — 항상 찍는다. 이게 안 보이면 확장이 새 코드로 로드되지 않은 것.
  console.log(
    // 버전은 manifest 에서 읽는다 — 손으로 적은 날짜 문자열(0916-safe+server)은
    // 반드시 낡는다. 실제로 9/16 이후 수십 번 바뀌는 동안 그대로였다.
    `%c[cc] 예약 브리핑 v${extensionVersion()} 로드됨`,
    "color:#173d9a;font-weight:700",
    "| 디버그:", debugOn() ? "켜짐" : "꺼짐 (콘솔에서 __ccDebug = true, 또는 localStorage.cc_debug = '1' 후 새로고침)"
  );
  warnIfModulesMissing();

  const dbg = (...a) => {
    if (debugOn()) console.log("[cc]", ...a);
  };

  // 실제 페이지 이동을 일으키는 <a href="...">는 자동 클릭하지 않는다.
  // 사고 사례(2026-09): 아고다 밖의 다른 사이트에서 "환불정책"과 정확히 일치하는 텍스트의
  // 링크를 이 로직이 찾아 자동 클릭했는데, 아고다처럼 모달을 여는 버튼이 아니라 진짜 이동
  // 링크라서 사용자가 보고 있던 페이지에서 그 사이트의 환불 페이지로 튕겨나갔다.
  // findClickTarget/findDetailTrigger 둘 다 a 태그를 후보로 반환할 수 있으므로, 실제
  // click() 직전 이 한 곳에서 막는다 — 취소조건을 못 읽는 것보다 엉뚱한 페이지로 이동시키는
  // 사고가 훨씬 나쁘다.
  function isSafeAutoClickTarget(el) {
    if (!el || el.tagName?.toLowerCase() !== "a") return true;
    const href = el.getAttribute("href") || "";
    if (!href || href === "#" || href.startsWith("javascript:")) return true;
    return false;
  }

  // "취소 정책" 라벨 요소를 찾는다. 실측(아고다 로그, 2026-09-24): 취소 블록으로 잡힌 node 는
  // "결제 및 취소" 소제목이고, 눌러야 하는 "취소 정책" 버튼은 그 안이 아니라 형제 위치에 있다
  // (라벨은 <p> 안에 <font>이 겹쳐 있다 — 브라우저 번역 흔적). 그래서 node 에서 위로 올라가며
  // 라벨이 정확히 하나 잡히는 조상을 찾는다. 감싼 요소와 안쪽 요소가 같은 글자면 가장 안쪽만
  // 센다. 2개 이상이 처음 잡히면(=옆 요금제까지 넘어간 것) null — 잘못 누르느니 포기한다.
  const CANCEL_LABEL_RE = /^(취소\s*정책|취소\/환불\s*정책)$/;
  const CANCEL_LABEL_MAX_ASCENT = 6;
  function findCancelLabelIn(node) {
    let cur = node;
    for (let depth = 0; depth <= CANCEL_LABEL_MAX_ASCENT && cur; depth++, cur = cur.parentElement) {
      const matches = [...cur.querySelectorAll("a, button, [role='button'], p, span, div")].filter(
        (el) => !el.closest(".cc-ui") && CANCEL_LABEL_RE.test((el.innerText || "").replace(/\s+/g, " ").trim())
      );
      const innermost = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
      if (innermost.length === 1) return innermost[0];
      if (innermost.length > 1) return null;
    }
    return null;
  }

  function autoRevealCollapsedCancellation(doc, node, dateContext, sig, opts = {}) {
    if (isAnyModalOpen(doc)) { dbg("reveal 중단: 이미 모달 열림"); return; }

    // "시도함" 표시는 실제로 뭔가 눌렀을 때만 남긴다(클릭 직전). 트리거를 못 찾거나 안전하지
    // 않다고 판단해 누르지 않은 경우까지 영구 포기 처리하면, 스크롤 중 잠깐 포커스된 행이
    // (DOM이 아직 다 안 그려졌다거나 하는 일시적 이유로) 한 번 실패한 뒤 다시 포커스돼도
    // 영영 재시도가 안 된다(실사용자 리포트: 일부 요금제만 계속 "?"로 남음). 실제로 클릭한
    // 뒤(아래)에는 그대로 영구 포기한다 — 이미 누른 걸 또 누르는 게 더 위험하다.
    const customTrigger = window.__ccSites?.current()?.cancellation?.revealTrigger;
    let trigger;
    if (customTrigger) {
      // 캐시 키가 이제 노드가 아니라 문자열 서명(sig)이라 "지금 보고 있는 요금 행"을
      // 서명에서 되짚을 수 없다 — 대신 취소 문구 노드에서 요금 행 선택자(hints.rateRow)로
      // 가장 가까운 조상을 찾아 scope로 되돌린다(찾는 방향이 반대일 뿐 결과는 같다).
      const rateRowSel = window.__ccSites?.hint("rateRow");
      const scope = rateRowSel ? node.closest(rateRowSel) : null;
      try {
        trigger = customTrigger(scope, node);
      } catch (e) {
        trigger = null;
      }
      if (!trigger) { dbg("reveal 중단: 어댑터가 트리거를 못 찾음 — 다음 포커스에서 재시도"); return; }
    } else if (opts.viaLabel) {
      const label = findCancelLabelIn(node);
      if (!label) { dbg("reveal 중단: 행 안에서 '취소 정책' 라벨을 하나로 특정 못함"); return; }
      trigger = findClickTarget(label);
    } else {
      trigger = findClickTarget(node);
    }
    dbg("reveal 시도 — 클릭 대상:", trigger?.tagName, `"${(trigger?.innerText || "").slice(0, 20)}"`,
        "| 상세트리거 발견:", !!findDetailTrigger(node));
    if (!isSafeAutoClickTarget(trigger)) {
      dbg("reveal 중단: 실제 이동 링크로 판명됨");
      return;
    }
    // "시도함" 표시와 속도 제한 기록은 **실제로 클릭하기 직전**에 남긴다 — 위에서
    // 중단된 경우까지 세면 멀쩡한 요금제가 영구 포기되거나 차단기에 걸린다.
    collapsedRevealAttempted.add(sig);
    lastRevealAt = Date.now();
    revealCount += 1;
    // 사용자가 "내가 뭘 잘못 눌렀나" 싶지 않도록 카드에 한 줄 띄운다.
    showRevealNotice(true);

    // 실사용 리포트(Booking.com): 요금제를 선택해 모달을 자동으로 열고/읽고/닫는 동안
    // 페이지가 맨 위로 스크롤됐다. 사이트마다 모달을 열거나 닫을 때(포커스 이동 등으로)
    // 스크롤을 건드리는 방식이 다 달라서 원인을 하나로 특정해 막기보다, 우리가 자동으로
    // 누르는 두 클릭(열기·닫기) 앞뒤로 스크롤 위치를 붙잡아두는 쪽이 더 일반적이고
    // 안전하다 — 그 사이트의 모달 코드를 고치는 게 아니라 "우리가 건드린 부작용을
    // 되돌리는" 접근이라 다른 사이트(Agoda/Trip.com)에도 위험 없이 적용된다.
    const savedScrollX = window.scrollX;
    const savedScrollY = window.scrollY;
    function restoreScroll() {
      if (window.scrollX !== savedScrollX || window.scrollY !== savedScrollY) {
        window.scrollTo(savedScrollX, savedScrollY);
      }
    }
    function clickPreservingScroll(el) {
      el.click();
      restoreScroll();
      // 포커스 이동에 따른 scrollIntoView 는 클릭 직후가 아니라 다음 페인트에 걸리는
      // 경우가 있어(실측 추정) 한 프레임 뒤에도 한 번 더 확인한다.
      requestAnimationFrame(restoreScroll);
    }

    try {
      clickPreservingScroll(trigger);
    } catch (e) {
      dbg("클릭 실패:", e.message);
      showRevealNotice(false);
      return;
    }

    const start = Date.now();

    // 예전엔 모달이 뜨면 무조건 250ms 기다린 뒤 읽었다. 내용이 이미 준비된 경우에도
    // 그만큼 손해라 객실을 옮길 때마다 느리게 느껴졌다(실측 피드백). 고정 대기 대신
    // "실제로 읽히는지"를 40ms 간격으로 확인하고, 읽히는 즉시 닫고 다시 그린다.
    const readWhenReady = (tries) => {
      const revealed = safely("cancellation.findModalCancellationBlock(폴링)", () => window.__ccCancellation.findModalCancellationBlock(doc, dateContext), null);
      if (!revealed && tries > 0) {
        setTimeout(() => readWhenReady(tries - 1), 40);
        return;
      }
      dbg("모달에서 읽음:", revealed
        ? `status=${revealed.status} steps=${(revealed.lossSteps || []).length} → ` +
          JSON.stringify((revealed.lossSteps || []).map((st) => ({
            날짜: st.thresholdDate ? fmtLocalISO(st.thresholdDate) : null,
            퍼센트: st.percent,
            첫1박: st.usesFirstNight,
          })))
        : "실패");
      const mv = visibleModals(doc)[0];
      if (mv) dbg("모달 원문 ↓\n" + (mv.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600));
      if (revealed) collapsedRevealCache.set(sig, revealed);
      // 닫기도 우리가 자동으로 누르는 클릭이라 여는 쪽과 같은 스크롤 보정을 건다(위
      // clickPreservingScroll 주석 참고).
      closeAnyOpenModal(doc);
      restoreScroll();
      requestAnimationFrame(restoreScroll);
      showRevealNotice(false);
      if (lastDoc) runBriefing(lastDoc, lastDarkFindings);
    };

    const poll = () => {
      // 사이트가 자기 모달 찾는 법(cancellation.modal 훅)을 알려줬으면, "아무 role=dialog나
      // 열려 있음"이 아니라 "그 사이트의 모달이 열려 있음"만 본다. 실측(Booking.com,
      // 2026-09): 우리가 방금 연 것과 무관한 다른 role=dialog(지도 등)가 이미 화면에
      // 있으면 isAnyModalOpen이 true가 돼서, 아직 애니메이션 중이라 안 뜬 우리 모달을
      // 기다리지 않고 곧바로 아래의 짧은 readWhenReady(10, 최대 400ms) 로 넘어가 버렸다.
      // 우리 모달이 그보다 늦게(애니메이션 때문에) 뜨면 이 400ms 안에 못 잡고 영구
      // 포기했다 — 위 findModalCancellationBlock 수정과 짝을 이루는 처방이다.
      const hasSiteModalHook = !!window.__ccSites?.current()?.cancellation?.modal;
      const ourModalOpen = hasSiteModalHook ? !!window.__ccSites?.cancellationModal(doc) : isAnyModalOpen(doc);
      if (ourModalOpen) {
        readWhenReady(10); // 최대 400ms
        return;
      }
      if (Date.now() - start < AUTO_REVEAL_TIMEOUT_MS) {
        setTimeout(poll, 40);
        return;
      }
      dbg("reveal 타임아웃 — 모달이 안 열렸음 (인라인 확장일 가능성)");
      showRevealNotice(false); // 안 열렸어도 안내는 반드시 걷는다
    };
    poll(); // 즉시 한 번 확인 — 클릭과 동시에 열리는 경우가 많다
  }

  // 요금 행 판정은 DOM 포함관계가 아니라 **세로 위치**로 한다.
  //
  // 펼쳐서 나온 요금들은 형제로 나란히 있어서, 조상을 타고 올라가는 방식은 부모에 요금이
  // 이미 여러 개라 즉시 멈춘다 → 히트 영역이 87px 노드 자신이 되고, 시각적 행(266px)의
  // 나머지 179px에 커서를 두면 아무 행에도 안 걸려 직전 값이 남는다
  // (실측: 12개 중 4개가 항상 770,000 · 디럭스 킹베드로 고정).
  //
  // 그래서 각 요금의 "구간"을 [자기 top, 다음 요금 top) 으로 잡고 커서 Y가 어디 속하는지만
  // 본다. 노드가 나중에 추가돼도 리스너 재바인딩이 필요 없고, DOM 구조가 바뀌어도 견딘다.
  // 선택자는 사이트 어댑터(hints.rateRow)가 준다. 힌트가 없으면 호버 미리보기를 끈다.
  const offerNodes = () => {
    const sel = window.__ccSites?.hint("rateRow");
    return sel ? [...document.querySelectorAll(sel)] : [];
  };

  function offerRowAtPoint(y) {
    const rows = offerNodes()
      .map((o) => {
        const hit = window.__ccPricing?.offerHitTarget?.(o);
        return { o, r: o.getBoundingClientRect(), hitTop: hit ? hit.getBoundingClientRect().top : null };
      })
      .filter(({ r }) => r.height > 0)
      .sort((a, b) => a.r.top - b.r.top);
    // 마지막 행은 "다음 행의 top"이 없어 구간의 끝을 알 수 없다. 예전엔 고정 +240px을 썼는데,
    // 그러면 목록 아래 빈 공간(리뷰 섹션 전까지)이 통째로 마지막 요금 구간이 돼서, 한참
    // 내려가도 마지막 요금이 계속 선택된 채로 남았다. 앞 행들의 간격 중앙값이 곧 실제
    // 시각적 행 높이이므로 그걸 꼬리로 쓴다(행이 하나뿐이면 보수적인 기본값).
    const tail = medianRowGap(rows);
    for (let i = 0; i < rows.length; i++) {
      // 판정 범위의 위쪽을 **객실 카드 상단**까지 넓힌다.
      //
      // 실측 증상 — 첫 요금제만 ✓ 버튼을 누를 수 없었다. 버튼은 카드 우측 **상단**에
      // 띄우는데, 첫 카드는 위에 "《예약 가능한 최저가》" 띠가 붙어 카드 상단이 요금
      // 박스보다 한참 위였다. 그래서 버튼이 판정 범위 밖에 놓였고, 마우스가 버튼으로
      // 가는 도중 호버가 풀려 버튼이 사라졌다.
      // 앞 행의 영역은 침범하지 않도록 잘라낸다.
      const rowTop = rows[i].r.top - 6;
      const cardTop = rows[i].hitTop ?? rowTop;
      let top = Math.min(rowTop, cardTop);
      if (i > 0) top = Math.max(top, rows[i - 1].r.bottom + 1);
      const bottom = i + 1 < rows.length ? rows[i + 1].r.top : rows[i].r.bottom + tail;
      if (y >= top && y < bottom) return rows[i].o;
    }
    return null;
  }

  // 가로 위치까지 보는 판정.
  //
  // 실측 증상 — 커서를 지도·사진 쪽으로 옮겨도 테두리가 안 풀렸다. 원인은 위
  // offerRowAtPoint 가 **세로(Y)만** 본다는 것이었다. 가로로 아무리 움직여도 Y는 그대로라
  // 늘 어떤 행에 걸렸다. 요금 행의 가로 범위를 벗어나면 "행 없음"으로 본다.
  function offerAtPoint(x, y) {
    if (x == null || y == null) return null;
    const offer = offerRowAtPoint(y);
    if (!offer) return null;
    const hit = window.__ccPricing?.offerHitTarget?.(offer) ?? offer;
    const r = hit.getBoundingClientRect();
    if (r.width <= 0) return null;
    if (x < r.left - 8 || x > r.right + 8) return null;
    return offer;
  }

  function medianRowGap(rows) {
    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      const g = rows[i].r.top - rows[i - 1].r.top;
      if (g > 0) gaps.push(g);
    }
    if (!gaps.length) return 120;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 선택(pick) 모델 — 2026-09 개편
  //
  // 예전에는 **호버가 곧 요약**이었다. 마우스를 올린 요금제로 카드가 바뀌고, 그 요금제의
  // 취소조건 원문을 읽으려고 모달까지 열었다. 두 가지가 동시에 문제였다:
  //   · 원하는 옵션을 멈춰서 볼 수가 없다 — 조금만 움직여도 다른 요약으로 바뀐다
  //   · 안 본 요금제는 결국 **전부** 모달을 열어본다 (12개면 12번)
  //
  // 이제는 **클릭이 요약을 정한다**:
  //   호버   → 파란 테두리와 ✓ 버튼만 따라다닌다. 카드는 안 바뀐다
  //   ✓ 클릭 → 그 요금제가 선택된다. 카드가 고정되고, 그때 한 번만 원문을 읽는다
  //   스크롤·마우스 이동 → 선택은 그대로
  //
  // 선택은 배열로 다룬다. 지금은 MAX_PICKS=1 이지만, "숙소 담아두기"(다른 팀원 작업)와
  // 이어 붙일 때 복수 선택으로 늘리기 쉽도록 구조만 미리 열어둔다.
  const MAX_PICKS = 1;
  let picks = []; // [{ sig, index }]
  // 마지막으로 picks를 채운 숙소(hotelId) — 다른 숙소로 넘어가면(runBriefingInner 시작
  // 부분 참고) picks/cardOpen을 리셋하는 기준이다.
  let lastPickHotelId = null;

  // 요금제를 가리키는 안정적인 이름.
  //
  // 전체 텍스트를 쓰면 안 된다 — 실측 증상 "✓ 를 두 번 눌러야 선택된다"의 원인이었다.
  // 요금 박스 안에는 "3시간 전 예약됨", "단 2분이면 충분한 예약 완료!",
  // "당사 남은 객실 4개!" 처럼 **계속 바뀌는 문구**가 섞여 있어서, 클릭한 순간의 텍스트가
  // 다음 스캔에는 이미 달라져 있었다. 그래서 선택을 못 찾고 안내 문구로 되돌아갔다.
  // 금액 숫자는 바뀌지 않으므로 그것만 뽑아 쓴다.
  function offerSig(offer) {
    const text = (offer.innerText || "");
    const nums = (text.match(/[\d][\d,]{3,}/g) || []).slice(0, 4).join("/");
    return nums || text.replace(/\s+/g, " ").trim().slice(0, 60);
  }
  // 선택된 요금제를 지금 DOM에서 찾아 돌려준다. 못 찾으면 null(다른 숙소로 이동 등).
  // 선택자는 사이트 어댑터(hints.rateRow)가 준다 — 하드코딩된 OFFER_SEL 대신 offerNodes().
  function resolvePick() {
    if (!picks.length) return null;
    const p = picks[0];
    const all = offerNodes();
    const matches = all.filter((o) => offerSig(o) === p.sig);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      // 같은 금액이 여러 줄이면 기억해둔 자리를 우선한다. 그것도 안 맞으면 첫 번째 —
      // 선택은 사용자가 명시적으로 한 것이라, 놓치는 것보다 비슷한 걸 쥐는 편이 낫다.
      const atSamePlace = all[p.index];
      return atSamePlace && offerSig(atSamePlace) === p.sig ? atSamePlace : matches[0];
    }
    // 금액까지 바뀐 경우(요금 변동·필터 변경) — 목록 길이가 그대로면 자리로 되찾는다.
    if (all.length === p.total && all[p.index]) return all[p.index];
    return null;
  }

  // 실사용 리포트(Trip.com, 2026-09-24): "선택해도 아예 인식을 못하네". 디버그 로그로 확인—
  // 실제로는 매번 "요금제 선택됨"이 정상적으로 찍히고 총액도 채워졌지만, 그 직후 거의
  // 즉시 "선택 해제"가 따라와 사용자 눈엔 "클릭해도 반영이 안 된다"로 보였다. 원인 —
  // 픽 버튼("✓ 이 요금제 보기")과 픽 칩("✓ 선택됨")은 floatAtTopRight로 같은 행의 같은
  // 좌표에 뜬다. 선택 직후엔 hoverRow와 pickedRow가 같은 행(방금 클릭한 그 행)이라 버튼이
  // 칩으로 그 자리에서 바로 바뀌는데, 사용자 커서는 아직 그 자리에 있다 — 클릭 직후 손이
  // 완전히 멈춰 있지 않거나(트립닷컴은 클릭할 때마다 자기 팝업을 닫는 로직까지 같이
  // 돌아서 재클릭 유도가 더 컸던 것으로 보인다) 확인차 한 번 더 누르면, 방금 뜬 칩을
  // 그대로 눌러 즉시 선택 해제로 들어갔다. 픽 직후 아주 짧은 시간(PICK_COOLDOWN_MS) 동안은
  // 칩 클릭을 "의도한 해제"가 아니라 "방금 그 클릭의 잔향"으로 보고 무시한다.
  const PICK_COOLDOWN_MS = 500;
  let lastPickAt = 0;

  function pickOffer(offer) {
    const all = offerNodes();
    const entry = { sig: offerSig(offer), index: all.indexOf(offer), total: all.length };
    picks = [entry, ...picks].slice(0, MAX_PICKS);
    lastPickAt = Date.now();
    dbg("요금제 선택됨:", entry.sig, "| 자리:", entry.index, "/", entry.total);
    // ✓ 를 누른 것 자체가 "이 요금제를 보겠다"는 뜻이다 — 미니 배지로 뒀다가 한 번 더
    // 누르게 하면 같은 의사표시를 두 번 시키는 셈이다(실사용 피드백).
    // 스크롤로 저절로 열리는 게 아니라 사용자가 직접 누른 경우에만 펼치므로,
    // 예전의 "스크롤하는 내내 열렸다 닫혔다" 문제(cc-open 주석 참고)와는 무관하다.
    cardOpen = true;
    if (lastDoc) runBriefing(lastDoc, lastDarkFindings);
  }

  function clearPicks() {
    if (Date.now() - lastPickAt < PICK_COOLDOWN_MS) {
      dbg("선택 해제 무시 — 방금(", Date.now() - lastPickAt, "ms 전) 선택한 직후");
      return;
    }
    picks = [];
    dbg("선택 해제");
    if (lastDoc) runBriefing(lastDoc, lastDarkFindings);
  }

  // ─── 호버: 테두리와 ✓ 버튼만 움직인다 ────────────────────────────────────
  let hoveredOffer = null;
  let lastClientY = null;
  let lastClientX = null;
  let pointerOverOwnUi = false;
  let hoverMoveThrottle = 0;

  // 호버 대상이 바뀌면 즉시 반영한다(지연 없음).
  // 예전에 버튼이 사라지는 걸 막으려고 지우기를 220ms 늦췄던 적이 있는데, 그건 증상만
  // 가리는 처방이었다 — 진짜 원인은 버튼이 판정 범위 밖에 있던 것이고(offerRowAtPoint
  // 주석 참고), 지연을 두니 스크롤할 때 버튼이 허공에 멈춰 보이는 새 문제가 생겼다.
  function setHoveredOffer(offer) {
    if (hoveredOffer === offer) return;
    hoveredOffer = offer;
    paintOfferMarks();
  }

  function handleHoverMove(e) {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    pointerOverOwnUi = !!e.target?.closest?.(".cc-ui");
    if (pointerOverOwnUi) return; // 우리 UI 위에서는 호버 대상을 바꾸지 않는다
    // 클릭이 요약을 정하는 지금 모델에서는 호버가 카드 내용을 더 이상 바꾸지 않는다 —
    // 예전(호버가 곧 요약이던 시절) 실사용자 리포트("모달 열어둔 채 마우스를 옮기면 뒤에
    // 있는 다른 요금제로 카드가 튐")의 원인 자체가 이제 없다. 다만 모달이 떠 있는 동안
    // 그 뒤에 깔린 행에 테두리·✓ 버튼이 옮겨붙는 것도 굳이 보여줄 이유가 없어 계속 막는다.
    if (isAnyModalOpen(document)) return;
    const now = Date.now();
    if (now - hoverMoveThrottle < 60) return;
    hoverMoveThrottle = now;
    setHoveredOffer(offerAtPoint(e.clientX, e.clientY));
  }
  document.addEventListener("mousemove", handleHoverMove, { capture: true, passive: true });

  // 마우스가 브라우저 창 밖(작업표시줄 등)으로 나가면 mousemove 가 더는 오지 않는다.
  // 그대로 두면 마지막 테두리가 굳으므로 여기서 지운다.
  document.addEventListener("mouseleave", () => {
    lastClientX = lastClientY = null;
    setHoveredOffer(null);
  });

  // 스크롤은 mousemove 를 일으키지 않는다 — 커서는 그대로인데 그 밑의 요금제만 바뀐다.
  // 스크롤이 멈춘 뒤 커서 밑을 다시 본다(스크롤 *중* 에 하면 깜빡인다).
  const REHOVER_AFTER_SCROLL_MS = 120;
  let rehoverTimer = null;
  let repositionQueued = false;
  function scheduleRehoverAfterScroll() {
    // 스크롤이 **도는 동안**에도 떠 있는 표시들은 좌표를 따라가야 한다. 이것들은
    // position:fixed 라 가만히 두면 페이지만 밀리고 표시는 제자리에 멈춰 보인다.
    // 프레임당 한 번으로 묶어 스크롤 성능을 해치지 않게 한다.
    if (!repositionQueued) {
      repositionQueued = true;
      requestAnimationFrame(() => {
        repositionQueued = false;
        paintOfferMarks();
      });
    }
    clearTimeout(rehoverTimer);
    rehoverTimer = setTimeout(() => {
      if (lastClientY == null) return;
      if (pointerOverOwnUi || isWrapHovered) return;
      // 스크롤이 멈췄으니 커서 밑이 바뀌었을 수 있다 — 다시 본다.
      setHoveredOffer(offerAtPoint(lastClientX, lastClientY));
      paintOfferMarks();
    }, REHOVER_AFTER_SCROLL_MS);
  }

  // ─── 페이지 위 표시: 호버 테두리 · 선택 테두리 · ✓ 버튼 ──────────────────
  //
  // 버튼과 칩은 아고다 DOM 안에 넣지 않고 position:fixed 로 **띄워서** 좌표만 맞춘다.
  // 남의 사이트 레이아웃을 밀지 않고, 행이 재렌더돼도 다시 꽂을 필요가 없다.
  // 테두리는 outline 이라 역시 레이아웃에 영향이 없다(레이아웃을 밀지 않는다).
  const OUTLINE_HOVER = "2px dashed rgba(23,61,154,0.45)";
  const OUTLINE_PICK = "3px solid rgba(23,61,154,0.85)";
  let hoverMarkedNode = null;
  let pickMarkedNode = null;
  let pickBtnEl = null;
  let pickChipEl = null;

  function setOutline(node, style) {
    if (!node) return;
    if (style) {
      if (node.__ccPrevRadius === undefined) node.__ccPrevRadius = node.style.borderRadius;
      node.style.outline = style;
      node.style.outlineOffset = "3px";
      node.style.borderRadius = node.style.borderRadius || "10px";
    } else {
      node.style.outline = "";
      node.style.outlineOffset = "";
      node.style.borderRadius = node.__ccPrevRadius || "";
    }
  }

  function ensurePickUi() {
    if (!pickBtnEl) {
      pickBtnEl = document.createElement("button");
      pickBtnEl.type = "button";
      pickBtnEl.className = "cc-ui cc-pick-btn";
      pickBtnEl.textContent = "✓ 이 요금제 보기";
      pickBtnEl.style.cssText =
        "position:fixed; z-index:2147482999; display:none; appearance:none; cursor:pointer;" +
        "padding:5px 10px; border-radius:999px; border:1px solid #173d9a; background:#173d9a;" +
        "color:#fff; font:700 11.5px -apple-system,'Malgun Gothic',sans-serif; line-height:1;" +
        "box-shadow:0 4px 14px rgba(23,61,154,.35);";
      // 아고다 행의 클릭 핸들러로 새지 않게 한다 — 그 자리가 "요금제 선택 → 예약 진행"일 수 있다.
      const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
      pickBtnEl.addEventListener("mousedown", swallow);
      pickBtnEl.addEventListener("click", (e) => {
        swallow(e);
        if (hoveredOffer) pickOffer(hoveredOffer);
      });
      document.documentElement.appendChild(pickBtnEl);
    }
    if (!pickChipEl) {
      pickChipEl = document.createElement("div");
      pickChipEl.className = "cc-ui cc-pick-chip";
      pickChipEl.style.cssText =
        "position:fixed; z-index:2147482998; display:none; padding:4px 9px; border-radius:999px;" +
        "background:#173d9a; color:#fff; font:700 11px -apple-system,'Malgun Gothic',sans-serif;" +
        "line-height:1; box-shadow:0 3px 10px rgba(23,61,154,.3); cursor:pointer;";
      pickChipEl.textContent = "✓ 선택됨";
      pickChipEl.title = "클릭하면 선택을 해제합니다";
      pickChipEl.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        clearPicks();
      });
      document.documentElement.appendChild(pickChipEl);
    }
  }


  // ─── 표 레이아웃(hints.pickAnchor) 전용: 인라인 픽 토글 ───────────────────
  //
  // 실측(2026-09-23) 3연속: position:fixed로 버튼/칩을 "행 밖 어딘가"에 띄우는 접근을
  // 세 번 다르게 시도했지만(행 상단 → 행 하단 → 커서 옆) 전부 실사용 리포트로 문제가
  // 났다 — 행 상단은 부킹닷컴 자신의 UI(수량 선택)와, 행 하단은 옆 행(간격이 0인 경우가
  // 실측됨)과, 커서 옆은 마우스가 다가가면 같이 도망가는 문제. 그리고 유저 피드백:
  // "그냥 행 경계 안에 표시해주면 안돼? 선택하는 항목만 안 가리면 되잖아" +
  // "선택됨으로 바뀔 때 버튼 위치가 바뀌어서 산만해".
  //
  // 그래서 표 레이아웃 사이트는 아예 접근을 바꾼다 — position:fixed 좌표 계산을 그만두고,
  // 인라인 배지(renderInlineBadges)와 똑같이 가격 노드 바로 뒤에 진짜 DOM 형제로 끼워
  // 넣는다. 이러면: 문서 흐름 안에 있어서 다른 행과 절대 안 겹치고(브라우저가 레이아웃을
  // 알아서 함), 호버 여부와 무관하게(모든 행에 항상 하나씩) 있어서 "버튼 → 칩" 전환이 같은
  // DOM 노드의 텍스트만 바뀌는 것이라 위치가 안 바뀐다. Agoda/Trip.com은 hints.pickAnchor를
  // 안 주므로 이 경로를 타지 않고 기존 floatAtTopRight 방식 그대로 유지한다.
  const pickInlineToggles = new WeakMap(); // row(tr) -> 토글 엘리먼트

  function ensureInlineToggle(row, anchor) {
    let btn = pickInlineToggles.get(row);
    // renderInlineBadges도 같은 anchor 뒤에 insertAdjacentElement("afterend", …)로 배지를
    // 끼워 넣는다 — 배지가 나중에 끼어들면 이 버튼의 previousElementSibling이 anchor에서
    // 배지로 바뀐다. 그걸 "떨어져 나갔다"고 오판하면 매 스캔마다 새 버튼을 또 만들어
    // 중복으로 뜬다(실사용 리포트: "이요금제보기가 두개씩떠") — 정확히 그 anchor 뒤에
    // 붙어 있는지가 아니라 아직 이 행 안에 살아있는지만 본다.
    if (btn && btn.isConnected && row.contains(btn)) return btn;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cc-ui cc-pick-inline";
    btn.style.cssText =
      "display:inline-flex; align-items:center; margin-left:8px; padding:3px 9px; border-radius:999px;" +
      "border:1px solid #173d9a; background:#173d9a; color:#fff; font:700 11px -apple-system,'Malgun Gothic',sans-serif;" +
      "line-height:1.4; cursor:pointer; white-space:nowrap; vertical-align:middle;";
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    btn.addEventListener("mousedown", swallow);
    btn.addEventListener("click", (e) => {
      swallow(e);
      if (resolvePick() === row) clearPicks();
      else pickOffer(row);
    });
    anchor.insertAdjacentElement("afterend", btn);
    pickInlineToggles.set(row, btn);
    return btn;
  }

  function paintInlinePickToggles(anchorSel, pickedOffer) {
    for (const row of offerNodes()) {
      const anchor = row.querySelector(anchorSel);
      if (!anchor || !anchor.isConnected) continue;
      const btn = ensureInlineToggle(row, anchor);
      const isPicked = row === pickedOffer;
      btn.textContent = isPicked ? "✓ 선택됨" : "✓ 이 요금제 보기";
      btn.title = isPicked ? "클릭하면 선택을 해제합니다" : "";
    }
  }

  // 요소를 대상 행의 우측 상단에 띄운다. 행이 화면 밖이면 숨긴다. Agoda/Trip.com처럼
  // rateRow 자체가 좁은 카드형 레이아웃인 사이트 전용(위 인라인 토글 주석 참고).
  function floatAtTopRight(el, node) {
    if (!node || !node.isConnected) { el.style.display = "none"; return; }
    const r = node.getBoundingClientRect();
    const offscreen = r.bottom < 0 || r.top > window.innerHeight || r.width <= 0;
    if (offscreen) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.style.visibility = "hidden"; // 폭을 재기 전엔 깜빡이지 않게
    const w = el.offsetWidth;
    el.style.left = Math.max(4, Math.round(r.right - w - 10)) + "px";
    el.style.top = Math.max(4, Math.round(r.top + 8)) + "px";
    el.style.visibility = "visible";
  }

  function paintOfferMarks() {
    ensurePickUi();
    const pickedOffer = resolvePick();
    const pickedRow = pickedOffer ? window.__ccPricing?.offerHitTarget?.(pickedOffer) ?? pickedOffer : null;
    const hoverRow = hoveredOffer ? window.__ccPricing?.offerHitTarget?.(hoveredOffer) ?? hoveredOffer : null;

    // 선택된 행과 호버된 행이 같으면 선택 표시가 이긴다.
    const nextHover = hoverRow && hoverRow !== pickedRow ? hoverRow : null;

    if (hoverMarkedNode !== nextHover) {
      if (hoverMarkedNode && hoverMarkedNode !== pickedRow) setOutline(hoverMarkedNode, null);
      hoverMarkedNode = nextHover;
      setOutline(hoverMarkedNode, OUTLINE_HOVER);
    }
    if (pickMarkedNode !== pickedRow) {
      if (pickMarkedNode) setOutline(pickMarkedNode, null);
      pickMarkedNode = pickedRow;
      setOutline(pickMarkedNode, OUTLINE_PICK);
    } else if (pickedRow) {
      setOutline(pickedRow, OUTLINE_PICK); // 재렌더로 style 이 날아갔을 수 있다
    }

    const anchorSel = window.__ccSites?.hint("pickAnchor");
    if (anchorSel) {
      // 표 레이아웃: 인라인 토글로 대체 — position:fixed 버튼/칩 자체를 안 쓴다.
      paintInlinePickToggles(anchorSel, pickedOffer);
      pickBtnEl.style.display = "none";
      pickChipEl.style.display = "none";
      return;
    }

    // 버튼과 칩은 **객실 카드 우측 상단 모서리**에 띄운다. 요금 박스 기준으로 띄웠더니
    // 가격을 가려서 조잡했다. 카드 상단이 판정 범위 밖으로 벗어나던 문제는
    // offerRowAtPoint 쪽에서 범위를 카드 상단까지 넓혀 해결했다.
    //
    // 스크롤 중에는 ✓ 버튼을 숨긴다 — position:fixed 라 화면 좌표에 머물러 있어서,
    // 페이지가 밀려 내려가면 버튼만 엉뚱한 자리에 멈춰 떠 있는 것처럼 보였다(실측).
    if (hoverRow && hoverRow !== pickedRow && !isScrolling) floatAtTopRight(pickBtnEl, hoverRow);
    else pickBtnEl.style.display = "none";

    // 선택 칩은 스크롤 중에도 따라다녀야 한다 — "어느 걸 골랐는지"를 잃으면 안 되므로
    // 숨기지 않고 매 스크롤마다 좌표만 다시 맞춘다(repositionFloats).
    if (pickedRow) floatAtTopRight(pickChipEl, pickedRow);
    else pickChipEl.style.display = "none";
  }

  // 미니 배지용 짧은 마감일 — cancellation.deadline은 "2026년 8월 31일"처럼 긴 형식이라
  // "8/31"로 줄인다. "체크인 3일 전"처럼 절대 날짜가 아닌 경우는 그대로 둔다(단정 금지).
  function shortDeadline(deadline) {
    if (!deadline) return null;
    const m = deadline.match(/(\d+)년\s*(\d+)월\s*(\d+)일/);
    return m ? `${m[2]}/${m[3]}` : deadline;
  }

  function miniCancelLabel(cancellation) {
    if (cancellation.status === "free") {
      const short = shortDeadline(cancellation.deadline);
      return short ? `${short}까지 무료취소` : "무료취소 가능";
    }
    if (cancellation.status === "nonrefundable") return "환불 불가";
    return "취소 조건 확인 필요";
  }

  // 오늘~마감~(체크인) 사이 손실액 변화를 가로 타임라인으로 보여준다. 좁은 카드 폭(300px)
  // 안에 들어가야 해서 점 색상은 딱 2단계(0원=초록, 그 외=주황/빨강)로만 구분한다 —
  // 지점이 많아질수록 색을 세분화하면 오히려 알아보기 어려워진다.
  // 타임라인 — 정보는 그대로 두되(사장님도 "기능적으로 좋다"고 확인) 텍스트를 줄이고
  // "오늘" 지점을 링 마커로 강조한다. 각 지점에 네이티브 title 툴팁을 달아서, 클릭하지
  // 않아도 마우스를 올리면 그 날짜의 정확한 손실액을 볼 수 있게 했다(사장님 제안:
  // "hover하면 각 날짜의 세부 조건을 보여주는 방식").
  function renderTimeline(points) {
    if (!points || points.length < 2) return null;

    // "오늘 0원"을 굳이 숫자로 말하면 시선만 뺏긴다 — 정작 중요한 건 "언제부터 돈이
    // 나가는지"다. 오늘 잃을 게 없고 앞으로 한 번만 바뀌는 단순한 경우엔 타임라인 대신
    // 마감일 한 줄로 줄인다(사장님 원칙: 간단한 경우엔 금액을 보여주지 말 것).
    // 값이 처음부터 끝까지 같으면(환불불가) 선을 그릴 이유가 없다 — 정보량 0이다.
    const flat = points.every((p) => !p.unresolved && p.amount === points[0].amount);
    if (flat && points[0].amount > 0) return null;

    const todayFree = points[0]?.label === "오늘" && !points[0].unresolved && points[0].amount <= 0;
    if (todayFree && points.length === 2) {
      const next = points[1];
      const wrapSimple = document.createElement("div");
      wrapSimple.style.cssText = "margin-top:14px; padding-top:12px; border-top:1px solid #eee;";
      wrapSimple.innerHTML = `
        <div class="cc-seclabel" style="display:flex; align-items:center; gap:5px; margin-bottom:7px;">
          <span style="opacity:.75; display:flex;">${icon("calendar", { size: 12 })}</span><span>취소 리스크</span>
        </div>
        <div style="font-size:12.5px; color:var(--cc-muted, #677288); line-height:1.6;">
          <b style="color:var(--cc-ink, #16233d);">${escapeHtml(next.label)}</b>부터 위약금이 시작돼요
          ${next.unresolved ? "" : ` · <b style="color:${LIGHT_COLOR.red};">${escapeHtml(fmtWon(next.amount))}</b>`}
        </div>
      `;
      return wrapSimple;
    }

    // 점–선–점 타임라인. 막대 두 칸이었던 것을 시점이 드러나는 형태로 바꿨다
    // (회의 결정). 진한 채움색은 점과 선에만 쓰고 글자는 읽히는 선까지만 톤을 낮춘다 —
    // 글자까지 연하게 하면 10~11px 에서 대비가 4.5:1 아래로 떨어져 안 읽힌다.
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:15px;";
    const title = document.createElement("div");
    title.className = "cc-seclabel";
    title.style.cssText = "margin-bottom:13px;";
    title.textContent = "취소 리스크";
    wrap.appendChild(title);

    const maxAmount = Math.max(...points.map((p) => p.amount));
    const fillOf = (p) => (p.amount <= 0 ? "var(--cc-safe-fill,#55b189)"
                        : p.amount >= maxAmount ? "var(--cc-risk-edge,#d9705c)"
                        : "var(--cc-risk-fill,#e8967f)");
    const textOf = (p) => (p.amount <= 0 ? "var(--cc-safe,#1b7a52)" : "var(--cc-risk,#c24a3a)");

    // 1행: 점과 선. 마지막 점은 속을 비워 "아직 오지 않은 시점"임을 드러낸다.
    const track = document.createElement("div");
    track.style.cssText = "display:flex; align-items:center;";
    points.forEach((p, i) => {
      const fill = fillOf(p);
      const last = i === points.length - 1;
      if (i > 0) {
        const seg = document.createElement("span");
        seg.style.cssText = `flex-grow:1; height:4px; border-radius:99px; margin:0 3px; background:${fillOf(points[i - 1])};`;
        track.appendChild(seg);
      }
      const dot = document.createElement("span");
      dot.style.cssText = last
        ? `width:10px; height:10px; border-radius:50%; box-sizing:border-box; border:2.5px solid ${fill}; background:#fff; flex:0 0 auto;`
        : `width:10px; height:10px; border-radius:50%; background:${fill}; flex:0 0 auto;`;
      dot.title = `${p.label}: ${p.unresolved ? "정확한 금액은 원문 확인" : fmtWon(p.amount) + " 손실"}`;
      track.appendChild(dot);
    });
    wrap.appendChild(track);

    // 2행: 날짜와 금액. 양 끝은 바깥으로 밀어 점 위치와 눈으로 맞춘다.
    const labels = document.createElement("div");
    labels.style.cssText = "display:flex; justify-content:space-between; margin-top:10px; font-size:11.5px; line-height:1.5;";
    points.forEach((p, i) => {
      const last = i === points.length - 1;
      const align = i === 0 ? "left" : last ? "right" : "center";
      const amountText = p.unresolved ? "?" : p.amount <= 0 ? "0원" : fmtWon(p.amount);
      const col = document.createElement("span");
      col.style.cssText = `text-align:${align}; min-width:0;`;
      col.innerHTML = `<b style="font-weight:700;">${escapeHtml(p.label)}</b><br>` +
        `<span style="color:${textOf(p)}; font-weight:700;">${escapeHtml(amountText)}</span>`;
      labels.appendChild(col);
    });
    wrap.appendChild(labels);
    return wrap;
  }

  // 축 2(리뷰 기반 추가비용) — reviews.js의 buildHiddenCostSummary가 주는
  // { warnings, confirmations }를 그대로 카드로 옮긴다. 절대 원칙: 여기 나오는 금액은
  // "추정"이라 finalPrice(확정 결제액)와 합산해서 보여주지 않는다 — 위약금/예약금액
  // 블록과는 다른(연한 노란) 톤으로 시각적으로 분리해서, "이것도 이미 낸 돈"처럼 오해
  // 하지 않게 한다.
  function renderHiddenCostBlock(hiddenCost) {
    if (!hiddenCost) return null;
    const { warnings, confirmations } = hiddenCost;
    if (!warnings?.length && !confirmations?.length) return null;

    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:14px; padding:10px 14px; border-radius:10px; background:#fdf8ec; border:1px solid #f0e2b8;";

    const title = document.createElement("div");
    title.style.cssText = "display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:#a3841f; margin-bottom:6px;";
    title.innerHTML = `${statusDot("yellow", { size: 7 })}<span>추가비용 가능성 · 리뷰 기반</span>`;
    wrap.appendChild(title);

    if (warnings?.length) {
      // 상위 두 항목 이름으로 요약 문구를 만든다 — "주차비·청소비 관련 최근 리뷰 10건".
      const totalCount = warnings.reduce((sum, w) => sum + w.count, 0);
      const topLabels = warnings.slice(0, 2).map((w) => w.label.replace(/\s*(별도|유료|추가요금)$/, "")).join("·");

      let open = false;
      const summaryRow = document.createElement("div");
      summaryRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none;";
      summaryRow.innerHTML = `
        <span style="font-size:13px; color:#5a4a12;">${escapeHtml(topLabels)} 관련 최근 리뷰 ${totalCount}건</span>
        <span style="display:flex; transition:transform .15s;">${icon("chevronDown", { size: 12, color: "#c4a340" })}</span>
      `;
      const detail = document.createElement("div");
      detail.style.cssText = "margin-top:8px; display:none; font-size:11px; color:#7a6222; line-height:1.8;";
      detail.innerHTML = warnings
        .map((w) => `<div>${escapeHtml(w.label)}${w.amountEstimate ? ` (약 ${fmtWon(w.amountEstimate)})` : ""} — ${w.count}건</div>`)
        .join("");
      summaryRow.addEventListener("click", () => {
        open = !open;
        detail.style.display = open ? "block" : "none";
        summaryRow.querySelector("span:last-child").style.transform = `rotate(${open ? 180 : 0}deg)`;
      });
      wrap.appendChild(summaryRow);
      wrap.appendChild(detail);
    }

    if (confirmations?.length) {
      const confirmWrap = document.createElement("div");
      confirmWrap.style.cssText = warnings?.length ? "margin-top:8px; padding-top:8px; border-top:1px solid #f0e2b8;" : "";
      confirmWrap.innerHTML = confirmations
        .map((c) => `<div style="font-size:11px; color:#3d7a48; margin-top:2px;">✓ ${escapeHtml(c.label)} 조건, 리뷰에서도 확인됨 (${c.count}건)</div>`)
        .join("");
      wrap.appendChild(confirmWrap);
    }

    return wrap;
  }

  // 신규(축 2 확장) — "리뷰에서 확인할 점". reviews.js의 buildReviewRiskSummary가 주는
  // 항목 배열([{claimType,label,negativeCount,positiveCount,sampleSpans,pageClaimSpan,
  // contradictsPage}])을 카드로 옮긴다. hiddenCost(노란 톤, "추가로 낼 돈")와는 성격이
  // 달라서(청결/소음/위치/시설 같은 "경험 품질" 리스크) 색을 파란 톤으로 분리했다 —
  // 노란 블록과 나란히 있어도 "이것도 돈 관련"으로 오해하지 않게. contradictsPage가
  // true인 항목은 페이지 마케팅 문구(pageClaims.js)와 실제 리뷰가 어긋난다는 뜻이라
  // "OO로 표시되어 있지만" 문구를 붙여 더 눈에 띄게 한다.
  function renderReviewRiskBlock(reviewRisks) {
    if (!reviewRisks?.length) return null;

    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:14px; padding:10px 14px; border-radius:10px; background:#eef5fb; border:1px solid #cfe3f2;";

    const title = document.createElement("div");
    title.style.cssText = "display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:#2d6ca3; margin-bottom:6px;";
    title.innerHTML = `${statusDot("yellow", { size: 7 })}<span>리뷰에서 확인할 점</span>`;
    wrap.appendChild(title);

    reviewRisks.forEach((item, i) => {
      let open = false;
      const row = document.createElement("div");
      row.style.cssText = i > 0 ? "margin-top:8px; padding-top:8px; border-top:1px solid #cfe3f2;" : "";

      const summaryRow = document.createElement("div");
      summaryRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none;";
      const headline = item.contradictsPage
        ? `${escapeHtml(item.label)} 표시와 달리, 리뷰 ${item.negativeCount}건에서 언급`
        : `${escapeHtml(item.label)} 관련 리뷰 ${item.negativeCount}건`;
      summaryRow.innerHTML = `
        <span style="font-size:13px; color:#1d4f75;">${headline}</span>
        <span style="display:flex; transition:transform .15s;">${icon("chevronDown", { size: 12, color: "#6ba3cc" })}</span>
      `;

      const detail = document.createElement("div");
      detail.style.cssText = "margin-top:6px; display:none; font-size:11px; color:#3f6f92; line-height:1.7;";
      let detailHtml = "";
      if (item.pageClaimSpan) {
        detailHtml += `<div style="margin-bottom:4px;">페이지 안내: "${escapeHtml(item.pageClaimSpan)}"</div>`;
      }
      detailHtml += item.sampleSpans.map((s) => `<div>· "${escapeHtml(s)}"</div>`).join("");
      if (item.positiveCount > 0) {
        detailHtml += `<div style="margin-top:4px; color:#3d7a48;">✓ 반대로 ${item.positiveCount}건은 문제없다고 언급</div>`;
      }
      detail.innerHTML = detailHtml;

      summaryRow.addEventListener("click", () => {
        open = !open;
        detail.style.display = open ? "block" : "none";
        summaryRow.querySelector("span:last-child").style.transform = `rotate(${open ? 180 : 0}deg)`;
      });

      row.appendChild(summaryRow);
      row.appendChild(detail);
      wrap.appendChild(row);
    });

    return wrap;
  }

  // 폰트 위계를 명확히 준다(사장님 제안) — 큰 숫자(23px bold)는 눈에 바로 들어오고,
  // 라벨(12px semibold, 옅은 회색)은 덜 눈에 띄어야 숫자에 시선이 먼저 간다.
  function bigStat(iconName, label, value, opts) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:14px;";
    const sub = opts?.sub ? `<div class="cc-bigsub" style="margin-top:4px;">${escapeHtml(opts.sub)}</div>` : "";
    wrap.innerHTML = `
      <div class="cc-seclabel" style="display:flex; align-items:center; gap:5px;">
        <span style="opacity:.75; display:flex;">${icon(iconName, { size: 12 })}</span>
        <span>${escapeHtml(label)}</span>
      </div>
      <div class="cc-bigval" style="color:${opts?.color ?? "inherit"}; margin-top:5px;">${value}</div>
      ${sub}
    `;
    return wrap;
  }

  function altColor(status) {
    return status === "free" ? "green" : status === "nonrefundable" ? "red" : "yellow";
  }

  // 데이터 이용 고지 — 구글 정책이 강제하는 유일한 항목이다(2026-07 정책 개정,
  // 2026-08-01 시행). "개인정보처리방침 URL을 제출했으니 고지했다"는 예전 기준이고,
  // 지금은 데이터를 수집하는 **바로 그 화면에서 눈에 띄게** 알려야 한다.
  //
  // 그래서 여기 둔다.
  //   · 원래 체크리스트는 사이드패널이었으나, 사이드패널은 툴바 아이콘을 눌러야 열린다.
  //     리뷰 전송은 카드 쪽에서 일어나므로, 사용자가 문구를 한 번도 못 본 채로 데이터가
  //     이미 나간 상태가 된다.
  //   · 접힘(`세부 조건 · 원문 · 판단 근거`) 안에 넣지 않는다 — 접혀 있으면 "눈에 띄게"가
  //     아니다. 탭 전환과도 무관하게 항상 보이도록 fullEl 맨 아래에 붙인다.
  //
  // ⚠️ 이 문구는 개인정보처리방침(privacy.html)·스토어 대시보드 Privacy 탭과 **말이
  // 같아야 한다.** 세 곳이 서로 다르면 그 자체가 정책 위반이고, 퍼블리셔 계정 전체가
  // 정지될 수 있는 사유다. 한 곳을 고치면 나머지 두 곳도 같이 고칠 것.
  const PRIVACY_URL = "https://dldmsals.github.io/ClearBooking/privacy.html";

  function renderDataNotice() {
    const wrap = document.createElement("div");
    wrap.className = "cc-datanotice";
    wrap.style.cssText =
      "margin:0 14px; padding:9px 0 12px; border-top:1px solid #eee; color:#8a8a8a; font-size:10.5px; line-height:1.55;";
    // 링크는 새 탭으로 연다 — 예약하던 페이지를 덮으면 사용자가 하던 일을 잃는다.
    wrap.innerHTML = `
      이 숙소의 <strong style="font-weight:600; color:#6a6a6a;">공개 리뷰를 불러와 분류 서버로 보내</strong>
      숨은 비용 언급을 찾습니다. 리뷰는 저장하지 않고 분류 후 즉시 폐기합니다.
      가격·취소조건은 브라우저 안에서만 처리하며 어디로도 전송하지 않습니다.
      <a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer"
         style="color:#7a7a7a; text-decoration:underline;">개인정보처리방침</a>
    `;
    return wrap;
  }

  function renderCard({ finalPrice, priceGap, cancellation, cancellationDesc, darkFindings, verdict, lossProjection, comparison, bestAlt, timelinePoints, hiddenCost, reviewRisks, isHoverPreview, scope, doc }) {
    removeCard();
    ensureBriefingStyle();

    cardEl = document.createElement("div");
    cardEl.id = "cc-briefing-wrap";
    cardEl.className =
      "cc-ui cc-briefing-card" +
      (cardOpen ? " cc-open" : "") +
      (isScrolling ? " cc-scrolling" : "");

    // 사용자가 카드 위에 마우스를 올린 동안은(예: 고정 버튼을 누르려고 이동 중)
    // runBriefing이 카드를 재생성하지 않도록 막는다 — 재생성된 새 DOM은 기본(미니)
    // 크기로 시작해서, 그 시점에 커서가 이미 확장된 영역(예: 헤더의 고정 버튼 근처)에
    // 있으면 작아진 새 요소 밖에 있게 돼 :hover가 안 걸리고 그대로 접힌 채 멈춰버린다
    // (사장님 실측: "고정하려고 마우스 움직이는 순간 깜빡이다가 꺼짐"). 마우스가 카드를
    // 떠나면 그 사이 밀린 갱신을 즉시 반영한다.
    cardEl.addEventListener("mouseenter", () => {
      isWrapHovered = true;
    });
    // 클릭 토글 — 펼침 상태(cardOpen)는 모듈 스코프라 재생성돼도 유지된다.
    cardEl.addEventListener("click", (e) => {
      if (suppressNextClick) { suppressNextClick = false; return; } // 방금 드래그였음
      if (e.target.closest("#cc-pin, #cc-save, #cc-list")) return; // 헤더 버튼은 자기 핸들러가 처리
      const onMini = !!e.target.closest(".cc-mini");
      const onHeader = !!e.target.closest(".cc-head");
      if (!onMini && !onHeader) return; // 본문 클릭(세부 조건 토글 등)은 그대로
      // 실사용 리포트(2026-09-24): "저장 목록 창 바깥(=카드)을 클릭했는데 카드까지 닫혀버림".
      // 저장 목록의 바깥클릭-닫기(아래 mousedown 리스너)는 카드 클릭을 "패널을 건드리지
      // 않음"으로 예외 처리해뒀는데, 그 같은 클릭이 이 카드 자체의 헤더 접기/펼치기
      // 토글에도 그대로 걸려서 카드까지 접혔다. 목록 창이 열려 있는 동안은 이 클릭을
      // "카드 접기"가 아니라 "목록 창 닫기"로 우선 처리한다 — 카드 상태는 건드리지 않는다.
      if (savedPanelEl) { closeSavedPanel(); return; }
      cardOpen = !cardOpen;
      cardEl.classList.toggle("cc-open", cardOpen);
    });
    cardEl.addEventListener("mouseleave", () => {
      isWrapHovered = false;
      // 스크롤 중엔 이 mouseleave가 "가짜"일 수 있다 — cc-scrolling이 카드를 미니 배지
      // 크기로 강제로 줄이면, 커서는 그대로인데 박스만 작아지면서 커서가 박스 밖으로
      // 밀려나 브라우저가 자동으로 mouseleave를 쏜다. 이 시점에 즉시 재렌더링하면 아직
      // 스크롤이 안정되지 않아(focus.card가 잠깐 null일 수 있음) 카드가 통째로
      // 사라지는(hide-guard가 removeCard 호출) 버그가 있었다(사장님 실측: "고정 안 된
      // 상태에서 스크롤하려 하면 꺼짐"). 스크롤이 실제로 멈추면 content.js의 통상적인
      // 스캔(900ms 디바운스)이 안정된 포커스로 다시 그려주므로, 여기선 건너뛴다.
      if (isScrolling) return;
      scheduleHoverRescan();
    });

    const miniEl = document.createElement("div");
    miniEl.className = "cc-mini";
    miniEl.style.cssText = `
      align-items: center; gap: 6px; background: #fff; border-radius: 20px; padding: 8px 14px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18); font-family: -apple-system, "Malgun Gothic", sans-serif;
      font-size: 12px; font-weight: 600; color: #222; border-left: 4px solid ${LIGHT_COLOR[verdict.light]};
      white-space: nowrap;
    `;
    // "가격 확인 필요"는 스크롤하면 나온다는 오해를 준다 — 페이지가 매진이면 그렇게 말한다.
    const soldOut = /(예약\s*가능한\s*객실이?\s*없|모든?\s*객실이?\s*매진|매진되었|Sold\s*out)/i.test(
      document.body.innerText || ""
    );
    const miniPriceText = finalPrice
      ? fmtWon(finalPrice.amount)
      : soldOut
      ? "예약 가능한 객실 없음"
      : "가격 확인 필요";
    miniEl.innerHTML = `
      ${statusDot(verdict.light, { size: 8 })}
      <span>${escapeHtml(miniPriceText)}</span>
      <span style="color:#ccc;">·</span>
      <span style="color:#666; font-weight:400;">${escapeHtml(miniCancelLabel(cancellation))}</span>
    `;
    makeDraggable(miniEl);
    cardEl.appendChild(miniEl);

    const fullEl = document.createElement("div");
    fullEl.className = "cc-full";
    // 너비·높이는 여기서 정하지 않는다 — applyCardSize 가 저장값 또는 기본값으로 항상 넣는다.
    fullEl.style.cssText = `overflow-y: auto; font-size: 13px;`;
    cardEl.appendChild(fullEl);
    makeResizable(fullEl);
    applyCardSize();

    const header = document.createElement("div");
    header.className = "cc-head";
    header.style.cssText = "cursor:pointer;";
    // 예약 금액을 헤더(짙은 블록) 안에 넣는다 — 카드에서 가장 먼저 읽혀야 할 값이라
    // 본문 첫 항목이 아니라 제목 자리에 둔다. 본문의 bigStat 은 그래서 생략된다.
    const headAmount = finalPrice
      ? `${escapeHtml(fmtWon(finalPrice.amount)).replace(/원$/, '<span class="cc-won">원</span>')}`
      : `<span style="font-size:19px; font-weight:700;">${escapeHtml(soldOut ? "예약 가능한 객실 없음" : "가격 확인 필요")}</span>`;
    header.innerHTML = `
      <div class="cc-headrow">
        ${brandMarkHtml()}
        <span class="cc-head-title">예약 브리핑</span>
        <span style="flex-grow:1;"></span>
        <button id="cc-list" type="button" class="cc-listbtn${savedPanelEl ? " on" : ""}" title="저장한 숙소 목록">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
        </button>
        <button id="cc-save" type="button" class="cc-save"></button>
        <span id="cc-pin" title="접기" style="cursor:pointer;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"></path></svg>
        </span>
      </div>
      <div style="margin-top:13px;">
        <div class="cc-headlabel">예약 금액</div>
        <div class="cc-headamount">${headAmount}</div>
        <div class="cc-headsub" id="cc-headsub"></div>
      </div>
    `;
    // 저장 버튼 — 카드는 스캔마다 새로 그려지므로 상태는 매번 저장소에서 다시 읽는다.
    const saveBtn = header.querySelector("#cc-save");
    const saveEntry = buildSavedEntry({ doc: doc ?? document, finalPrice, cancellation, verdict, hiddenCost, reviewRisks });
    paintSaveButton(saveBtn, false);
    ccStorage.get(SAVED_KEY, (list) => {
      paintSaveButton(saveBtn, (list ?? []).some((s) => s.key === saveEntry.key));
    });
    saveBtn.addEventListener("mousedown", (e) => e.stopPropagation()); // 드래그 시작 방지
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ccStorage.get(SAVED_KEY, (list) => {
        const cur = list ?? [];
        const exists = cur.some((s) => s.key === saveEntry.key);
        const next = exists
          ? cur.filter((s) => s.key !== saveEntry.key)
          : [{ ...saveEntry, savedAt: Date.now() }, ...cur];
        ccStorage.set(SAVED_KEY, next);
        paintSaveButton(saveBtn, !exists);
      });
    });
    const listBtn = header.querySelector("#cc-list");
    listBtn.addEventListener("mousedown", (e) => e.stopPropagation()); // 드래그 시작 방지
    listBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSavedList();
    });
    // 펼침이 클릭 토글로 바뀌면서 "고정"은 의미가 없어졌다(펼치면 그대로 유지되므로).
    // 같은 자리를 접기 버튼으로 쓴다.
    header.querySelector("#cc-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      cardOpen = false;
      cardEl.classList.remove("cc-open");
    });
    makeDraggable(header);
    fullEl.appendChild(header);

    // 탭 — 예약 요약 / 리뷰 근거. 리뷰 축(축 2)은 윤상 파트가 완성되면 데이터만 꽂으면
    // 되도록 자리를 먼저 만들어 둔다. 데이터가 없으면 안내 문구를 보여준다.
    const tabs = document.createElement("div");
    tabs.className = "cc-tabs";
    const reviewCount =
      ((hiddenCost?.warnings?.length ?? 0) + (hiddenCost?.confirmations?.length ?? 0) + (reviewRisks?.length ?? 0)) || 0;
    tabs.innerHTML = `
      <button data-tab="brief" class="${activeTab === "brief" ? "on" : ""}">예약 요약</button>
      <button data-tab="reviews" class="${activeTab === "reviews" ? "on" : ""}">리뷰 근거${
        reviewCount ? `<span class="cc-tabcount">${reviewCount}</span>` : ""
      }</button>
    `;
    fullEl.appendChild(tabs);

    const reviewPane = document.createElement("div");
    reviewPane.className = "cc-pane";
    reviewPane.style.cssText = "padding: 0 14px 14px;";

    const body = document.createElement("div");
    body.className = "cc-pane";
    body.style.cssText = `padding: 0 14px 14px;`;

    const syncPanes = () => {
      body.hidden = activeTab !== "brief";
      reviewPane.hidden = activeTab !== "reviews";
      tabs.querySelectorAll("button").forEach((btn) => {
        btn.classList.toggle("on", btn.dataset.tab === activeTab);
      });
    };
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      e.stopPropagation();
      activeTab = btn.dataset.tab;
      syncPanes();
    });

    // === ① 예약 금액 — 손실 헤드라인보다 먼저 온다. 아고다는 세금·수수료 포함된 진짜
    // 총액을 작게 표시하는 경우가 많아서(그래서 Price Truth 서브라인이 있음), "화면에서
    // 본 가격은 잊고 실제로 내는 돈은 이거다"라는 정정 자체가 이미 하나의 결론이다.
    // 손실 %(②)도 이 총액을 기준으로 계산된 값이라, 총액을 먼저 확정해야 "41% 손실"이
    // 뭘 기준으로 한 41%인지 바로 이해된다(사장님 지적 — 순서를 뒤집었다).
    let priceSubLine = null, roomLine = null;
    if (finalPrice) {
      // "Price Truth" — 표시가와 실제 총액이 다를 수 있는 두 경우(1박당 표시가를 박수만큼
      // 곱해야 하는 경우 / 화면에 크게 보이는 가격과 총액 라벨이 다른 경우)를 한 줄로
      // 보여준다. 다크패턴이라는 말을 안 써도 "놓칠 수 있는 가격 구조"가 바로 드러난다.
      let priceSub = null;
      if (finalPrice.nights) {
        priceSub = `1박 ${fmtWon(finalPrice.perNightAmount)} × ${finalPrice.nights}박 · 세금·수수료 포함`;
      } else if (priceGap) {
        const diff = priceGap.totalAmount - priceGap.headlineAmount;
        priceSub = `화면 표시가보다 ${diff > 0 ? "+" : ""}${fmtWon(diff)}`;
      }
      // 금액 자체는 헤더로 올라갔다. 여기서는 그 밑줄(1박 단가·객실명)만 채운다.
      priceSubLine = priceSub;
      // 어느 요금제를 보고 있는지 카드에 밝힌다. 커서가 행 사이 빈 영역에 있으면 직전
      // 값이 그대로 남는데(선택 유지 설계), 금액만 있으면 어긋난 걸 알아챌 방법이 없다
      // (실측 지적). 객실명이 있으면 사용자가 바로 대조할 수 있다.
      // 부가 정보라 실패해도 카드 전체를 죽이면 안 된다 — 실제로 이 한 줄 때문에
      // runBriefing 이 매 스캔 예외를 던져 카드가 통째로 사라진 적이 있다.
      let roomLabel = null, occ = null;
      try {
        if (scope && scope !== doc && scope !== EMPTY_SCOPE) {
          roomLabel = extractRoomLabel(scope);
          occ = extractOccupancy(scope);
        }
      } catch (e) { /* 라벨은 생략 */ }
      roomLine = [roomLabel, occ].filter(Boolean).join(" · ") || null;
    }

    // 헤더 밑줄에 한 번에 넣는다 — 두 줄(1박 단가 / 객실명)이 같은 톤이라 붙여 둔다.
    const headSub = fullEl.querySelector("#cc-headsub");
    if (headSub) {
      const lines = [priceSubLine, roomLine].filter(Boolean).map(escapeHtml);
      if (lines.length) headSub.innerHTML = lines.join("<br>");
      else headSub.remove();
    }

    // === ② 지금 상태 — headline(오늘 취소하면 얼마 손실)과 예전엔 따로 있던
    // "오늘 취소 시 손실액" bigStat이 같은 정보를 두 번 말하고 있었다(사장님 지적).
    // 이제 하나로 합치고, 상태 자체("위약금 적용 중" 등)는 작은 배지로만 곁들인다.
    const statusBox = document.createElement("div");
    statusBox.className = "cc-statusbox " + (verdict.light === "green" ? "cc-safe" : "cc-risk");
    statusBox.innerHTML = `
      <span class="cc-statusdot"></span>
      <div style="min-width:0;">
        <div class="cc-status-badge">${escapeHtml(statusBadgeLabel(cancellation, lossProjection))}</div>
        <div class="cc-status-title">${escapeHtml(verdict.headline)}</div>
        ${verdict.sub ? `<div class="cc-status-sub">${escapeHtml(verdict.sub)}</div>` : ""}
      </div>
    `;
    body.appendChild(statusBox);

    // 위약금이 세금·봉사료 제외 금액 기준이라고 원문이 밝힌 요금제 — 우리가 보여주는 손실액은
    // 세금 포함 총액에 퍼센트를 곱한 값이라 실제보다 조금 클 수 있다. 계산을 바꾸지 않고 안내만.
    if (cancellation.feeExcludesTax && cancellation.lossSteps?.length) {
      const taxNote = document.createElement("div");
      taxNote.style.cssText = "margin-top:8px; font-size:11px; line-height:1.5; color:var(--cc-muted, #677288);";
      taxNote.textContent = "위약금은 세금·봉사료를 뺀 금액 기준이라, 실제 손실은 표시된 금액보다 조금 낮을 수 있어요.";
      body.appendChild(taxNote);
    }

    // 무료취소 마감을 캘린더로 — 마감이 확실히 읽힌 무료취소일 때만(buildCalendarEvent 주석 참고).
    const calEvent = safely("buildCalendarEvent", () => buildCalendarEvent({ doc: doc ?? document, cancellation, lossProjection, finalPrice }), null);
    if (calEvent) {
      // 버튼 이름만으로는 무슨 일을 하는지 안 보인다(실사용 피드백: ".ics"가 뭔지, 구글 캘린더 버튼이 뭘 하는
      // 건지 모르겠다). 위에 "무료취소 마감일 등록"이라고 행동을 먼저 말하고, 버튼은 어디에 등록하는지만 적는다.
      const calBox = document.createElement("div");
      calBox.style.cssText = "margin-top:10px; display:flex; flex-direction:column; gap:6px;";
      const calCaption = document.createElement("div");
      calCaption.style.cssText = "display:flex; align-items:center; gap:5px; font-size:11.5px; font-weight:700; color:var(--cc-ink);";
      calCaption.innerHTML = `<span style="display:flex; opacity:.75;">${icon("calendar", { size: 12 })}</span><span>무료취소 마감일 등록</span>`;
      const calRow = document.createElement("div");
      calRow.style.cssText = "display:flex; gap:6px; flex-wrap:wrap; align-items:center;";
      const pillCss =
        "display:inline-flex; align-items:center; gap:5px; padding:6px 10px; border-radius:999px; cursor:pointer;" +
        "font-family:inherit; font-size:11.5px; font-weight:600; line-height:1; color:var(--cc-navy); background:#eef3ff; border:1px solid #cfdcfb;";
      const mkPill = (label, title, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.style.cssText = pillCss;
        b.title = title;
        b.innerHTML = `<span>${escapeHtml(label)}</span>`;
        b.addEventListener("mousedown", (e) => e.stopPropagation()); // 드래그 시작 방지
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick(b);
        });
        return b;
      };
      const flash = (b, text) => {
        const span = b.querySelector("span:last-child");
        const before = span.textContent;
        span.textContent = text;
        setTimeout(() => { if (span.isConnected) span.textContent = before; }, 1600);
      };
      calRow.appendChild(
        mkPill("Google 캘린더", "구글 캘린더를 새 탭으로 열어 마감일 일정을 추가해요 — 이때 숙소명·마감일이 구글로 전달돼요", () => {
          window.open(googleCalendarUrl(calEvent), "_blank", "noopener");
        })
      );
      calRow.appendChild(
        mkPill("다른 캘린더 (.ics)", "애플·네이버·아웃룩 등 어떤 캘린더에서도 열 수 있는 일정 파일(.ics)을 내려받아요 — 마감 하루 전 오전 9시에 알려줘요", (b) => {
          safely("downloadIcs", () => downloadIcs(calEvent), null);
          flash(b, "내려받았어요");
        })
      );
      calBox.appendChild(calCaption);
      calBox.appendChild(calRow);
      body.appendChild(calBox);
    }

    // 자동 펼치기 안내 — 확장이 취소조건 원문을 읽으려고 모달을 잠깐 열 때만 보인다.
    // 예고 없이 화면이 번쩍이면 "내가 뭘 잘못 눌렀나" 싶어지므로 이유를 밝힌다.
    // 평소엔 hidden이고 showRevealNotice()가 껐다 켠다(재렌더 없이 DOM만 토글).
    const revealNote = document.createElement("div");
    revealNote.id = "cc-reveal-note";
    revealNote.hidden = !revealInProgress;
    revealNote.style.cssText =
      "margin-top:8px; padding:8px 10px; border-radius:8px; background:var(--cc-navy-soft);" +
      "border:1px solid var(--cc-navy-line); color:var(--cc-navy); font-size:11.5px; line-height:1.5;";
    revealNote.textContent = "취소조건 원문을 읽는 중이에요 — 잠깐 창이 열렸다 닫힙니다.";
    body.appendChild(revealNote);

    // === ③ 취소 리스크(타임라인) ===
    const timelineEl = renderTimeline(timelinePoints);
    if (timelineEl) body.appendChild(timelineEl);

    // === 추가비용 가능성(리뷰 기반, 축 2) — "확정 → 확정 리스크 → 추정 → 대안" 신뢰도
    // 위계에 따라 확정 블록(①~③)과 대안 블록(④) 사이, 추정 정보 자리에 놓는다.
    const hiddenCostEl = renderHiddenCostBlock(hiddenCost);
    if (hiddenCostEl) reviewPane.appendChild(hiddenCostEl);

    // === 리뷰에서 확인할 점(리스크 4종, 축 2 확장) — 같은 "추정" 신뢰도 단계라 hiddenCost
    // 바로 옆에 둔다. 페이지 자체 설명(pageClaims.js)과 대조된 항목(contradictsPage)은
    // 블록 내부에서 이미 상단으로 정렬돼 있다(reviews.js의 정렬 기준).
    const reviewRiskEl = renderReviewRiskBlock(reviewRisks);
    if (reviewRiskEl) reviewPane.appendChild(reviewRiskEl);

    // 축 2(윤상) — review-tab 모듈이 수집·분석·렌더를 전부 맡는다. 붙이는 순간 자동으로
    // 리뷰를 모으기 시작하고, 결과가 쌓일 때마다 스스로 다시 그린다.
    // 카드는 스캔마다 재생성되므로 컨트롤러를 매번 새로 붙이면 수집이 계속 초기화된다 —
    // 마운트 지점(reviewHost)을 카드 밖에서 한 번만 만들어 재사용하고, 재생성 시엔
    // 그 노드를 새 페인으로 옮기기만 한다.
    mountReviewHost(reviewPane);

    // === ④ 더 나은 선택 — 가장 강한 기능이라 독립된 카드로 강조한다(사장님 제안:
    // "위험 분석을 했다"보다 "더 좋은 선택까지 찾아줬다"가 훨씬 강하게 느껴진다).
    if (bestAlt) {
      const altWrap = document.createElement("div");
      // 시안과 톤을 맞춘다 — 테두리를 없애고 위쪽 구분선 + 연한 바탕만.
      altWrap.style.cssText = "margin-top:15px; padding-top:14px; border-top:1px solid var(--cc-line,#eceef1);";
      const strengthLabel = bestAlt.strength === "strong" ? "같은 객실의 다른 요금제" : "다른 옵션 (방/조건이 다를 수 있어요)";
      const labelText = [bestAlt.entry.roomLabel, bestAlt.entry.occupancy ? `(${bestAlt.entry.occupancy})` : null].filter(Boolean).join(" ");
      const diff = finalPrice ? finalPrice.amount - bestAlt.entry.amount : null;
      const saveText = diff == null ? null : diff > 0 ? `${fmtWon(diff)} 절약` : `${fmtWon(-diff)} 추가`;
      const cancelGain = bestAlt.entry.cancellation.status === "free" && !bestAlt.cancellationSame ? " + 무료취소" : "";

      // "대신 뭘 포기하는지" — 가격만 보여주면 조건이 다른 방을 같은 상품처럼 오해할 수
      // 있다(사장님 제안). 확실히 달라진 방 속성은 "−"로, 취소조건은 동일/개선/악화에
      // 따라 "✓/+/−"로 구분해 보여준다.
      const tradeoffLines = bestAlt.attrDiffs.map((d) => `− ${d}`);
      if (bestAlt.currentCancelStatus != null) {
        if (bestAlt.cancellationSame) {
          tradeoffLines.push("✓ 취소 조건 동일");
        } else if (bestAlt.entry.cancellation.status === "free") {
          tradeoffLines.push("+ 무료취소 가능");
        } else if (bestAlt.currentCancelStatus === "free") {
          tradeoffLines.push("− 무료취소 → " + (bestAlt.entry.cancellation.status === "nonrefundable" ? "환불 불가" : "조건부 환불"));
        }
      }
      const tradeoffHtml = tradeoffLines.length
        ? `<div style="margin-top:6px; font-size:11px; color:#5a8a63; line-height:1.6;">${tradeoffLines
            .map((l) => `<div>${escapeHtml(l)}</div>`)
            .join("")}</div>`
        : "";

      altWrap.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; color:#1a7a2e; font-size:12px; font-weight:600;">
          <span style="display:flex;">${icon("sparkle", { size: 13, color: "#1a7a2e" })}</span>
          <span>더 나은 옵션 발견</span>
        </div>
        <div style="margin-top:6px; font-size:15px; font-weight:600; color:#16401e;">${escapeHtml((saveText ?? "") + cancelGain)}</div>
        <div style="color:#5a8a63; font-size:11px; margin-top:2px;">${escapeHtml(bestAlt.reason)}</div>
        <div style="color:#7a9c81; font-size:10px; margin-top:2px;">${escapeHtml(strengthLabel)}${labelText ? " · " + escapeHtml(labelText) : ""}</div>
        ${tradeoffHtml}
      `;

      if (bestAlt.othersCount > 0) {
        // 카드에서 유일한 "누를 것"이라 꽉 찬 버튼으로 세운다(시안).
        const ctaRow = document.createElement("button");
        ctaRow.type = "button";
        ctaRow.className = "cc-cta";
        ctaRow.style.cssText = "margin-top:12px; width:100%; border:0; cursor:pointer; font-family:inherit;";
        const ctaLabel = () => (othersOpen ? "다른 옵션 접기" : `옵션 비교하기 (${bestAlt.othersCount}개 더)`);
        ctaRow.innerHTML = `<span>${ctaLabel()}</span>`;
        const othersList = document.createElement("div");
        othersList.style.cssText = `margin-top:6px; display:${othersOpen ? "block" : "none"};`;
        othersList.innerHTML = comparison
          .filter((e) => e.amount !== finalPrice?.amount && e.amount !== bestAlt.entry.amount)
          .map((e) => {
            const labelText2 = [e.roomLabel, e.occupancy ? `(${e.occupancy})` : null].filter(Boolean).join(" ");
            return `<div style="display:flex; align-items:center; gap:6px; padding:3px 0; font-size:11px;">
              ${statusDot(altColor(e.cancellation.status), { size: 6 })}
              <span>${fmtWon(e.amount)} <span style="color:#999;">${escapeHtml(labelText2.slice(0, 22))}</span></span>
            </div>`;
          })
          .join("");
        ctaRow.addEventListener("click", () => {
          othersOpen = !othersOpen;
          othersList.style.display = othersOpen ? "block" : "none";
          ctaRow.querySelector("span").textContent = ctaLabel();
        });
        altWrap.appendChild(ctaRow);
        altWrap.appendChild(othersList);
      }
      body.appendChild(altWrap);
    }

    // === 하단: "세부 조건 · 원문 · 판단 근거" — 취소 마감 상세, 노쇼 안내, 화면-총액
    // 격차 설명, 원문 인용을 전부 여기 하나로 접어둔다. 첫 화면엔 결론만 남기고 나머지는
    // 필요할 때만 펼치게 한다(사장님 원칙: "분석한 정보 100% → 기본 노출 30% → 나머지는
    // 펼치기").
    const toggle = document.createElement("div");
    toggle.style.cssText =
      "margin-top:14px; padding-top:10px; border-top:1px solid #eee; display:flex; align-items:center; justify-content:space-between; color:#999; font-size:11px; font-weight:600; cursor:pointer; user-select:none;";
    toggle.innerHTML = `<span>세부 조건 · 원문 · 판단 근거</span><span style="display:flex; transform:rotate(${detailOpen ? 180 : 0}deg); transition:transform .15s;">${icon("chevronDown", { size: 12, color: "#98a0ac" })}</span>`;
    const detail = document.createElement("div");
    detail.style.cssText = `margin-top:8px; display:${detailOpen ? "block" : "none"};`;

    let detailHtml = "";
    detailHtml += `<div style="margin-bottom:8px; color:#666; font-size:11px;"><strong style="color:#888; font-weight:600;">취소 조건</strong> · ${escapeHtml(
      cancellation.status === "free" ? (cancellation.deadline ? `${cancellation.deadline}까지 무료취소` : "무료취소 가능") : cancellationDesc.headline
    )}</div>`;
    if (cancellation.noShowNote) {
      detailHtml += `<div style="margin-bottom:8px; padding:6px 8px; background:#f7f7f7; border-radius:6px; font-size:11px; color:#666;">${escapeHtml(cancellation.noShowNote)}</div>`;
    }
    if (priceGap) {
      const pct = Math.round(Math.abs(priceGap.deltaPct) * 100);
      detailHtml += `<div style="margin-bottom:8px; color:#555; font-size:11px;">화면에 크게 보이는 가격(${fmtWon(priceGap.headlineAmount)})과 실제 총액이 ${pct}% 차이나요.</div>`;
    }
    if (cancellationDesc.raw) {
      detailHtml += `<div style="color:#999; font-size:11px; font-style:italic; margin-bottom:8px;">취소 조건 원문: "${escapeHtml(cancellationDesc.raw.slice(0, 500))}"</div>`;
    }
    detail.innerHTML = detailHtml;

    toggle.addEventListener("click", () => {
      detailOpen = !detailOpen;
      detail.style.display = detailOpen ? "block" : "none";
      toggle.querySelector("span:last-child").style.transform = `rotate(${detailOpen ? 180 : 0}deg)`;
    });
    body.appendChild(toggle);
    body.appendChild(detail);

    fullEl.appendChild(body);
    fullEl.appendChild(reviewPane);
    fullEl.appendChild(renderDataNotice());
    syncPanes();
    applyCardPos();
    document.documentElement.appendChild(cardEl);
  }

  // 카드 구조는 있는데(hasCardStructure=true) 지금 화면엔 하나도 안 보일 때 쓰는 빈
  // 스코프 — 문서 전체로 폴백하면 화면 밖 다른 요금제 정보가 섞여 들어오므로, 차라리
  // "아무것도 찾지 못함" 상태를 그대로 유지한다.
  const EMPTY_SCOPE = { querySelectorAll: () => [] };

  // 포커스 = 사용자가 ✓ 로 고른 요금제 하나. 안 골랐으면 없다.
  //
  // 예전에는 여기서 "뷰포트 중앙에 제일 가까운 카드"를 추측하고, 히스테리시스로 튐을
  // 막고, 호버로 덮어쓰는 3중 구조였다. 그 추측이 곧 "멈춰서 볼 수가 없다"의 원인이었다
  // (스크롤이나 마우스를 조금만 움직여도 다른 요약으로 바뀜). 이제는 추측하지 않는다 —
  // 사용자가 고른 것만 보여주고, 안 골랐으면 고르라고 안내한다.
  function resolveFocus() {
    const picked = resolvePick();
    if (!picked) return { card: null, hasCardStructure: true, dist: Infinity };
    const row = window.__ccPricing?.offerHitTarget?.(picked) ?? picked;
    return { card: row, hasCardStructure: true, dist: 0 };
  }

  // 세 항목을 각각 감싼다 — 가격 추출이 실패해도 취소조건은 그려야 하고, 그 반대도
  // 마찬가지다. 하나가 던져서 셋 다 비면 사용자는 카드가 고장난 줄 안다.
  function extractFromScope(doc, scope, dateContext) {
    return {
      finalPrice: safely("pricing.computeFinalPrice", () => window.__ccPricing.computeFinalPrice(doc, scope), null),
      priceGap: safely("pricing.findPriceGap", () => window.__ccPricing.findPriceGap(doc, scope), null),
      cancellation: safely("cancellation.buildCancellationSummary", () => window.__ccCancellation.buildCancellationSummary(doc, scope, dateContext), emptyCancellation()),
    };
  }

  /**
   * darkFindings 매개변수는 다크패턴 기능 분리 이후 항상 undefined다(하위 호환을 위해
   * 시그니처만 남겨둠) — 실제로 읽는 곳은 없다.
   */
  // 실측(2026-10): 아고다가 검색결과 위에 숙소 상세를 오버레이로 띄우는 방식을 쓴다 — URL
  // 경로는 그대로 /search 인데 selectedproperty=<숫자> 쿼리로 어떤 숙소를 보여주는지 표시한다
  // (예: /ko-kr/search?selectedproperty=5435717&...&hotel=5435717&...). 이 경우 페이지 HTML에
  // hotel_id= 문자열 자체가 0건이라 currentHotelId()의 스캔 방식이 애초에 안 통하고, 아래
  // isListingPage도 "/search"만 보고 무조건 목록으로 판정해 카드 자체가 사라졌다(실사용자
  // 리포트로 발견 — v1.0.0 게시본에도 있던 문제). selectedproperty(또는 동의어 hotel)가
  // 있으면 목록이 아니라 "그 숙소를 보고 있다"는 뜻으로 우선 신뢰한다. /search 이외의
  // 경로에서는 관여하지 않는다(혹시 다른 페이지에 우연히 같은 이름의 쿼리가 있어도 무시).
  function overlayPropertyId() {
    if (!/\/(search|city|country|region)\b/.test(location.pathname)) return null;
    const q = new URLSearchParams(location.search);
    const id = q.get("selectedproperty") || q.get("hotel");
    return id && /^\d+$/.test(id) ? id : null;
  }

  // 검색결과 목록에서는 브리핑카드(A)를 띄우지 않는다 — 특정 요금제를 가리키는 카드인데
  // 목록엔 요금제가 없어서 "취소 조건 확인 필요"만 뜬다(실측 리포트 2번). 목록은 배지(B)
  // 담당이다.
  function isListingPage(doc) {
    if (overlayPropertyId()) return false; // 검색결과 위 오버레이로 뜬 숙소 상세
    if (/\/(search|city|country|region)\b/.test(location.pathname)) return true;
    return doc.querySelectorAll('[data-selenium="hotel-item"]').length >= 3;
  }

  // 상세페이지 상단의 "시작가 ₩ 37,474" — 요금 그리드가 로드되기 전에도 읽을 수 있다.
  function findProvisionalPrice(doc) {
    const m = (doc.body.innerText || "").match(/시작가\s*[₩\s]*([\d,]{4,})/);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return n >= 1000 ? n : null;
  }

  function renderProvisionalCard(amount) {
    ensureBriefingStyle();
    if (cardEl) cardEl.remove();
    cardEl = document.createElement("div");
    cardEl.id = "cc-briefing-wrap";
    cardEl.className = "cc-ui cc-briefing-card" + (isScrolling ? " cc-scrolling" : "");
    const mini = document.createElement("div");
    mini.className = "cc-mini";
    mini.style.cssText = `
      align-items:center; gap:6px; border-radius:20px; padding:8px 14px;
      font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;
      font-size:12px; font-weight:600; white-space:nowrap;
    `;
    mini.innerHTML = `
      ${statusDot("gray", { size: 8 })}
      <span>시작가 ${escapeHtml(fmtWon(amount))}~</span>
      <span style="color:#ccc;">·</span>
      <span style="color:#677288; font-weight:400;">요금 확인 중 — 객실 목록까지 스크롤하세요</span>
    `;
    makeDraggable(mini);
    cardEl.appendChild(mini);
    applyCardPos();
    document.documentElement.appendChild(cardEl);
  }

  // 아무 요금제도 고르지 않았을 때의 카드.
  //
  // 예전엔 이 자리에서 화면 가운데 요금제를 자동으로 잡아 보여줬다. 그게 "가만히 있어도
  // 내용이 바뀐다"는 느낌의 출발점이었고, 고르지도 않은 요금제의 취소조건 모달까지 열었다.
  // 이제는 추측하지 않고 무엇을 하면 되는지만 알린다.
  function renderPickPrompt(doc) {
    ensureBriefingStyle();
    if (cardEl) cardEl.remove();
    cardEl = document.createElement("div");
    cardEl.id = "cc-briefing-wrap";
    cardEl.className = "cc-ui cc-briefing-card" + (isScrolling ? " cc-scrolling" : "");
    // 사이트 어댑터의 시작가 훅을 거친다(findProvisionalPrice 직접 호출 금지 — 그건
    // 아고다 전용 구현이고, 여기서 곧장 부르면 다른 사이트에서는 항상 null만 나온다).
    const start = window.__ccSites?.current()?.provisionalPrice?.(doc) ?? null;
    const mini = document.createElement("div");
    mini.className = "cc-mini";
    mini.style.cssText = `
      align-items:center; gap:6px; border-radius:20px; padding:8px 14px;
      font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;
      font-size:12px; font-weight:600; white-space:nowrap;
    `;
    mini.innerHTML = `
      ${statusDot("gray", { size: 8 })}
      <span>${start ? `시작가 ${escapeHtml(fmtWon(start))}~` : "예약 브리핑"}</span>
      <span style="color:#ccc;">·</span>
      <span style="color:#677288; font-weight:400;">요금제 위의 <b style="color:#173d9a;">✓ 이 요금제 보기</b>를 누르세요</span>
    `;
    makeDraggable(mini);
    cardEl.appendChild(mini);
    applyCardPos();
    document.documentElement.appendChild(cardEl);
  }

  // 지원하지 않는 언어(UI)로 열린 상세페이지에서 뜨는 카드. 가격 라벨·취소 문구 파서가 전부
  // 한국어 문구를 전제로 해서, 영어 UI에서는 값을 못 읽고 "확인 못했어요"만 반복한다(실측:
  // 아고다 영어 페이지 — 가격 "확인 필요", 취소 조건 미인식). 못 읽는 걸 못 읽는다고 말하고,
  // 같은 숙소의 한국어 페이지로 가는 링크를 준다.
  function renderLocaleNotice(notice) {
    ensureBriefingStyle();
    if (cardEl) cardEl.remove();
    cardEl = document.createElement("div");
    cardEl.id = "cc-briefing-wrap";
    cardEl.className = "cc-ui cc-briefing-card" + (isScrolling ? " cc-scrolling" : "");
    const mini = document.createElement("div");
    mini.className = "cc-mini";
    mini.style.cssText = `
      align-items:center; gap:6px; border-radius:20px; padding:8px 14px;
      font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;
      font-size:12px; font-weight:600; white-space:nowrap;
    `;
    // 번역 중이면 링크 대신 "번역을 끄세요"만, 다른 언어면 한국어 페이지 링크를 준다.
    const tail =
      notice.reason === "translated"
        ? `<span style="color:#677288; font-weight:400;">브라우저 번역을 끄고 새로고침하세요</span>`
        : `<a href="${escapeHtml(notice.url)}" style="color:#173d9a; font-weight:700; text-decoration:none;">한국어로 보기 →</a>`;
    mini.innerHTML = `
      ${statusDot("gray", { size: 8 })}
      <span>예약 브리핑은 번역 없는 한국어 페이지에서만 동작해요</span>
      <span style="color:#ccc;">·</span>
      ${tail}
    `;
    makeDraggable(mini);
    cardEl.appendChild(mini);
    applyCardPos();
    document.documentElement.appendChild(cardEl);
  }

  // 오탐 억제 게이트 — 윤상 규칙 층 뒤에 얹는다(코드를 건드리지 않고 판정만 덧붙인다).
  //
  // 실측(K-그랜드 70건): "비용·지불·요금" 같은 범용 단어만으로 신호를 세면 가성비 불만이
  // 전부 걸린다 — "지불된 비용에 비해 초라한 룸", "1박 11만원 넘게 지불하고 비누도 없어".
  // 정답 대조 결과 이 숙소의 실제 추가청구는 0건이었다.
  // 반대로 아리아의 정탐 근거는 전부 금액 단위나 청구 동사를 같은 문장에 갖고 있다 —
  // "40달러 달라해서", "200달러치 청구돼있길래", "300달러가 넘는 deposit", "30달러 이상 부과".
  // 그래서 "돈이 실제로 오갔다는 증거"가 문장 안에 있을 때만 인정한다.
  //
  // resolve()는 뒤에 온 note의 confidence가 0.5 이상이면 그걸 채택하므로, 분석기 배열의
  // 맨 뒤에 두어야 한다.
  // 2026-09-24 확장(실측 Trip.com 1500건): "5만 원"(만 뒤 공백), "10만 위안", "500바트" 를 놓쳐
  // 정탐 7건이 "금액 단위가 없어" 로 막혔다. 자동번역 리뷰엔 위안이 아주 흔하다.
  const MONEY_UNIT_RE =
    /\d[\d,.]*\s*(?:만\s*)?(?:천\s*)?(원|달러|USD|dollars?|유로|엔|위안|바트|파운드|링깃|페소|동|RMB|CNY|THB|GBP|EUR|JPY|KRW)|[$₩€¥£]\s*\d/i;
  // 청구·지불을 실제로 말하는 표현. "받아 가"만 보던 초판은 "주차비를 받는다",
  // "리조트피를 내야하는데" 같은 정탐을 놓쳤다.
  const CHARGE_VERB_RE =
    /청구|부과|디파짓|deposit|refund|환불\s*(안|못)|추가\s*요금|별도\s*요금|유료|불포함|미포함|포함\s*(안|되지\s*않|아니)|별도|따로\s*(내|냈|받|결제)|추가로?\s*(내|냈|받|결제|지불)|(내|물)(야|어야|라고|게\s*해)|받(는다|는\s*점|아요|습니다|더라|았|아\s*가)|달라\s*(해|했|고)/;
  // 숙박비 자체를 말하는 금액 — 추가청구가 아니다. "1박에 11만원 넘게 지불하고 비누도 없어"
  const ROOM_RATE_RE = /1?\s*박\s*에|숙박\s*(비|료|요금)|방\s*값|객실\s*(료|요금)|호텔\s*비/;
  // 가성비 불만 — 돈 얘기처럼 보이지만 추가청구가 아니다.
  const VALUE_COMPLAINT_RE = /비해|치고는?|가성비|값어치|아깝|비싸기만|돈이\s*아/;
  // 유형별 추가 조건 — 단어 하나만으로는 못 미더운 것들.
  const TYPE_GUARD = {
    // CHARGE_VERB_RE 와 같은 부정 표현을 써야 한다 — 따로 관리되다 "포함되지 않" 이 빠져
    // "아침 식사가 포함되지 않았습니다" 정탐이 막혔다(실측).
    "조식": /별도|유료|불포함|미포함|포함\s*(안|되지\s*않|아니)|추가|따로|지불|내야|결제/,
    "식음료": /별도|유료|불포함|미포함|포함\s*(안|되지\s*않|아니)|추가|따로|청구|부과|지불|내야|결제/,
  };

  // 범용 유형(시설이용·기타부대·미분류)이 구체적 비용을 흡수하는 경향이 있다
  // (실측: 아리아 "시설 이용료" 4건 중 2건이 실제로는 주차·리조트피 내용).
  // 문장에 구체 키워드가 있으면 그쪽으로 되돌린다 — 유형이 흩어지면 노출 기준(2건)을
  // 못 넘겨 정탐이 "근거 부족"으로 밀린다.
  const GENERIC_TYPES = new Set(["시설이용", "기타부대", "미분류", "기타현장결제"]);
  const SPECIFIC_TYPE_RE = [
    ["리조트피", /리조트\s*피|resort\s*fee/i],
    ["주차", /주차/],
    ["보증금", /보증금|디파짓|deposit/i],
    ["청소비", /청소\s*비/],
    ["도시세", /도시세|숙박세|숙소세|city\s*tax/i],
    ["조식", /조식|아침\s*식사|breakfast/i],
  ];
  function retype(c) {
    if (!GENERIC_TYPES.has(c.feeType)) return c;
    const hit = SPECIFIC_TYPE_RE.find(([, re]) => re.test(c.sentence || ""));
    return hit ? { ...c, feeType: hit[0] } : c;
  }

  function makeMoneyGate() {
    return {
      name: "money-evidence-gate",
      stage: "rule",
      // 청구 동사·가성비 정규식이 전부 한국어다. 영어 후보에 돌리면 "청구 표현 없음"으로
      // 전부 막혀 버리므로 한국어 리뷰의 후보만 본다(다른 언어 후보는 손대지 않고 통과).
      langs: ["ko"],
      analyze(_input, candidates) {
        const mine = new Set(_input.reviews.map((r) => r.index));
        return candidates.map((raw) => {
          if (!mine.has(raw.reviewIndex)) return raw;
          const c = retype(raw);
          const sent = c.sentence || "";
          const charge = CHARGE_VERB_RE.test(sent);
          const money = MONEY_UNIT_RE.test(sent);
          const guard = TYPE_GUARD[c.feeType];

          // 알려진 한계(2026-09-24): "추가 요금 없이 … 받았습니다" 같은 통사적 부정문은 여기서
          // 못 거른다("받았"이 청구 동사로 잡히고 모델도 95% mention). 규칙으로 덮지 않는다 —
          // 모델 결함이고 재학습(부정문 음성 샘플)으로 고친다. 실측 발생률 1/27.
          // 패턴·근거는 model-server/METRICS-ko-roberta-small.md "알려진 약점" 참고.
          let block = null;
          if (guard && !guard.test(sent) && !money) {
            // 유형 guard 는 '막는 조건'이 아니라 '금액 증거가 없을 때만' 본다 —
            // "조식 … 15,000원을 지불해야" 처럼 증거가 다 있는 문장까지 막았다(실측).
            block = `'${c.feeType}' 언급이지만 별도·유료 표현이 없음`;
          } else if (!charge) {
            // 청구 동사가 없으면 금액만으로는 부족하다 — 숙박비 언급이거나 가성비 불만일 수 있다.
            if (!money) block = "금액 단위나 청구 표현이 없어 가성비 불만으로 봄";
            else if (VALUE_COMPLAINT_RE.test(sent)) block = "가성비 불만 표현이라 추가청구로 보지 않음";
            else if (ROOM_RATE_RE.test(sent)) block = "숙박비 자체를 말한 금액이라 추가청구로 보지 않음";
          }
          if (!block) return c; // 근거 충분 — 규칙 판정을 그대로 둔다
          return { ...c, notes: [...c.notes, { by: "money-gate", stage: "rule", verdict: "negated", confidence: 0.6, reason: block }] };
        });
      },
    };
  }

  // ── 리뷰 탭 ──────────────────────────────────────────────────────────────
  // DOM 수집(윤상 autoCollect) 대신 아고다 내부 API를 직접 부른다. 이유 두 가지:
  //  ① DOM 수집은 리뷰 섹션이 렌더된 뒤에만 동작해서, 탭을 먼저 열면 "리뷰를 읽는 중…"
  //     에서 영구히 멈췄다(실측: 리뷰가 나중에 떠도 복구 안 됨, 80초+).
  //  ② 화면에 보이는 5건만 잡히는데 아고다 기본 정렬이 "유용함"이라 긍정 쪽으로 크게
  //     쏠린다(실측: 추가비용 불만 비율 기본 0.8% vs 낮은 평점 우선 15~40%).
  //     sorting:3(낮은 평점 우선) + pageSize:100 이면 표본이 100건까지 늘고 비용 불만이
  //     몰린 구간을 직접 본다.
  // 로케일은 쿠키가 아니라 커스텀 헤더로 전달된다 — 이걸 빼면 본문이 영어 번역본으로
  // 온다(실측: 헤더 없음 한글 0/70, 헤더 있음 68/70).
  const REVIEW_API = "/api/cronos/property/review/ReviewComments";

  // 리뷰 분류 모델 서버 주소. **배포본은 비워 둔다.**
  //
  // 예전엔 reviewtab.js 안에 개발용 주소가 기본값으로 박혀 있었다. 그래서 서버가 없는
  // 사용자·심사원 PC 에서도 리뷰를 볼 때마다 요청이 나가 매번 실패했다(콘솔에 실패한
  // 요청이 남는다). 이제 주소가 없으면 모델 층을 아예 만들지 않으므로 요청 자체가
  // 나가지 않고, 규칙 판정(rules.ts)만으로 동작한다.
  //
  // 개발 중 모델을 붙여 보려면 서버를 띄운 뒤 콘솔에서 주소를 넣고 새로고침한다:
  //   localStorage.cc_model_endpoint = "<서버 주소>/classify"
  //
  // 서버는 Google Cloud Run(서울 리전)에 있다. 배포·재배포 방법은
  // model-server/Dockerfile 주석 참고.
  //
  // ⚠️ 이 주소가 채워져 있으면 **리뷰 본문이 외부 서버로 나간다.** 개인정보처리방침과
  //    대시보드 Data usage 고지가 그 사실과 일치해야 한다(불일치는 정책 위반).
  //    비우면 요청이 아예 안 나가고 규칙 판정으로만 동작한다.
  const MODEL_ENDPOINT_BUILTIN =
    "https://clear-booking-cost-api-12016686349.asia-northeast3.run.app/classify";
  function modelEndpoint() {
    try {
      return localStorage.getItem("cc_model_endpoint") || MODEL_ENDPOINT_BUILTIN;
    } catch (e) {
      return MODEL_ENDPOINT_BUILTIN;
    }
  }
  let reviewHost = null;
  // "한 번만 수집"의 기준은 페이지 로드가 아니라 **숙소**다. 단순 boolean 플래그로 두면
  // SPA로 다른 숙소에 가도 재수집하지 않아 이전 숙소 리뷰가 그대로 남는다.
  let reviewFetchedHotelId = null;

  // 실측(2026-09): 첫 매치 하나만 보는 방식은 검색/홈 화면에서도 추천 위젯·트래킹
  // 스크립트 등에 우연히 섞인 "hotel_id=" 문자열을 숙소 상세 페이지로 착각했다. 같은
  // 호출이 어떤 스캔에서는 값을 찾고 어떤 스캔에서는 못 찾는 식으로 오락가락해서(DOM이
  // 계속 바뀌는 위젯 중 어느 게 먼저 매치되느냐에 따라 달라짐), 리뷰 파이프라인이 계속
  // 재시작되며 그 안의 자동클릭이 아고다 자체 UI(달력·인원선택)를 반복 클릭하는 사고로
  // 이어졌다. 진짜 상세 페이지는 같은 hotel_id가 페이지 전체에서 반복적으로 나오므로,
  // 가장 많이 나온 값이 전체 매치의 과반이면서 최소 2회 이상일 때만 신뢰한다.
  //
  // 실측(2026-10): 그런데 최근 상세 페이지는 hotel_id= 가 딱 1번만 나온다(사용자 리포트로
  // 발견 — 부산 숙소 상세에서 1건). "최소 2회" 기준이 이 유일한 값까지 버려서 리뷰가 항상
  // 막혔다. 후보가 정확히 하나뿐이면 비교할 다른 값이 없으니(=노이즈가 섞일 여지가 없으니)
  // 그대로 신뢰한다 — 위 사고 사례는 "여러 값이 섞였는데 그중 하나가 우연히 맞았다"는
  // 상황이었지 "값이 하나뿐인" 상황이 아니었다. 2개 이상 섞였을 때의 다수결/과반 방어는
  // 그대로 둔다. 이 함수는 renderCard(→ isListingPage를 이미 통과한 상세페이지)에서만
  // 호출되므로, 검색/홈 화면의 우연한 1건은 애초에 이 코드에 도달하지 않는다.
  function currentHotelId() {
    const overlayId = overlayPropertyId();
    if (overlayId) return Number(overlayId);
    const matches = [...document.documentElement.innerHTML.matchAll(/hotel_id=(\d+)/g)];
    if (!matches.length) return null;
    if (matches.length === 1) return Number(matches[0][1]);
    const counts = new Map();
    for (const m of matches) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    let best = null, bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) { best = id; bestCount = count; }
    }
    if (bestCount < 2 || bestCount < matches.length / 2) return null;
    return Number(best);
  }

  function hasHangul(t) {
    return /[가-힣]/.test(t || "");
  }

  // pageSize 는 서버 하드 상한이 있고 **예고 없이 바뀐다**. 실측(숙소 4곳 동일):
  //   25→48건, 40→77건, 50→89건, 51 이상→0건 (절벽처럼 끊김)
  // 세션 초반엔 100까지 됐는데 같은 날 낮춰졌다. 그래서 상한을 고정하지 않고 강등한다.
  // 반환량이 요청값의 약 1.8~1.9배라 50이면 실제로 80~94건이 온다.
  const REVIEW_PAGE_SIZES = [50, 40, 25, 10];

  function reviewRequestBody(hotelId, pageSize, page = 1) {
    // 페이지가 실제로 보내는 바디를 그대로 따라간다. isReviewPage:true 를 넣으면 다른
    // 조건이 맞아도 0건이 돌아온다(실측) — 원본은 false + isCrawlablePage:true 다.
    return {
      hotelId, providerId: 332, demographicId: 0,
      page, pageSize, sorting: 3,
      providerIds: [332], isCrawlablePage: true,
      filters: { language: [], room: [] }, searchKeyword: "", searchFilters: [],
    };
  }

  async function callReviewApi(hotelId, pageSize, page = 1) {
    const res = await fetch(REVIEW_API, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // 로케일 헤더만 필요하다 — 이게 없으면 본문이 영어 번역본으로 온다(실측 0/70 vs 68/70).
        "AG-Language-Locale": "ko-kr",
        "AG-Language-Id": "9",
      },
      body: JSON.stringify(reviewRequestBody(hotelId, pageSize, page)),
    });
    if (!res.ok) throw new Error(`리뷰 API ${res.status}`);
    const data = await res.json();
    return data?.comments ?? [];
  }

  async function fetchReviewsViaApi(onProgress) {
    const hotelId = currentHotelId();
    if (!hotelId) {
      // code 는 어댑터 계약(sites.js)의 "숙소 상세페이지가 아님" 신호 — 호출부가 폴백 없이 접는다.
      throw Object.assign(new Error("hotelId를 페이지에서 찾지 못했습니다"), { code: "NO_HOTEL_ID" });
    }

    // 200 + comments:[] 를 성공으로 처리하면 조용히 빈 화면이 된다 — 이게 오늘 터진
    // 문제의 핵심이었다. 비면 즉시 pageSize 를 낮춰 다시 시도한다.
    let comments = [];
    let usedPageSize = 0;
    for (const ps of REVIEW_PAGE_SIZES) {
      onProgress?.(ps);
      comments = await callReviewApi(hotelId, ps);
      dbg(`리뷰 API pageSize=${ps} → ${comments.length}건`);
      if (comments.length) { usedPageSize = ps; break; }
    }
    if (!comments.length) return null; // 호출부가 DOM 수집으로 폴백한다
    // 2페이지도 받는다 — 아고다가 1페이지에 54건만 주는 날도 있어(실측 2026-09-24) 표본이
    // 얇았다. 낮은 평점순 다음 묶음이라 비용 불만이 이어진다. 실패하면 1페이지만으로 간다.
    if (comments.length >= 20) {
      try {
        const more = await callReviewApi(hotelId, usedPageSize, 2);
        dbg(`리뷰 API page=2 → ${more.length}건`);
        const seen = new Set(comments.map((c) => (c.reviewComments || "").slice(0, 80)));
        for (const c of more) {
          const sig = (c.reviewComments || "").slice(0, 80);
          if (sig && seen.has(sig)) continue;
          seen.add(sig);
          comments.push(c);
        }
      } catch (e) { dbg("리뷰 API page=2 실패 — 1페이지만 사용:", e?.message); }
    }

    return comments.map((c, i) => {
      // 번역본에 한글이 없고 원문이 한국어면 원문으로 되돌린다 — 번역 품질 문제를 피한다.
      let text = c.reviewComments || "";
      if (!hasHangul(text) && c.translateSource === "ko" && hasHangul(c.originalComment)) {
        text = c.originalComment;
      }
      const title = c.reviewTitle && hasHangul(c.reviewTitle) ? c.reviewTitle + ". " : "";
      return {
        index: i,
        text: (title + text).trim(),
        // 기계가 읽을 수 있는 reviewDate 를 먼저, 표시용 문자열은 예비로 (recency.ts 가 둘 다 읽는다)
        date: c.reviewDate || c.formattedReviewDate || null,
        rating: typeof c.rating === "number" ? c.rating : null,
        ratingScale: 10, // 아고다는 10점 만점
        isHotelReply: false,
      };
    }).filter((r) => r.text.length > 0);
  }

  // 리뷰 수집·분석은 숙소에 따라 10~40초까지 걸린다(실측: 아리아 43초). 아무 표시가
  // 없으면 멈춘 것처럼 보이므로 단계와 경과 시간을 함께 보여준다. 총량을 모르는
  // 작업이라 퍼센트 대신 진행 막대 + 초 카운터로 "지금 돌고 있다"를 전한다.
  let reviewTicker = null;
  function showReviewProgress(stage, detail) {
    if (!reviewHost) return;
    clearInterval(reviewTicker);
    const t0 = Date.now();
    const paint = () => {
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      reviewHost.innerHTML = `
        <div class="cc-review-empty" style="text-align:left; padding:20px 4px;">
          <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">
            <b style="color:var(--cc-ink);">${escapeHtml(stage)}</b>
            <span class="cc-elapsed">${sec}초</span>
          </div>
          ${detail ? `<div style="margin-top:5px; opacity:.8;">${escapeHtml(detail)}</div>` : ""}
          <div class="cc-progress"><i></i></div>
        </div>`;
    };
    paint();
    reviewTicker = setInterval(paint, 100);
  }
  function stopReviewProgress() {
    clearInterval(reviewTicker);
    reviewTicker = null;
  }

  // ── 리뷰 수집 실패 처리 ───────────────────────────────────────────────────
  // 아고다 API 가 막히면 마지막 수단으로 화면에 이미 그려진 리뷰를 DOM 에서 긁는다.
  // 그런데 이 경로에는 **반드시 시간 제한이 필요하다.** DOM 수집은 리뷰 섹션이 렌더된
  // 뒤에만 동작하는데, 사용자가 리뷰까지 스크롤하지 않았으면 영영 되지 않는다
  // (윗쪽 주석의 실측: 80초+ 대기). 그동안 패널은 "리뷰를 읽는 중…" 만 띄운다 —
  // 심사원에게는 고장난 확장으로 보인다.
  //
  // 멈춘 것처럼 보이느니 못 했다고 말하는 편이 낫다. 대신 사용자가 스스로 해결할 수 있게
  // 리뷰 섹션으로 가는 버튼과 다시 시도 버튼을 같이 준다.
  // 15초. 이 값은 "수집 전체"가 아니라 **첫 한 건이 잡힐 때까지**의 제한이다
  // (한 건이라도 오면 타이머를 풀고 나머지는 끝까지 기다린다).
  // 폴백은 이미 화면에 그려진 리뷰를 긁는 작업이라, 15초가 걸린다면 리뷰가 화면에
  // 없다는 뜻이다. 심사원이 기다려주는 한계(30초)의 절반으로 잡았다.
  const DOM_FALLBACK_TIMEOUT_MS = 15000;

  // 아고다 상세페이지 상단 네비게이션의 리뷰 탭("이용후기"). 못 찾으면 버튼을 안 만든다.
  function findReviewSectionAnchor(doc) {
    for (const n of doc.querySelectorAll("a, button, span, div, li")) {
      if (n.children.length) continue;
      const t = (n.textContent || "").trim();
      if (t === "이용후기" || t === "후기" || t === "리뷰") return n;
    }
    return null;
  }

  function reviewFailureButton(label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "border:1px solid #d4d9e2; background:#fff; color:#173d9a; border-radius:6px;" +
      "padding:5px 10px; font-size:11.5px; cursor:pointer; font-family:inherit;";
    return b;
  }

  // 실패를 **확정 상태로** 그린다. 진행 막대를 멈추고 무엇을 하면 되는지 알려준다.
  function renderReviewFailure(cause, onRetry) {
    if (!reviewHost) return;
    stopReviewProgress();
    reviewHost.innerHTML = "";

    const box = document.createElement("div");
    box.className = "cc-review-empty";
    box.style.cssText = "text-align:left; padding:18px 4px; line-height:1.7;";

    const title = document.createElement("b");
    title.style.cssText = "display:block; color:var(--cc-ink); margin-bottom:2px;";
    title.textContent = "이 페이지에서는 리뷰를 확인하지 못했어요.";
    box.appendChild(title);

    const sub = document.createElement("div");
    sub.style.cssText = "opacity:.8;";
    sub.textContent = `${window.__ccSites?.current()?.displayName ?? "사이트"} 리뷰 탭에서 직접 확인해 주세요.`;
    box.appendChild(sub);

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;";

    const anchor = window.__ccSites?.current()?.reviews?.sectionAnchor?.(document) ?? null;
    if (anchor) {
      const go = reviewFailureButton("리뷰 섹션으로 이동");
      go.addEventListener("click", () => {
        anchor.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      row.appendChild(go);
    }
    if (onRetry) {
      const again = reviewFailureButton("다시 시도");
      again.addEventListener("click", onRetry);
      row.appendChild(again);
    }
    if (row.children.length) box.appendChild(row);

    if (cause) {
      const why = document.createElement("div");
      why.style.cssText = "margin-top:8px; font-size:11px; opacity:.55;";
      why.textContent = String(cause.message || cause);
      box.appendChild(why);
    }
    reviewHost.appendChild(box);
  }

  // 킬스위치(2026-09): DOM 수집 폴백(createReviewController → autoCollect)을 완전히
  // 끈다. 이 안의 자동클릭(더보기 펼치기·리뷰모달 열기·페이지네이션)이 hotelId 판정이
  // 꼬이는 여러 경우(검색/캘린더 화면, SPA 전환 등)에서 반복적으로 아고다 자체 UI
  // (달력 다음달 화살표, 인원선택 등)를 잘못 클릭하는 사고로 이어졌고, hotelId 판정
  // 조건을 아무리 좁혀도 DOM이 계속 바뀌는 페이지에서는 새로운 우회 경로가 계속
  // 나타났다. 감지 로직을 더 정교하게 만드는 대신, 위험한 코드 경로 자체를 없애는
  // 쪽이 확실하다 — 리뷰 API(fetchReviewsViaApi)가 성공하는 한 정상 동작하고, 실패하면
  // (사유 불문) 그냥 안내만 띄운다. DOM 자동수집은 다음 라운드에서 자동클릭 없는
  // 방식으로 다시 설계할 것.
  function startDomFallback(cause) {
    dbg("DOM 폴백 비활성화 상태 — 안내만 표시:", cause?.message || cause);
    renderReviewFailure(cause, null);
  }

  function mountReviewHost(pane) {
    if (!reviewHost) {
      reviewHost = document.createElement("div");
      reviewHost.className = "cc-review-host";
    }
    pane.appendChild(reviewHost); // 노드는 하나뿐 — 카드가 재생성돼도 상태가 유지된다

    const site = window.__ccSites?.current();
    // 리뷰 수집 경로가 없는 사이트(새 사이트를 붙이는 초기 단계 등)는 파이프라인을 시작하지
    // 않고 안내만 남긴다. 가격·취소 브리핑은 그대로 동작한다.
    if (!site || !site.reviews || site.reviews.source === "none") {
      if (!reviewHost.dataset.ccUnsupported) {
        reviewHost.dataset.ccUnsupported = "1";
        reviewHost.innerHTML = `<div class="cc-review-empty">이 사이트는 리뷰 분석을 아직 지원하지 않아요.</div>`;
      }
      return;
    }

    const hotelId = site.hotelId(document);
    // 숙소 상세 페이지가 아니면(검색/홈 화면 등 hotelId가 없는 곳) 리뷰 파이프라인 자체를
    // 시작하지 않는다. 사고 사례(2026-09): 이 가드가 없을 때는 아래 "같은 숙소면 재실행
    // 안 함" 조건이 `null != null`이 false라 hotelId가 계속 null인 페이지에서 매번
    // 뚫렸고, 그 결과 스캔마다(캘린더 조작 → DOM 변화 → 재스캔) 리뷰수집 파이프라인이
    // 계속 새로 시작돼 그 안의 페이지네이션 자동클릭이 아고다 자체 달력의 "다음 달"
    // 화살표를 반복 클릭하는 사고로 이어졌다.
    if (hotelId == null) {
      reviewHost.innerHTML = "";
      return;
    }
    // 같은 숙소면 이미 받아둔 결과를 그대로 쓴다(탭 전환·객실 이동·스캔 재실행 모두 여기서 끝).
    if (reviewFetchedHotelId === hotelId) return;
    reviewFetchedHotelId = hotelId;

    const api = window.__ccReviewTab;
    if (!api?.runPipeline || !api?.mountPanel) {
      reviewHost.innerHTML = `<div class="cc-review-empty">리뷰 분석 모듈이 로드되지 않았어요.</div>`;
      return;
    }

    const view = api.mountPanel(reviewHost);

    // 주소가 있을 때만 모델 층을 만든다. 없으면 null 이라 analyzers 배열에서 빠지고,
    // 규칙 판정(rule-baseline)만으로 결과가 나온다.
    const endpoint = modelEndpoint();
    // 서버를 미리 깨운다. Cloud Run 은 최소 인스턴스 0 이라 잠들어 있으면 첫 응답까지
    // 약 20~25초(실측 23.5s)가 걸리는데, 리뷰를 모으는 2~5초 동안 먼저 깨우기 시작하면
    // 그만큼 기다림이 줄어든다. 실패해도 무시 — 분류 요청이 어차피 다시 깨운다.
    if (endpoint) {
      try { fetch(endpoint.replace(/\/classify\/?$/, "/health"), { method: "GET", mode: "cors", cache: "no-store" }).catch(() => {}); } catch (e) {}
    }
    // 언어마다 모델이 다르다(서버가 lang 으로 라우팅). 같은 주소에 lang 만 달리 보낸다.
    // timeoutMs 30초: 콜드스타트(23.5s)를 넘겨야 한다. 기본값 8초면 잠든 서버의 첫
    // 사용자는 무조건 모델 층을 못 받고 규칙 판정으로 떨어진다(실측).
    const mk = (lang) => api.createModelAnalyzer({ endpoint, lang, langs: [lang], timeoutMs: 30000 });
    const models = endpoint && api.createModelAnalyzer ? [mk("ko"), mk("en")] : [];
    dbg("모델 층:", models.length ? `켜짐(ko·en) — ${endpoint}` : "꺼짐 — 규칙 판정만 사용");

    showReviewProgress("리뷰를 불러오는 중", site.reviews.loadingHint ?? "");

    (async () => {
      try {
        const reviews = await site.reviews.fetch((detail) => {
          showReviewProgress("리뷰를 불러오는 중", detail);
        });
        if (reviews === null) throw new Error("리뷰 API가 계속 빈 응답을 반환했습니다");
        if (!reviews.length) {
          // API 는 응답했는데 읽을 본문이 하나도 없는 경우. DOM 수집을 더 해봐도 같은
          // 결과일 가능성이 높으니 바로 안내로 끝낸다(막연히 기다리게 두지 않는다).
          renderReviewFailure(new Error("리뷰 본문을 하나도 읽지 못했습니다"), null);
          return;
        }
        let officialClaims = [];
        try { officialClaims = api.collectOfficialClaims?.(document) ?? []; } catch (e) {}
        showReviewProgress(`리뷰 ${reviews.length}건 분석 중`, "비용 언급을 찾고 있어요");
        const analyzers = [api.ruleAnalyzer, api.ruleAnalyzerEn, ...models, makeMoneyGate()].filter(Boolean);
        let insights = await api.runPipeline(reviews, officialClaims, { analyzers, supportedLangs: ["ko", "en"] });
        // 페이지 표기와 모순되는 항목은 1건이어도 올린다 — "무료 주차"라고 써놓고 실제로는
        // 받는다는 건 건수와 무관하게 사용자가 알아야 할 사실이고, 이 익스텐션에서 가장
        // 강한 신호다(실측: 아리아 주차·세금 모두 모순이 확인됐는데 2건 미달로 묻혔다).
        if (insights?.risks?.length) {
          insights = {
            ...insights,
            risks: insights.risks.map((r) =>
              !r.shown && r.pageConflict
                ? { ...r, shown: true, shownReason: `페이지 표기와 모순 — 리뷰 ${r.reviewCount}건` }
                : r
            ),
          };
        }
        stopReviewProgress();
        view.update(insights);
        dbg("리뷰 분석 완료 —", reviews.length, "건 수집");
      } catch (e) {
        stopReviewProgress();
        console.error("[cc] 리뷰 수집 실패:", e);
        // 사고 사례(2026-09): hotelId 실패는 "API가 막힘"이 아니라 "애초에 숙소 상세
        // 페이지가 아님"을 뜻한다(mountReviewHost 진입 시점엔 currentHotelId()가 통과했어도,
        // DOM이 계속 바뀌는 검색/캘린더 화면에서는 그 사이 재평가 결과가 뒤집힐 수 있다).
        // 이 경우 DOM 수집으로 폴백하면 리뷰 섹션이 없는 페이지에서 자동클릭이
        // 아고다 자체 UI(달력·인원선택 등)를 잘못 클릭하는 사고로 이어진다 — 폴백하지 않고
        // 조용히 접는다.
        if (e?.code === "NO_HOTEL_ID") {
          dbg("hotelId 재평가 실패 — DOM폴백(자동클릭) 건너뜀");
          reviewHost.innerHTML = "";
          return;
        }
        // 그 외(네트워크·API 오류 등, 진짜 숙소 페이지인데 실패한 경우)만 DOM 수집으로
        // 폴백한다 — 단 시간 제한을 걸어 무한 로딩을 막는다.
        startDomFallback(e);
      }
    })();
  }

  // 렌더 도중 예외가 나면 removeCard() 는 이미 실행된 뒤라 카드가 통째로 사라지고,
  // 매 스캔 같은 지점에서 다시 터지므로 영영 복구되지 않는다(실측: scope 미정의 한 줄로
  // 카드 소실). 부가 정보 하나가 렌더 전체를 죽이지 않도록 바깥에서 한 번 더 막는다.
  function runBriefing(doc, darkFindings) {
    const prev = cardEl;
    try {
      return runBriefingInner(doc, darkFindings);
    } catch (e) {
      console.error("[cc] 브리핑 렌더 실패 — 직전 카드를 유지합니다:", e);
      if (prev && !prev.isConnected) {
        cardEl = prev;
        document.documentElement.appendChild(prev);
      }
      return false;
    }
  }

  function runBriefingInner(doc, darkFindings) {
    // 지원하지 않는 사이트(어댑터 없음)에서는 카드를 띄우지 않는다.
    const site = window.__ccSites?.current();
    if (!site || site.isListingPage(doc)) { removeCard(); return; }
    // 어댑터가 "이 언어 UI는 못 읽는다"고 알리면 값을 만들어내지 않고 안내만 띄운다.
    const localeNotice = safely("site.localeNotice", () => site.localeNotice?.(doc) ?? null, null);
    if (localeNotice) {
      renderLocaleNotice(localeNotice);
      return true;
    }
    // 호버로 즉시 재스캔할 때(scheduleHoverRescan) 같은 doc/darkFindings로 다시 부를 수
    // 있도록 기억해둔다 — content.js가 계산한 darkFindings를 여기선 다시 계산할 방법이
    // 없다(순서상 content.js가 이 파일보다 늦게 로드돼 접근 불가).
    lastDoc = doc;
    lastDarkFindings = darkFindings;

    // 실사용 리포트(2026-09-24, Trip.com): "상세페이지 들어갈 때부터 카드가 이미 열려
    // 있고, 새로 선택해도 인식이 안 됨". 원인 — Trip.com/Booking.com은 날짜 변경·숙소
    // 이동이 전체 새로고침 없이 일어날 수 있어(SPA 라우팅), 이전 숙소/페이지에서 만든
    // picks·cardOpen이 모듈 스코프에 그대로 남는다. 남은 picks가 resolvePick()의 "자리로
    // 되찾기" 폴백(배열 길이·인덱스만 맞으면 매치)으로 지금 페이지의 엉뚱한 행과 우연히
    // 매치되면 cardOpen=true 그대로 다른 숙소의 요금제가 선택된 것처럼 카드가 뜨고, 사용자가
    // 새로 고르려고 누른 자리엔 이미 "✓ 선택됨" 칩이 떠 있어 클릭이 선택이 아니라 해제로
    // 들어갔다(실측 로그: 예상한 "요금제 선택됨" 대신 "선택 해제"가 찍힘). hotelId가
    // 바뀌면(=다른 숙소로 이동) 리셋한다.
    const hotelIdNow = safely("site.hotelId(리셋 판단)", () => site.hotelId(doc), null);
    if (hotelIdNow != null && hotelIdNow !== lastPickHotelId) {
      if (lastPickHotelId != null && (picks.length || cardOpen)) {
        dbg("숙소 변경 감지 — picks/cardOpen 리셋:", lastPickHotelId, "→", hotelIdNow);
      }
      lastPickHotelId = hotelIdNow;
      picks = [];
      cardOpen = false;
    }

    // 사용자가 지금 카드 위에 마우스를 올려둔 상태면 갱신을 미룬다 — 이유는 cardEl 생성
    // 부분의 주석 참고. mouseleave에서 scheduleHoverRescan으로 다시 불러주므로 손을 떼면
    // 바로 최신 상태로 따라잡는다.
    // 크기를 끄는 중에도 미룬다 — 끄는 도중 카드를 새로 만들면 손잡이가 사라져
    // 드래그가 끊긴다.
    if ((isWrapHovered || isResizing) && cardEl) {
      return true;
    }

    // 이번 스캔에서 딱 한 번만 계산해서 아래 전부(포커스 카드, 비교 목록, 취소조건 분류)
    // 에서 재사용한다 — 각자 다시 스캔하면 요금제가 많은 페이지에서 느려진다(실측).
    warnIfModulesMissing();
    // 빈 배열 / null 로 떨어져도 아래 경로가 전부 견딘다 — 포커스 없음 → 스코프 doc →
    // 추출 실패 → "정보를 찾지 못했어요" 또는 시작가 임시 배지로 흘러간다.
    const allBlocks = safely("pricing.findAllRelevantBlocks", () => window.__ccPricing.findAllRelevantBlocks(doc), []);
    const dateContext = safely("cancellation.buildDateContext", () => window.__ccCancellation.buildDateContext(doc), null);
    const focus = resolveFocus();
    // 페이지 위 표시(호버 테두리 · 선택 테두리 · ✓ 버튼)를 스캔마다 다시 맞춘다 —
    // 아고다가 행을 새로 그리면 우리가 준 outline 이 날아가기 때문이다.
    paintOfferMarks();

    // 호버는 더 이상 요약을 바꾸지 않는다(선택 모델 주석 참고).
    const isHoverPreview = false;

    let scope;
    if (focus.card) {
      scope = focus.card;
    } else {
      // 아무것도 고르지 않은 상태 — 다른 요금제 정보가 섞여 들어오지 않게 비운다.
      scope = EMPTY_SCOPE;
    }

    let result = extractFromScope(doc, scope, dateContext);

    // 가격은 형제 컨테이너에 있는 경우가 실측에서 확인돼 스코프를 계속 넓혀서 찾는다.
    // 취소조건은 스코프를 넓혀서 다시 찾지 않는다 — 여러 요금제가 형제로 나열된 구조에서
    // "조상을 타고 올라가며 다시 찾기"로 "이 카드의 것"과 "옆 카드의 것"을 구분할 방법이
    // 원리적으로 없다는 게 실측에서 반복 확인됐다. 포커스 카드 자체에서 나온 답만
    // 신뢰하고, 그 외엔 모달(아래, 안전함)에만 의존한다.
    const ESCALATION_MAX_TEXT_LEN = 6000;
    let node = scope;
    while (scope !== doc && scope !== EMPTY_SCOPE && !result.finalPrice) {
      if (!node.parentElement) break;
      const parentText = (node.parentElement.innerText || "").trim();
      if (parentText.length > ESCALATION_MAX_TEXT_LEN) break;
      node = node.parentElement;
      const wider = extractFromScope(doc, node, dateContext);
      result.finalPrice = result.finalPrice ?? wider.finalPrice;
      result.priceGap = result.priceGap ?? wider.priceGap;
    }

    // "1박당 총 금액"을 다박 숙박의 전체 결제액으로 잘못 표시하지 않도록 보정한다.
    result.finalPrice = correctForPerNightPrice(result.finalPrice, dateContext?.nights);
    if (result.finalPrice?.nights) {
      // priceGap(화면 큰 글씨 vs 총액 비교)은 둘 다 "이미 완결된 총액"이라는 전제로 만든
      // 로직이라, 방금 박수를 곱해 보정한 총액과 비교하면 실제로는 없는 "격차"를(1박당
      // 가격이 화면에도 크게 보이는 경우 nights배 차이가 나버려) 오탐할 위험이 있다 —
      // 이 경우엔 격차 판정을 보수적으로 끈다.
      result.priceGap = null;
    }

    // 모달은 사용자가 방금 "이 카드"에서 직접 눌러서 연 것이므로 기본적으로 모달 쪽을
    // 우선한다(동점이면 모달 승) — 모달 전 상태가 더 확실한 경우(예: free/nonrefundable
    // 인데 모달은 애매한 unclear)에만 예외적으로 모달 전 상태를 유지한다.
    const CANCEL_STATUS_PRIORITY = { free: 0, nonrefundable: 0, unclear: 1, collapsed: 2, none: 3 };
    const betterCancellation = (preferred, fallback) =>
      CANCEL_STATUS_PRIORITY[fallback.status] < CANCEL_STATUS_PRIORITY[preferred.status] ? fallback : preferred;
    const modalCancellation = safely("cancellation.findModalCancellationBlock", () => window.__ccCancellation.findModalCancellationBlock(doc, dateContext), null);
    if (modalCancellation) {
      const merged = betterCancellation(modalCancellation, result.cancellation);
      // lossSteps(타임라인의 실제 데이터)는 "전체 상태 분류가 어느 쪽을 따라가는지"와는
      // 별개로, 둘 중 "구간을 더 많이 알아낸" 쪽을 쓴다 — 원문(모달)은 문장이 길고
      // 복잡해서 classifyBlock이 전체 status는 "unclear"로 더 보수적으로 판단해도
      // (그래서 merged가 요약 카드 쪽으로 갈 수 있어도) lossSteps 자체는 원문 쪽이 더
      // 정확하고 상세할 수 있다. 이걸 놓치면 "원문을 클릭해도 타임라인에 반영이 안 된다"
      // 는 버그가 된다(사장님 실측). 동점이면 모달(방금 사용자가 직접 열어본 원문)을 쓴다.
      const lossSteps =
        modalCancellation.lossSteps.length >= result.cancellation.lossSteps.length
          ? modalCancellation.lossSteps
          : result.cancellation.lossSteps;
      result = {
        ...result,
        cancellation: {
          ...merged,
          penaltyNote: merged.penaltyNote ?? modalCancellation.penaltyNote ?? result.cancellation.penaltyNote,
          lossSteps,
          noShowNote: merged.noShowNote ?? modalCancellation.noShowNote ?? result.cancellation.noShowNote,
          feeExcludesTax: !!(merged.feeExcludesTax || modalCancellation.feeExcludesTax || result.cancellation.feeExcludesTax),
        },
      };
    }

    // 자동 펼치기 — "collapsed"(펼쳐야 확인 가능) 상태면서 아직 모달이 안 열려 있으면,
    // 이전에 자동으로 열어봐서 캐시된 결과가 있는지 먼저 확인한다. 있으면 그걸 쓰고,
    // 없으면(그리고 호버 미리보기가 아니고, 아직 이 노드로 시도한 적 없으면) 지금
    // 클릭해서 열어본다 — 결과는 비동기로 도착해 캐시에 쌓이고, 다음 호출 때 반영된다.
    // 발동 조건 확대: status가 collapsed가 아니어도, 구간은 잡혔는데 "몇 %인지"를
    // 하나도 모르는 상태(타임라인에 ?로 표시되는 상태)면 원문을 열어봐야 손실액을
    // 계산할 수 있다. 실측: 어떤 호텔은 요금제 카드에 전문이 인라인으로 들어 있고
    // (오사카, 54/54 카드), 어떤 호텔은 "자세히 보기"를 눌러야만 생성된다(서울 캡슐,
    // DOM에 0건). 전자는 클릭 없이 읽히고, 후자만 이 경로를 탄다.
    // 실측(트립닷컴, 2026-09-24): 행 요약엔 첫 구간 금액(125,389원)만 있고 마감 뒤 구간은 "?"다.
    // "전부 미상"일 때만 열면 이런 "일부만 미상"은 사용자가 직접 모달을 열 때까지 "?"로 남는다.
    // 그래서 미상인 구간이 하나라도 있으면 원문을 열어본다(같은 요금제는 한 번만 — attempted).
    const stepsAllUnknown =
      (result.cancellation.lossSteps || []).length > 0 &&
      result.cancellation.lossSteps.some((st) => st.percent == null && !st.usesFirstNight && st.amount == null);
    // 캐시 적용과 "클릭해서 열어보기"는 분리한다.
    //  · 캐시(이미 알아낸 값)는 호버 중이든 아니든 항상 쓴다 — 예전엔 둘이 같은 if 안에
    //    있어서, 마우스를 카드 위에 올리면(isHoverPreview) 블록을 통째로 건너뛰며 방금
    //    읽어둔 값까지 버려 ?로 되돌아갔다(실측: "마우스를 안으로 넣으면 ?로 바뀜").
    //  · 실제 클릭만 호버 중에 막는다(목록을 스쳐 지나가며 연속 클릭하는 걸 방지).
    // 실측(아고다, 2026-09-24): 행 안에 "결제 및 취소 ✓ 취소 정책 ✓ 지금 예약…"처럼 문장 여럿이
    // 섞여 있으면 라벨만 있는 블록이 아니라 "unclear"로 분류된다 — 그런데 구간도, 위약금 문구도,
    // 마감일도 하나도 못 읽은 상태다. 이때도 정책 모달을 열어봐야 하지만 조건이 collapsed·stepsAllUnknown
    // 뿐이라 시도 자체를 안 해서, 사용자가 직접 모달을 열 때까지 "확인하지 못했어요"로 남았다.
    // 클릭 대상은 행 안에서 "취소 정책" 라벨이 정확히 하나일 때만 잡는다(viaLabel) — 큰 블록의
    // 첫 버튼(사진 넘기기 화살표 등)을 잘못 누르지 않기 위해서다.
    const uninformativeUnclear =
      result.cancellation.status === "unclear" &&
      !(result.cancellation.lossSteps || []).length &&
      !result.cancellation.penaltyNote &&
      !result.cancellation.noShowNote &&
      !result.cancellation.deadline;
    const needsReveal = result.cancellation.status === "collapsed" || stepsAllUnknown || uninformativeUnclear;
    if (needsReveal && result.cancellation.node) {
      const node = result.cancellation.node;
      // 키는 노드가 아니라 내용 서명이다(revealSignature 주석 참고).
      const sig = revealSignature(result);
      const cached = sig ? collapsedRevealCache.get(sig) : null;

      // 같은 요금제를 계속 보고 있는 시간을 잰다. 목록을 훑으면 서명이 매번 바뀌어
      // 타이머가 리셋되므로 열리지 않고, 한 곳에 멈춰야만 열린다.
      if (sig !== revealSigSeen) {
        revealSigSeen = sig;
        revealSigSince = Date.now();
      }
      const now = Date.now();
      const settled =
        sig != null &&
        now - revealSigSince >= REVEAL_DWELL_MS &&      // 같은 요금제에 충분히 머무름
        !isScrolling &&                                  // 스크롤 중이 아님
        now - lastScrollAt >= REVEAL_AFTER_SCROLL_MS &&  // 스크롤이 멈추고 좀 지남
        now - lastRevealAt >= REVEAL_MIN_INTERVAL_MS &&  // 직전 펼치기와 간격 확보
        revealCount < REVEAL_MAX_PER_PAGE;               // 폭주 차단기

      dbg("퍼센트 미상 —", "캐시:", !!cached, "| 서명:", sig,
          "| 시도함:", sig ? collapsedRevealAttempted.has(sig) : "-",
          "| 머무름:", now - revealSigSince, "ms | 준비됨:", settled,
          "| 누적:", revealCount);

      if (cached) {
        result = { ...result, cancellation: cached };
      } else if (
        settled &&
        // 사고 원인(2026-09-17): 포커스된 요금제 카드가 없으면(scope === doc) 취소조건
        // 탐색 범위가 문서 전체로 넓어진다. 그 상태에서 "취소"/"환불" 키워드만으로 블록을
        // 찾다 보니, 아직 열려 있는 날짜선택/인원선택 드롭다운 안의 무관한 문구("무료취소"
        // 태그 등)를 취소정책으로 오인해서 그 근처 버튼(달력 다음달 화살표, 인원선택
        // 버튼)을 자동클릭해버렸다 — 실측 버그: 날짜가 계속 다음 달로 넘어가고 인원선택도
        // 저절로 눌림. 포커스 카드가 있을 때(scope가 실제 카드 요소)만 자동클릭을 허용한다.
        scope !== doc &&
        !collapsedRevealAttempted.has(sig) &&
        !isAnyModalOpen(doc)
      ) {
        autoRevealCollapsedCancellation(doc, node, dateContext, sig, { viaLabel: uninformativeUnclear });
      }
    }

    const { finalPrice, priceGap, cancellation } = result;
    dbg("렌더 직전 — steps:", JSON.stringify((cancellation.lossSteps || []).map((st) => ({
      날짜: st.thresholdDate ? fmtLocalISO(st.thresholdDate) : null,
      퍼센트: st.percent,
    }))), "| 총액:", finalPrice?.amount ?? null, "| 1박가:", finalPrice?.perNightAmount ?? null);
    const cancellationDesc = safely("cancellation.describeCancellation", () => window.__ccCancellation.describeCancellation(cancellation), UNKNOWN_CANCELLATION_DESC);

    // 포커스 카드가 아예 없을 때(카드 구조 자체가 없거나, 있어도 화면에 안 보일 때)만
    // 카드를 숨긴다 — 포커스 카드가 있는데 추출이 둘 다 실패했다고 통째로 숨기면 더
    // 혼란스럽다. 호버 미리보기 중이면(isHoverPreview) 그 자체로 유효한 스코프이므로
    // focus.card가 null이어도 숨기지 않는다.
    //
    // 모달이 열려 있는 동안도 숨기지 않는다 — "취소 정책" 원문을 막 열었을 때, 모달이
    // 완전히 그려지기 전(내용이 아직 비어있는) 순간에 스캔이 한 번 돌면 focus.card와
    // finalPrice가 잠깐 둘 다 비어 보일 수 있는데, 하필 이때 카드를 지워버리면 사용자가
    // "원문을 클릭할 때마다 브리핑 창이 꺼져서 다시 띄워야" 하는 상황이 된다(사장님
    // 실측). 모달이 열려 있는 그 자체가 "사용자가 지금 이 예약을 보고 있다"는 강한
    // 신호이므로, 이 경우엔 마지막으로 알려진 내용을 그대로 유지한다.
    // 실측(Trip.com, 2026-09-24): role="dialog" 요소가 화면에 전혀 안 보여도(크기 0×0,
    // 로그인 팝업 틀처럼 항상 마운트만 돼 있는 경우) 존재만으로 "모달 열림"으로 오판하면
    // 이 판정이 영구히 true로 고정된다 — "요금제를 선택하세요" 안내(renderPickPrompt)가
    // 그 아래에서 절대 못 뜨고, 매 스캔이 "마지막 상태 유지"만 반복하면서 사용자 눈엔
    // "카드가 처음부터 열려 있고 아무 것도 안 바뀐다"로 보였다(실사용 리포트 — 진짜
    // 원인은 픽 상태가 아니라 이 판정이었다). isAnyModalOpen은 크기·aria-hidden·
    // computed style까지 확인하는 같은 파일의 기존 함수라 그걸 그대로 쓴다(중복 로직
    // 제거 겸 수정).
    const modalOpen = isAnyModalOpen(doc);

    // 요금제는 있는데 아직 아무것도 고르지 않은 상태 — 숨기지 말고 고르라고 안내한다.
    if (!focus.card && !modalOpen && offerNodes().length) {
      renderPickPrompt(doc);
      return true;
    }

    if (!isHoverPreview && !modalOpen && !focus.card && !finalPrice && cancellation.status === "none") {
      // 객실 요금 그리드가 lazy-load라 진입 직후 4~8초 + 스크롤 전까지는 아무것도 못 읽는다.
      // 그 동안 카드를 통째로 숨기면 상단에서 이탈하는 사용자는 서비스의 존재조차 모른다
      // (실측 리포트 5번). 대신 페이지 상단 "시작가"로 임시 배지를 띄운다 —
      // 근거 없이 단정하지 않기 위해 "시작가", "확인 중"임을 문구로 분명히 밝힌다.
      const provisional = site.provisionalPrice?.(doc) ?? null;
      if (provisional) {
        renderProvisionalCard(provisional);
        return true;
      }
      removeCard();
      return false;
    }

    // "첫 1박 요금" 페널티를 계산하려면 1박 요금이 필요하다 — 사이트 어댑터가 직접 계산해
    // 주면(예: Booking.com처럼 총액만 보여주고 "1박당" 라벨 자체가 없는 사이트) 그걸 먼저
    // 쓰고, 없으면 지금 보고 있는 카드(scope) 안에서 "1박당 총 금액" 라벨을 직접 찾는다
    // (숙박 일수 역산보다 안정적이라 라벨이 있는 사이트는 계속 이 순서를 우선한다).
    const perNightPrice =
      safely("site.price.perNightAmount", () => site?.price?.perNightAmount?.(scope), null) ??
      safely("pricing.findPerNightPriceNode", () => window.__ccPricing.findPerNightPriceNode(scope), null);
    const lossProjection = buildLossProjection(cancellation, finalPrice, perNightPrice);
    const timelinePoints = buildTimelinePoints(cancellation, finalPrice, perNightPrice);
    const comparison = buildComparison(doc, allBlocks, dateContext);
    renderInlineBadges(getAllComparisonEntries());
    const maxLoss = getMaxLoss(cancellation, finalPrice, perNightPrice);
    const bestAlt = buildBestAlternative(comparison, finalPrice, cancellation.status, maxLoss);
    // verdict는 bestAlt를 참고한다 — 환불불가일 때 "무료취소 요금제보다 얼마 비싼가"가
    // 이 화면에서 가장 중요한 사실인데, 예전엔 접힌 "더 나은 옵션"에만 있었다.
    const verdict = buildVerdict({ priceGap, cancellation, lossProjection, bestAlt, finalPrice });
    // reviews.js가 리뷰 블록을 찾아 claim을 뽑는 게 스캔당 제일 무거운 부분이라, 한 번만
    // 계산해서 hiddenCost(비용 4종)와 reviewRisks(리스크 4종) 둘 다에 재사용한다(allBlocks를
    // 한 번만 계산해 재사용하는 위쪽 패턴과 동일한 이유). 옵셔널 체이닝은 reviews.js가 혹시
    // 로드 순서 문제로 아직 없어도(예: 개발 중 파일 하나만 테스트) 브리핑 전체가 죽지 않게
    // 하는 안전장치.
    const reviewClaims = window.__ccReviews?.collectReviewClaims?.(doc) ?? [];
    const hiddenCost = window.__ccReviews?.buildHiddenCostSummary?.(doc, reviewClaims) ?? null;
    const reviewRisks = window.__ccReviews?.buildReviewRiskSummary?.(doc, reviewClaims) ?? [];

    renderCard({
      scope,
      doc,
      finalPrice,
      priceGap,
      cancellation,
      cancellationDesc,
      darkFindings,
      verdict,
      lossProjection,
      comparison,
      bestAlt,
      timelinePoints,
      hiddenCost,
      reviewRisks,
      isHoverPreview,
    });
    return true;
  }

  // ── 아고다 어댑터 ─────────────────────────────────────────────────────────
  // 계약은 sites.js 헤더 참고. 아고다 로직은 이 파일에 그대로 두고 인터페이스로 노출만 한다
  // (v1.0.0 게시본과 동작이 같아야 하므로 옮기거나 다시 쓰지 않았다). 등록이 실패해도
  // 확장 전체가 죽지 않게 try/catch 로 감싼다 — 그 경우 아고다에서 카드가 뜨지 않으니
  // 콘솔의 "[cc] 어댑터 등록 실패" 로그를 먼저 볼 것.
  // 아고다 한국어 UI 는 경로가 /ko-kr/ 로 시작한다(영어 UI 는 접두어 없음 — 실측 2026-09-24).
  // 한국어면 null, 아니면 같은 숙소의 한국어 페이지 주소를 돌려준다. 접두어가 다른 로케일
  // (/ja-jp/ 등)이면 그것을 /ko-kr 로 갈아끼운다.
  //
  // 브라우저 번역은 지원하지 않는다(팀 결정 2026-09-24). 번역본은 문구가 원래 한국어와 달라
  // (예: "체크인 날짜 전 4일 이내…총 숙박 요금" → "도착일 4일 이내…전체 숙박 요금") 파서가
  // 못 읽고, 문구가 번역기 버전마다 달라질 수 있어 맞춰 따라갈 수 없다. 그래서 크롬 번역이
  // 페이지를 <html lang="ko">로 바꿔 놓아도 경로가 /ko-kr/ 가 아니면 한국어로 치지 않는다.
  // 원래 한국어 페이지(/ko-kr/)를 번역 중이면(크롬이 <html>에 translated-ltr/rtl 클래스를
  // 붙인다) 번역을 끄라고 안내한다.
  function agodaLocaleNotice() {
    const cls = document.documentElement.classList;
    if (cls?.contains("translated-ltr") || cls?.contains("translated-rtl")) return { reason: "translated" };
    if (/^\/ko-kr(\/|$)/i.test(location.pathname)) return null;
    const rest = location.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "");
    return { reason: "locale", url: `${location.origin}/ko-kr${rest}${location.search}${location.hash}` };
  }

  try {
    window.__ccSites?.register({
      id: "agoda",
      displayName: "아고다",
      matches: (host) => /(^|\.)agoda\.com$/.test(host),
      isListingPage,
      localeNotice: agodaLocaleNotice,
      hotelId: () => currentHotelId(),
      provisionalPrice: findProvisionalPrice,
      hints: {
        rateRow: '[data-testid="room-offer-price-info"]',
        listingCard: '[data-selenium="hotel-item"]',
      },
      excludeZones: ["#SearchBoxContainer"],
      reviews: {
        source: "api",
        loadingHint: "아고다에서 낮은 평점 순으로 가져옵니다",
        fetch: (onProgress) =>
          fetchReviewsViaApi((ps) => {
            if (ps !== REVIEW_PAGE_SIZES[0]) onProgress?.(`응답이 비어 요청량을 ${ps}로 낮춰 재시도합니다`);
          }),
        sectionAnchor: findReviewSectionAnchor,
      },
    });
  } catch (e) {
    console.error("[cc] 아고다 어댑터 등록 중 예외:", e);
  }

  window.__ccBriefing = { runBriefing, removeCard, clearSelectionMark, buildCalendarEvent, buildIcs, googleCalendarUrl };
})();
