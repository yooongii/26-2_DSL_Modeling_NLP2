// 서비스 워커 — 카드 헤더의 ☰ 버튼이 보낸 요청으로 툴바 팝업(popup.html)을 연다.
// content script 에선 chrome.action 을 못 쓰므로 여기서 대신 연다.
// chrome.action.openPopup 은 Chrome 127+ 에서 일반 확장에 열렸다. 실패하면 ok:false 를
// 돌려주고, briefing.js 가 같은 목록을 카드 옆 iframe 으로 대신 띄운다.
// (파일명을 background.js 로 하지 않은 건 로컬에만 보관 중인 예전 background.js 와 헷갈리지 않게.)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "cc-open-popup") return;
  if (typeof chrome.action?.openPopup !== "function") {
    sendResponse({ ok: false, error: "openPopup unsupported" });
    return;
  }
  chrome.action
    .openPopup(sender.tab?.windowId != null ? { windowId: sender.tab.windowId } : {})
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // 비동기 응답
});
