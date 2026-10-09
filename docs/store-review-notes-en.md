# Chrome Web Store — English text for reviewer-facing fields

These fields are read by Chrome Web Store reviewers, not by end users, so they are written in
English. User-facing text (store description, screenshots, privacy policy) stays in Korean —
see `store-listing.md` and `privacy.html`.

Korean originals: `store-listing.md`, `chrome-store-privacy-tab.md`.

---

## Single purpose

```
A booking assistant for Agoda, Trip.com and Booking.com accommodation pages. It shows
the real total payable
including taxes and fees, the estimated loss if the booking is cancelled, and any
hidden costs mentioned in the property's public reviews — all in one card on the page.
For a free-cancellation rate, the same card can also add the free-cancellation deadline
to the user's calendar.
```

## Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | Needed to read the price, cancellation terms and review text on the booking page the user is viewing, in order to build the briefing card. |
| `storage` | Needed to persist UI state such as the briefing card's on-screen position, and the user's saved-stay list, in the user's local browser only. No account, no cloud sync. |
| Host permission `https://*.agoda.com/*`, `https://*.trip.com/*`, `https://*.booking.com/*` | Needed to confine every feature of the extension to the Agoda, Trip.com and Booking.com domains. The extension reads and runs nothing on any other site. |

## Remote code

```
No remote code is executed. The extension contains no eval(), no dynamically injected
<script> tags, and no runtime imports. All executable code ships inside the package.

The extension does make one outbound data request: review sentences that contain a
cost keyword are POSTed to our own classification server (Google Cloud Run) and only a
classification result is returned. A data-free GET /health request is sent first to wake
the server. This is data, not code — nothing returned by that server is executed.

Separately, only when the user clicks the "Google Calendar" button on the card, the
extension opens a calendar.google.com tab (a user-initiated navigation via window.open,
not a request made by the extension). The "Other calendars (.ics)" button builds a
calendar file inside the browser and saves it; nothing is sent.
```

## Data usage disclosure

| Category | Declared | Notes |
|---|---|---|
| Website content | **Yes** | Reads price, cancellation policy and review text from the page. Used for the extension's core feature. |
| Personally identifiable information | **Yes** | We do not request names or contact details. However, the public review text we send for classification may incidentally contain a name written by the reviewer (their own, or a third party such as hotel staff). It is discarded immediately after the request and never stored. |
| Financial and payment information | No | |
| Authentication information | No | |
| Health information | No | |
| Location | No | |
| Web history | No | |
| Personal communications | No | |

Certifications:

- [x] We do not sell this data to third parties.
- [x] We do not use or transfer it for purposes unrelated to the item's core functionality.
- [x] We do not use or transfer it to determine creditworthiness or for lending purposes.

Calendar feature (user-initiated only): the "Google Calendar" button opens Google Calendar
in a new tab with the event details (property name, free-cancellation deadline, check-in,
total price, page address) in the address. Nothing is passed unless the user presses the
button, and nothing goes to our servers. This is stated in the privacy policy, section 1
and section 4.

## Additional information for reviewers

```
No login or test account is required.

How to verify:

1. On agoda.com, trip.com or booking.com, search any city, open the property list, then
   open a property detail page. The extension is built for the Korean-language interface.
   On Agoda please use a Korean page (the address starts with https://www.agoda.com/ko-kr/).
   On a non-Korean page, or with the browser's page-translation turned on, the card only
   shows a notice ("works only on a Korean page, without translation") and calculates
   nothing — this is intended, because the cancellation-terms parsing depends on the
   Korean wording.

2. About 1-2 seconds after the page loads, a "Booking Briefing" card appears in the
   bottom-right corner, asking you to choose a rate. Move the mouse over any rate row:
   a small "✓ 이 요금제 보기" ("view this rate") button appears at its top-right. Click it.
   The card then opens and shows that rate's real total including taxes and fees, and the
   estimated loss if the booking is cancelled.

   A property page lists many rates with different prices and cancellation terms, so the
   card asks which one you mean rather than guessing.

3. Open the "리뷰 근거" ("Review evidence") tab in the card. It lists hidden-cost mentions
   found in the property's public reviews (accommodation tax, deposit, breakfast, and so
   on). These come from sending only the review sentences that contain a cost keyword to
   our classification server, which is deployed on Google Cloud Run. No configuration is
   needed; it works out of the box. The server stores nothing and discards each request
   after responding. This is described in our privacy policy.

4. Click the save button in the card header. The saved stay appears in the toolbar
   popup list. This list is stored only in the browser (chrome.storage.local); nothing
   is sent anywhere.

5. Choose a free-cancellation rate (one that says "무료 취소 … 전", i.e. free cancellation
   before a date). Below the status box the card shows "무료취소 마감일 등록" ("Register the
   free-cancellation deadline") with two buttons: "Google Calendar" and "다른 캘린더 (.ics)"
   ("Other calendars"). Nothing is sent before you press a button. ".ics" saves a calendar
   file (an all-day event on the deadline day, with a reminder the morning before);
   "Google Calendar" opens a calendar.google.com tab only when pressed. The buttons do not
   appear for non-refundable rates or when the deadline could not be read.

The extension runs only on https://*.agoda.com/*, https://*.trip.com/* and
https://*.booking.com/* pages and does nothing on any other site.

Privacy policy (Korean): https://dldmsals.github.io/ClearBooking/privacy.html
Privacy policy (English): https://dldmsals.github.io/ClearBooking/privacy-en.html
```
