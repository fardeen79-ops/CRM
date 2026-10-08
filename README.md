# Sourcing CRM

A small CRM for one workflow:

1. **Sales staff** add the customers they source.
2. The **processing team** calls each customer to verify the details, then marks the case **Completed** or **Incomplete**.
3. **Incomplete cases trigger the team leader.** The team leader gets an in-app alert (plus an optional webhook such as Slack or Teams) and must decide what happens next.

It needs no dependencies, only Node.js 22.13 or newer. Data is stored in SQLite through the built-in `node:sqlite` module.

## Quick start

```bash
npm start                 # http://localhost:3000
```

On first run it creates a team leader account, `admin@crm.local` / `changeme123`. You can override this with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Sign in and add your staff on the **Users** page.

To try it with sample data:

```bash
npm run seed:demo         # leader@, sales@, sales2@, processing@demo.local — password "password123"
npm start
```

Run the tests with `npm test`.

## Case workflow

```
                 ┌────────────── release ──────────────┐
                 ▼                                     │
 Sales ──► PENDING VERIFICATION ──claim / log call──► IN VERIFICATION
                 ▲          │                          │
                 │          └──────────┬───────────────┘
                 │                     │  Processing team
                 │          ┌──────────┴───────────┐
                 │          ▼                      ▼
                 │      COMPLETED            INCOMPLETE ──► 🔔 team leader alerted
                 │      (verified)                 │
                 │                 ┌───────────────┼────────────────┐
                 │                 ▼               ▼                ▼
                 ├──── re-verify ──┘      RETURNED TO SALES      REJECTED
                 │                                 │
                 └──────── sales edits & resubmits ┘
```

| Role | Can do |
|------|--------|
| **Sales** | Add cases, see **only their own** cases, edit while pending, fix and **resubmit** cases the team leader returns |
| **Processing** | See the verification queue, **pick up** a case (locks it to them), **log calls** with an outcome, then set the verification result: **Completed**, **Pending** (reason and note required; goes to the team leader) or **Rejected** (note required). Processors cannot change the case status |
| **Team leader** | **Action required** queue of incomplete cases: **Return to sales** (note required), **Re-verify**, or **Reject** (note required). Also sees team stats, manages users, and can edit any open case |
| **Sales manager** | Sees all cases, adds cases, edits case details, works the **Sales Manager** edit-request queue and sets case status |
| **MIS** | Sees all cases and sets case status |
| **Business head** | Sees all cases, team stats, sets case status, and approves or declines call recording requests |
| **Governance** | Marks files for quality check, adds complaint numbers, scores verification calls (0–10) and requests call recordings after verification |

### Re-verification after changes

Once a processor has marked verification **Completed**, the details they confirmed with the customer are locked in. If a team leader or sales manager later changes any of them — the **product** (or bundle contents, card, card sourced type, loan type or buy-out bank), the **loan amount**, **interest rate**, top-up amounts or **FPD** — the file goes back to **Awaiting verification** automatically:

- the processor's assignment and call count are cleared, so it rejoins the verification queue as a fresh request;
- the case timeline records *Sent back for re-verification* with what changed;
- the processor who verified it, every processor, the sales person and the team leaders are notified;
- the case status (Sent to checker, Applicant review…) is not changed.

Changes to anything else (contact details, address, notes, sales staff) leave the completed verification as it is. The edit form warns before saving on a verified file.

### Scheduled call-backs

When a processor logs a call with the outcome **Call back later**, they must enter the **date and time** the customer asked for (up to 30 days ahead; quick picks for "in 1 hour", "tomorrow 10:00" and so on). The case then shows a *Call-back scheduled* banner with the time and who noted it.

At the set time:
- the processor on the file gets a **notification** ("Call back now: CRM-000123 …"); if nobody has picked the file up, every processor is alerted;
- the case rises to the **top of the verification queue** and shows a red *Call back now* chip;
- the case timeline records *Call-back due*;
- if `PROCESSING_WEBHOOK_URL` is set, the alert is also posted there (e.g. the processing team's Teams or Slack channel).

Processors have a **Call-backs** page listing every scheduled call-back, soonest first, with a count of due ones in the menu and a *Call-backs due* tile on their dashboard. Logging the next call with any other outcome closes the call-back; so does recording a verification result. A new "call back later" replaces the earlier time.

Alerts are checked every 30 seconds by the server and again whenever cases are read, so they go out at the set time even on a quiet system. Each call-back alerts once.

### Scanning the Emirates ID

The **Scan Emirates ID** button on the entry form fills in the customer's **first, middle and last name** and **Emirates ID number**. Staff choose which side of the card to scan:

| | Front (default) | Back |
|---|---|---|
| Reads | The printed English name and ID number, plus date of birth and expiry where printed | The machine-readable lines at the bottom |
| Name | **Full name**, including names that wrap onto a second line | Often **cut short**, because the line fits only 30 characters |
| Accuracy check | No check digits. A live scan waits for two camera frames that agree | Check digits on the ID number, birth and expiry dates |

- **Live:** on a phone, the rear camera opens with a card-shaped guide and fills the form when a read is confirmed.
- **Photo:** **Use a photo instead** reads a picture. If the photo shows the other side of the card, that side is read instead.
- **Names:** the full name is split into first, middle and last name. Family-name prefixes stay with the last name (*Al Mansoori*, *Bint Khalid*, *Abu Bakr*), and patronymics like *Bin Rashid* go into the middle name.
- **Review:** filled fields are highlighted for the sales person to check against the card. The form warns if the card has expired, if the back cut the name short, or if a check digit didn't match. Every scan is recorded in the file's activity history, including which side was scanned.
- **Privacy:** text recognition (Tesseract.js) runs entirely on the device. The card image is never uploaded or stored.
- **Setup:**
  - **HTTPS:** live camera scanning needs the CRM to be served over HTTPS (or `localhost`). Photo scanning works either way.
  - **Scanner files:** by default they load from the jsDelivr CDN (about 7 MB the first time, then cached). To serve them from the CRM instead, which most banks will want, run `npm run setup:ocr` once and restart. It saves them under `public/vendor/tesseract/`.
  - **Testing:** the scanner was tested with made-up sample cards drawn to resemble the current Emirates ID. The front reader finds fields by their English labels ("Name", "ID Number", "Date of Birth", "Expiry Date"), so try it on real cards, including older designs, before rolling it out.

### Targets and sales cycles

**Sales cycle.** A cycle runs from the **21st of one month to the 20th of the next** and is named after the month it ends in, so 21 May – 20 June is the **June cycle**. Dates are UAE dates.

**What counts.** A case counts towards a cycle when its **case status is set to Completed** during that cycle. How it counts depends on the product:

| Product | Completed case is a… | Target and achievement |
|---|---|---|
| Credit card | temp end | number of temp ends |
| Accounts | completed case | number of completed cases |
| Personal loan | disbursal | **AED amount disbursed** |
| Auto loan | disbursal | **AED amount disbursed** |

A bundle counts for each product in it. The case page shows how a completed case counted, for example "Completed as Disbursed · Personal loan AED 140,000 · June 2026 cycle".

**Disbursed amounts.** Completing a loan case records the amount actually disbursed:
- The case status panel asks for it, prefilled from the file: the loan amount, the incremental amount for a top up (the new money paid out), or the amount entered for an auto loan.
- An auto loan with no amount on file must have one entered.
- Team leaders, MIS, sales managers and business heads can correct it later with **Update disbursed amount**.
- Moving a case out of Completed clears the amount, so it stops counting.
- Loans completed before this feature are counted at the amount on their file.

**Who sees what** on **Targets** (and the cycle summary at the top of the dashboard):

| Role | Sees |
|---|---|
| Sales staff | their own targets and achievement per product, with their card activation |
| Team leaders | their team: everyone whose team leader they are, one row each, with totals |
| Sales managers | their team, plus a breakdown by team leader |
| MIS and business heads | all sales staff, by team leader and by sales manager |

Team and manager targets are the sum of their sales staff's targets. Selecting a row lists the cases completed in that cycle. Use **‹ / ›** to move between cycles.

**Setting targets.** Only **MIS and business heads** set targets, per sales person, cycle and product: a number of cases for credit cards and accounts, and an AED amount for personal and auto loans (for example `1,500,000`). There are two ways:
- **Set targets** on the Targets page turns the staff table into an editable grid. **Copy *last month's* targets** fills empty boxes from the previous cycle.
- **Bulk upload → Targets** takes a CSV with a sales code, a cycle (`Jun 2026` or `2026-06`), card and account counts, and personal and auto loan disbursal amounts in AED. Blank cells leave a target unchanged.

### Card activation

Once a credit card case is completed (temp end), MIS records whether the customer **activated** the card. The result counts for the sales person who sourced the case.

- **Card activation** (MIS and business heads) lists every temp end with its sales staff, team leader and cycle.
  - Filter by status (Active, Inactive, Out of range) and by the cycle the case was completed in.
  - To change a card, set the **date** in its row (it starts as today, or the card's current date), then choose **Active** or **Inactive**. Choosing the same status again saves the new date.
- On the case page, **Card activation** has the same choice with a date: *Activated on* for Active, *Inactive since* for Inactive.
- **Inactive by default.** A completed card case is Inactive from its temp end date until it is marked Active, so there are no unmapped cards. The case timeline records this as a system entry, and the card shows "by default" until MIS confirms a status.
- **Ageing.** Inactive cards, including those inactive by default, show their ageing: the number of days since the temp end (the date the case was completed). The list puts the oldest first and groups them into 0–30, 31–60 and 61–89 days.
- **Out of activation range.** A card still inactive **90 or more days** after its temp end moves to *Out of activation range* automatically. The case timeline records it as a system change. These cards have their own filter and count, and they count as not activated. MIS can still mark one Active if the customer activates later.
- Every status has a date. If none is given it is today, and it can't be in the future. Each change is recorded in the case timeline, e.g. "Inactive since 2026-10-05".
- **Bulk upload → Card activation** maps a whole bank report.
  - Each row names a completed card case by **CRM reference, App ID or Emirates ID**, with its card status and a **Status date** (activated on / inactive since; blank means today).
  - A reference that matches several cards, or a case that isn't a completed card case, is reported rather than guessed.
- Everyone with targets sees active, inactive and out-of-range counts and the activation rate on their Targets page and dashboard.

### Users and contact details

Every user added on the **Users** page needs a full name, an **email address** and a **local mobile** number; a **WhatsApp number** is optional.

- The email is suggested from the name as `first.last@` plus your own email domain. Overwrite it if the person's address is different.
- Local mobile numbers must be UAE mobiles. They are stored as `05XXXXXXXX`, whether typed as `050 123 4567`, `+971 50 123 4567` or `501234567`.
- WhatsApp numbers are stored in international format (`+971…`), so a number from another country works too. **Same as local mobile** copies the mobile number across. The Users list links each WhatsApp number to a chat.
- **Edit** on any user changes their name, email and numbers (and, for sales staff, the sales profile).

### Bulk upload

Only **MIS** and **business heads** can bulk upload. They open **Bulk upload** in the top bar (or on their dashboard) and switch between the **Cases** and **Users** tabs. Everyone else adds users and files one at a time, and MIS and business heads can't use the single New case form.

1. **Download the template** (a CSV file that Excel, Numbers and Google Sheets open). **Download with example row** gives the same file with one filled-in row to copy. The **Column guide** on the page lists every column, whether it is required, and the accepted values.
2. Fill in one row per user or file, save as CSV (in Excel: *File → Save As → CSV UTF-8*) and upload it.
3. **Check file** validates every row with the same rules as the on-screen forms and saves nothing.
4. **Upload** adds the good rows and skips the rest. **Download rows with errors** gives the skipped rows with an *Error* column, ready to fix and upload again.

**User rows**
- Choose the role by name (`Sales`, `Team Leader`…).
- Sales staff name their team leader and sales manager by **email**. These can be existing users or ones added in the same file, because managers are added first.
- Leave *Temporary password* blank and one is generated. **Download sign-in details** right after the upload to get the generated passwords. They aren't shown again; a team leader can reset a password later.

**Case rows**
- Name the sales person by **sales code** (required). The file belongs to that sales person exactly as if they had entered it.
- Values can be labels or codes in any case: `Personal Loan` or `personal_loan`, `Top Up`, `Dubai` or `DXB`.
- Bundle products are separated with `;`. Credit cards and buy-out banks match the form's lists, ignoring case.
- Sourcing dates are `DD/MM/YYYY` or `YYYY-MM-DD`; Excel date cells are converted too.
- Each file starts as *Sent to checker* and is marked "Added from a bulk upload file" in its timeline.
- An App ID already in the CRM, or repeated in the file, counts as a duplicate. Re-uploading the same file adds nothing twice.

**Limits and Excel**
- Up to 1,000 rows per file.
- Excel drops leading zeros and turns long numbers into `9.71501E+11`. Set the phone, Emirates ID and App ID columns to **Text** before typing. A row with a mangled number is reported instead of being saved with the wrong digits.
- `.xlsx` files aren't read; save as CSV first.

### Sales staff, region and core product

When a team leader registers a sales person on the **Users** page, they enter a **sales code** and choose the person's **team leader** and **sales manager** from existing users. A team leader can change these later with **Edit**.

At the top of every file, the **Sales staff** section shows the sales person's full name, sales code, team leader and sales manager:

- When a sales person enters a file, it fills in automatically from their profile and can't be edited.
- When a team leader or sales manager enters a file, they pick the sales person and the rest fills in.

These details are saved with the file as they were at submission, so later changes to a profile don't rewrite old files. A sales person can't submit until their profile is complete. The named sales person owns the file: they see it, can request edits and receive its notifications.

Every file also needs:

- a **Region**: `DXB` or `AUH`
- a **Core product**: Credit Card, Personal Loan, Auto Loan or Multi product. It is suggested from the product chosen, and a bundle suggests Multi product.

The API fields are `region`, `core_product` and, for team leaders and sales managers, `sales_staff_id`.

### Customer details

The case form groups the customer's details:

- **Customer:** first, middle and last name, mobile number, Emirates ID and passport number.
- **Employment:** company name and monthly salary in AED.
- **Application:** Bidaya ID and App ID.

First name, last name and mobile are required. An Emirates ID must be 15 digits starting with 784, and it is stored as `784-YYYY-NNNNNNN-C`. Passport numbers are stored in upper case. Search matches names, mobile, company, Emirates ID (with or without dashes), passport number, Bidaya ID, App ID, credit card and buy-out bank.

### Case status

Case status is separate from verification:

> Completing the verification never completes the case. Processors only set the verification result; the case status is set by team leaders, MIS, sales managers and business heads.

- **Verification** is the processing team's calls: pending, in verification, completed, or incomplete, after which the team leader decides.
- **Case status** is the outcome of the file.

Each file starts as **Sent to checker** when the sales person submits it. After that only a team leader, MIS, sales manager or business head can change it. Processors can't. They choose **Applicant review**, **Completed** or **Rejected**, and Applicant review and Rejected need a note. Every change is logged and the sales person is notified. Team leaders are also alerted when a file moves to Applicant review.

While a file is in **Applicant review**, the sales person who sourced it can't edit it. Instead they send an **edit request** to the **Team Leader** or **Sales Manager** queue, describing the changes. The team leader or sales manager makes the edits and clicks **Mark changes done**, and the sales person is told.

Each file also has a **sourcing date**, which defaults to today and can't be in the future.

### Privacy controls: masking, watermark and access log

A web page cannot stop screenshots or photos of the screen, so the CRM limits what a capture would show and makes it traceable:

- **Masked identifiers.** Emirates ID, passport, phone numbers and salary are masked on every screen (`784-••••-••••567-1`, `Z•••••36`, `+••• •• ••• 4567`, `AED ••,•••`) until someone clicks **Reveal** on the case page (**Reveal to call** turns a mobile number into a dial link). **Reveal all** uncovers everything at once. Revealed values **hide again after 3 minutes**, and at once when the tab is hidden or the page is left. The mask is applied by the server, so the full value never reaches the browser until it is revealed. Search still works on full values. On the edit form a masked value stays as it is unless a new one is typed.
- **Access log.** Every reveal, and every opening of a case, is recorded with who, what and when (repeats within five minutes count once). Governance, MIS and business heads see it on **Access log**, filterable by staff, customer or CRM ref, and can open it for one case with `#/access-log?case=ID`. The API is `GET /cases/:id/reveal?fields=phone,eid_number` and `GET /access-log?case=&limit=`.
- **Watermark.** Every screen carries a faint repeating stamp of the signed-in user's name, sales code or role, and the time, refreshed each minute, so a leaked screenshot or photo can be traced to the session it came from. It prints darker.

### Personal details: who can see them

Company name, salary, Emirates ID and passport number are restricted. The server removes them from every response, and from search, for people who may not see them:

| Role | Sees these details |
|------|--------------------|
| Sales (own files), Sales manager, MIS, Business head | Always |
| Processor | Until verification is **Completed** or **Rejected**. While it is awaiting, in progress or **Pending**, they are visible for the call. They become visible again if the file is sent back for re-verification |
| Team leader | Never, on any submitted file. A team leader can still type a replacement value (for example, for an edit request) without seeing the old one |

### Governance: quality checks, recordings, complaints and scores

The **Governance** role sees every file (but cannot edit it or change its status) and can:

- **Mark a file for quality check**, with an optional note, and remove the mark later. Marked files appear in the **Quality check** queue.
- **Add a complaint number** to any file. It is searchable.
- **Score the verification call** from **0 to 10**, with one decimal allowed, plus comments. This is only available once the processor has recorded a verification result. The processor is notified, and team dashboards show each processor's average score.
- **Flag a file for urgent verification**, with a reason, while verification is still awaiting, in progress, Pending or returned to sales. The processor on the file (or all processors if nobody has picked it up) and team leaders are alerted. Urgent files go to the top of the queues with an **Urgent** tag and an **Urgent** menu item. The flag clears automatically when the verification is completed or rejected.
- **Request the call recording**, only once verification is **Completed** or **Rejected**, and with a reason. While it is still pending, the recording can't be retrieved; flag the file for urgent verification instead. The business head can't approve a request either until verification has a final result.
  1. The request goes to the **business head**, in their **Recording approvals** queue.
  2. The business head **approves** it, or **declines** it with a reason.
  3. On approval, the CRM emails **IT** for the file. The email is sent automatically if `IT_EMAIL` and `IT_EMAIL_WEBHOOK_URL` are set. The ready-made email is also shown on the file with **Copy email** and **Open in email** buttons.
  4. When IT shares the file, governance (or the business head) adds the link or reference and marks it **received**.

Sales staff never see quality checks, recordings, complaint numbers or scores.

### Products

Each case records one product: **Personal Loan**, **Credit Card**, **Auto Loan**, **Accounts**, or a **Bundle**. Choosing Bundle shows checkboxes for the products in it, and a bundle needs at least two. The API takes `product` as one of `personal_loan`, `credit_card`, `auto_loan`, `accounts` or `bundle`. For a bundle it also takes `bundle_products`, as an array such as `["credit_card", "accounts"]` or a comma-separated string. Cases created before this change keep their original free-text product until someone edits them.

When the product is Personal Loan, or a bundle that includes it, staff must also say whether it is a **Top Up**, **Buy Out** or **Fresh** loan. The API takes this as `personal_loan_type`, one of `top_up`, `buy_out` or `fresh`. Every personal loan needs a **loan amount** (`loan_amount`, AED) and an **interest rate** (`interest_rate`, %). A **Top Up** also needs the **full loan amount** (`full_loan_amount`) and the **incremental amount** (`incremental_amount`); the increment cannot be more than the full amount. For a **Buy Out**, staff also choose the bank the loan is coming from (`buyout_bank`). The list of UAE banks is in [`src/banks.js`](src/banks.js), and staff can type a bank that isn't listed.

Every personal loan also needs its **FPD** (first payment date, `fpd` as `YYYY-MM-DD`): on or after the sourcing date and within a year of it.

When the product is Credit Card, or a bundle that includes Credit Card, staff must also choose the card. The list has 29 cards grouped by family and lives in [`src/credit-cards.js`](src/credit-cards.js). Edit that file to add or retire cards. The API takes the card's exact name as `credit_card`. Staff also pick the **card sourced type** (`card_fee_type`): `fyf` (first year free), `full_fee` or `ffl` (free for life). Both appear on the case page and in the case bulk upload template (*Card sourced type*, *FPD*).

Every step is recorded in the case's activity timeline. People are notified in-app (the 🔔 icon) when something needs them:

- team leaders when a case is marked incomplete (reasons include *Customer in DNCR*, for customers on the Do Not Call Register who cannot be phoned; such files show a DNCR chip)
- sales when their case is verified, returned or rejected
- the processor when a case they handled is sent back or rejected

### Verification calls through a bot

When a calling bot is set up (`CALL_BOT_URL`), processors see **Call with bot** on cases they can verify. The bot phones the customer and asks them to confirm their details. The processor then reviews what came back and saves the verification result as usual.

> The bot never completes, holds or rejects a verification. Its call is logged like any other call, and the processor decides.

1. **Call with bot** picks the case up, like logging a call, and sends the request to the bot service. Only one bot call per case runs at a time. A call with no result after 30 minutes no longer blocks a new one, and a late result for it is refused.
2. The bot calls the customer and checks up to five details: **full name**, **product applied for**, **employer**, **monthly salary** and the **last four digits of the Emirates ID** (employer, salary and Emirates ID only when they are on the file).
3. When the bot reports back, the case shows a **Bot call** card: each detail as *Confirmed*, *Did not match* or *Not answered*, the bot's summary, the transcript and a link to the recording. The call counts as a call attempt, appears in the activity history, and the processor is notified, for example "bot call: 1 detail did not match: Employer".
4. If the bot service refuses the request, or reports that the call failed, the case says so and the processor can try again or call the customer themselves.

Only the result of each check is saved, never the value the customer gave. Sales staff don't see bot calls.

**Connecting a bot.** Any voice-bot or IVR provider works, or a small adapter in front of one. The CRM sends a `POST` to `CALL_BOT_URL`:

```json
{ "event": "verification_call.request", "call_id": 7, "case_id": 12, "ref": "CRM-000012",
  "callback_url": "https://crm.example.com/api/bot/calls/3f9c…",
  "customer": { "name": "Asha Rao", "phone": "0501234567", "alt_phone": null },
  "checks": [ { "key": "full_name", "label": "Full name", "question": "Please confirm your full name.", "expected": "Asha Rao" },
              { "key": "eid_last4", "label": "Emirates ID (last 4 digits)", "question": "…", "expected": "5671" } ],
  "check_results": ["confirmed", "mismatch", "not_answered"],
  "call_outcomes": ["connected", "no_answer", "busy", "switched_off", "wrong_number", "call_back_later"] }
```

Any `2xx` answer means the bot accepted the call. The bot then posts to `callback_url`, once with `{"status": "in_progress"}` if it wants to show that the call has started (optional), and once with the result:

```json
{ "status": "completed", "outcome": "connected",
  "checks": [ { "key": "full_name", "result": "confirmed" }, { "key": "eid_last4", "result": "mismatch" } ],
  "summary": "Customer confirmed their name; Emirates ID digits did not match.",
  "transcript": "Bot: …", "recording_url": "https://…" }
```

or `{"status": "failed", "error": "number not in service"}`. Checks left out count as not answered.

**Security.**
- The callback URL holds a random one-time token for that call. A result is accepted once.
- Set `CALL_BOT_SECRET` to sign both directions. Each request carries `x-crm-signature: sha256=<hex>`, an HMAC-SHA256 of the raw body with the secret. The CRM signs its requests to the bot and refuses results without a valid signature.
- The request contains the customer's details so the bot can compare answers. Only point `CALL_BOT_URL` at a service your bank has approved to handle them.
- Set `PUBLIC_URL` to the address the bot can reach the CRM at (for example `https://crm.example.com`). Without it, the callback URL uses the address the processor opened the CRM with.

### Team-leader webhook

Set `TL_WEBHOOK_URL` to POST a JSON alert every time a case is marked incomplete. The payload includes a `text` field, so a Slack or Microsoft Teams incoming webhook works as-is:

```json
{ "text": "⚠️ CRM-000012 (Asha Rao) marked INCOMPLETE by Pam — incorrect details: …",
  "event": "case.incomplete", "case_id": 12, "ref": "CRM-000012", "customer_name": "Asha Rao",
  "reason": "incorrect_details", "note": "…", "marked_by": "Pam", "at": "2026-10-06T08:00:00.000Z" }
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/crm.db` | SQLite database file |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | `admin@crm.local` / `changeme123` | First team leader account (created only when there are no users) |
| `TL_WEBHOOK_URL` | – | Webhook for incomplete-case alerts |
| `PROCESSING_WEBHOOK_URL` | – | Webhook for due call-back alerts (`callback.due`) |
| `IT_EMAIL` | – | IT department address that approved call recording requests are emailed to |
| `IT_EMAIL_WEBHOOK_URL` | – | Email relay (Power Automate, Zapier, an SMTP bridge…) that receives `POST {to, subject, text}` and sends it |
| `CALL_BOT_URL` | – | Calling bot service that places verification calls; turns on **Call with bot** |
| `CALL_BOT_SECRET` | – | Shared secret for signing bot requests and results (recommended) |
| `PUBLIC_URL` | – | The CRM's address as the bot reaches it, for callback URLs |
| `COOKIE_SECURE` | – | Set to `1` when serving over HTTPS |

## Project layout

```
src/
  index.js     entry point (first-run admin, starts server)
  server.js    HTTP routing, auth cookies, JSON API, static files, webhook dispatch
  cases.js     case workflow / state machine, notifications, stats
  bot.js       verification calls through a calling bot (request, signed results)
  imports.js   bulk upload of users, cases, card activation and targets (CSV parsing, row checks, column guide)
  cycles.js    sales cycles (21st to 20th, UAE time)
  performance.js  targets, achievement per cycle and card activation counts
  users.js     user profiles, contact details and phone number rules
  credit-cards.js  the credit card list shown when Credit Card is selected
  auth.js      users, scrypt password hashing, sessions
  db.js        SQLite schema
public/        single-page UI (vanilla JS, no build step)
scripts/       demo seed data
test/          end-to-end API tests (node:test)
```

## API summary

All endpoints are under `/api`, take and return JSON, and need a signed-in session cookie (except `login`).

| Method & path | Description |
|---|---|
| `POST /login`, `POST /logout`, `GET /me` | Session |
| `GET /cases?status=a,b&q=…&assigned=me&callbacks=all\|due\|upcoming` | List cases (sales only see their own) |
| `POST /cases`, `GET /cases/:id`, `PUT /cases/:id` | Create, read, edit |
| `POST /cases/:id/actions` | `{action, note?, outcome?, reason?, callback_at?}` (`callback_at` is required with `outcome: 'call_back_later'`: an ISO date-time), where action is one of `claim`, `release`, `log_call`, `complete`, `mark_incomplete`, `return_to_sales`, `reverify`, `reject`, `resubmit` |
| `POST /cases/:id/actions` with `bot_call` | Asks the calling bot to phone the customer (processing) |
| `POST /bot/calls/:token` | Result from the calling bot (no session; one-time token, plus signature when `CALL_BOT_SECRET` is set) |
| `GET /stats` | Dashboard counts |
| `GET /notifications`, `POST /notifications/read` | In-app alerts |
| `GET/POST /users`, `PATCH /users/:id` | User management (team leader only). Users have `mobile_number` (required on create) and `whatsapp_number` |
| `GET /targets?cycle=2026-06`, `PUT /targets` | Targets and achievement for a cycle (default: current). `PUT {cycle, targets: [{user_id, credit_card, personal_loan, auto_loan, accounts}]}`, MIS and business head only |
| `GET /cases?cycle=2026-06&staff=:id&card=active\|inactive\|out_of_range\|all` | Cases completed in a cycle, for one sales person, or by card activation |
| `POST /cases/:id/actions` with `set_case_status` / `set_disbursal` | Completing a loan takes `pl_disbursed_amount` / `al_disbursed_amount` (AED; defaults to the file's amount). `set_disbursal` corrects them on a completed case |
| `POST /cases/:id/actions` with `set_card_status` | `{card_status: 'active'\|'inactive'\|'', activation_date?}` (the status date; defaults to today) on a completed card case (MIS and business head) |
| `POST /import/users`, `/import/cases`, `/import/cards`, `/import/targets` | Bulk upload (MIS and business head only): `{csv, dry_run}`. Returns `{total, ok, failed, rows: [{line, ok, error?, ref?, temp_password?}]}`; `dry_run: true` checks without saving |
