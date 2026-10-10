# Sourcing CRM

A small CRM for one workflow:

1. **Sales staff** add the customers they source.
2. The **processing team** calls each customer to verify the details, then marks the case **Completed** or **Incomplete**.
3. **Incomplete cases trigger the team leader.** The team leader gets an in-app alert (plus an optional webhook such as Slack or Teams) and must decide what happens next.

It needs Node.js 22.13 or newer and one package, Anthropic's SDK (`@anthropic-ai/sdk`), used only by the verification bot's AI. Data is stored in SQLite through the built-in `node:sqlite` module.

## Quick start

```bash
npm install               # once
npm start                 # http://localhost:3000
```

On first run it creates a team leader account, `admin@crm.local` / `changeme123`. You can override this with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Sign in and add your staff on the **Users** page.

To try it with sample data:

```bash
npm run seed:demo         # leader@, manager@, sales@, sales2@, processing@, vlead@ (verification TL), governance@, head@ (business head) demo.local — password "password123"
npm start
```

Run the tests with `npm test`.

## Boosters

Business heads and MIS run **boosters** from the Boosters page: a campaign for one product (or all) between two dates, with a reward line and details, for both regions or one, for the product's core staff or every sales person, and optionally only some team leaders' teams. A booster shows on the dashboard of every sales person it covers and of their team leaders, ASMs and sales managers while it runs and for two weeks before it starts (and a week after it ends), with the dates, days left, the reward and progress: the files completed in the window with that product (AED disbursed for loans), and for leaders how many covered staff have contributed and who is covered. Files with a valid complaint do not count. Boosters can be edited, switched off and deleted. API: `GET/POST /api/boosters`, `PUT/DELETE /api/boosters/:id`; the dashboard carries `boosters`.

## Verification TAT

A file should be verified within **2 working days of its sourcing date** (Saturday is a working day; Sundays and public holidays are days off, so a file sourced before one counts from the next working day). Files still to verify carry a **TAT today**, **TAT tomorrow** or **Past TAT · n days** chip in the lists, and the file page shows the due date and, once verified, whether the TAT was **met** or **missed**. Processing, team leaders and everyone above get a **Past verification TAT** tile on the dashboard (sales staff only when one of their files is late), linking to `#/cases?tat=overdue`. Rejected files and files whose case is already completed or rejected stop the clock. The clock keeps running while a file waits for approval or is back with sales. MIS and business heads keep the **Holidays** list (Admin → Holidays; a holiday can run over several days, e.g. Eid); `GET/POST /api/holidays`, `DELETE /api/holidays/<YYYY-MM-DD>`. `GET /api/cases?tat=overdue`; each case carries `tat`, and `/api/stats` carries `tat.overdue` and `tat.due_today`.

## Power button

The **Dubai business head** (and no one else, not even Dubai MIS) has a **power button** in the top bar next to the notification bell: **red** when off, **green** when on (the API calls it the TAT switch, `GET/PUT /api/tat-switch`). While it is on, every file past its verification TAT shows as verified (Completed), exactly like a normal completed file, and leaves the processing queue; files that pass their TAT while it stays on follow. Only the verification status moves: the case status, targets, incentives and payouts still follow what the bank completes. A held file reads as verified everywhere: its history shows an ordinary **Verification completed** by **Processing team** at the time it was held, the stage log and Time by stage report count it as with the bank, and reports show it as Verified with that time. Turning it off puts each held file back at the stage it was at (a held file sent for re-verification in the meantime is released then). The button never appears in a file's history, on or off. Its record is the **Power button** log on the Access log page, for governance and business heads only: every press, who pressed it, and the files it held or moved back (`GET /api/tat-switch/log`). Stored events never change.

## Time by stage

Each file page has a **Time by stage** log built from the file's history: every stage it passed through (waiting for TL/SM approval, waiting for a processor, in verification, verification pending with the team leader, returned to sales, verified and with the bank, applicant review), when each started and ended, how long it took and who moved the file on. A stage visited more than once adds up. The **slowest stage** is highlighted, with its share of the file's time, and a bar shows the split. The clock stops when verification is rejected or the case is completed or rejected; until then the current stage runs to now. The **Time by stage** report shows the same across all files sourced in a period: per stage, how many files went through it, the average and longest time, and on how many files it was the slowest. Each case from `GET /api/cases/:id` carries `stages`.

## Card pitch

When a sales person chooses a credit card and the customer's salary (or, for a self-employed customer, average balance) qualifies for higher cards, the form lists every one of them by family. Picking one opens a three-slide **pitch**: the upgrade (the card chosen now beside the one the customer qualifies for), **what the customer gets** (the card's features), and **a script to say**, addressed to the customer by name, ending with **Switch to** the higher card or **Keep** the chosen one. Each time a pitch opens, the server reads the card's page on the Emirates NBD website (`https://www.emiratesnbd.com/en/cards/credit-cards/<card-name>-credit-card`, or the **Website page** given for the card in the card product upload; only https pages on emiratesnbd.com are read). The last good reading of each card is kept, so when the site is slow (6 seconds), unreachable or changes its layout, the pitch shows the saved copy with its date; with neither, it links to the card's page. The server needs outbound access to emiratesnbd.com. The in-browser demo cannot read the bank's site and shows saved readings only. API: `GET /api/cards/pitch?name=<card>`.

## Each user's dashboard

The landing page is personal. It opens with the sales cycle (day, days left) and the person's own achievement against target with progress bars (a leader's or manager's team, everything for MIS and business heads), the **incentive so far** for the people who earn one, and a **six-cycle trend** of files sourced and completed in their scope, with the numbers available as a table. Then only what **needs their attention** (returned files, pending verifications, edit requests, approvals, urgent flags), the role's work list, a compact row of **file counts** for the cycle, and the team table for leaders. Team leaders, ASMs and sales managers (and business heads and MIS over everyone, by region) also get **Staff on zero**: how many of their active sales staff, as a count and a share, have **zero ends or disbursals** (no file completed this cycle) and **zero submissions** (no file sourced this cycle), with the names highlighted and linked to their files, and the same two measures split **by product** (core card, loan and auto loan staff) and **by hierarchy** (team leaders for a manager; region, sales manager and team leader for a business head or MIS), the zero-ends count also broken down by product on each team row. Sales staff and leaders also get a **submission calendar** for the cycle: one cell per day, a sales person's day **green** when they sourced a file and **red** when not; a team leader's, ASM's or sales manager's day **green when 70% or more of their active sales staff sourced a file, orange from 50%, red below**, with the share on the cell. Saturday is a working day; a Sunday with nothing sourced shows as the day off, and days still to come are blank. Business heads and MIS also get a **core team vs cross-sell** chart: one bar per product (credit cards in card points, personal loans and auto loans in AED disbursed) split between the core team and what other teams cross-sold, with the amounts, file counts and shares, and the numbers as a table. Team leaders and above also get **cross-sell tiles** for the cycle: on the files completed in their scope, what each core team sold outside its own product, such as the personal loans (count and AED disbursed) sold by the core card team and the cards sold by the core loan team. A file counts once per product on it that is not the sales person's core product. Business heads and Dubai MIS also see the payout from the bank. `GET /api/dashboard` returns the cycle, counts, trend and incentive for the signed-in user.

## Leads

Sales staff keep their prospects in **My leads** before there is a file: name, mobile, email, company, salary, the product they are interested in, source, city, a follow-up date and notes. A lead is seen **only by the sales person who owns it and their team leader** (a sales manager or ASM leading the team directly counts as the team leader); nobody else can list or open it. The team leader sees the team's leads read-only and can add a lead for one of their staff. The sales person can:

- **Convert to case**: opens the new-case form with the lead's details filled in (names, mobile, email, company, salary, product, source, city, notes). Submitting the file marks the lead **Converted** and links it to the file. A converted lead cannot change.
- Mark it **Not interested** or **Not eligible**, with an optional note, or **reopen** it.

**Scan a lead sheet**: on the add-lead form, the sales person can photograph a printed or hand-written lead sheet with the phone's camera (or choose a photo). The text is read on the device with the same OCR engine as the Emirates ID scanner, and labelled lines (Name, Mobile, Email, Company, Salary, Product, Source, City, Follow up, Remarks) or, failing those, a recognisable mobile number, email, salary, product and name fill the form, marked for checking; OCR slips in digits (O for 0, l for 1) are repaired in the number. Nothing is saved until the person checks and adds the lead; nothing leaves the phone. Clear printed sheets read well; hand-writing reads only when neat.

**Follow-ups**: each lead can carry a follow-up **date and time** (on the form, or the Set control on the row). Open leads with a follow-up appear on the sales person's dashboard as tasks: **Tasks for tomorrow** from the day before, **Today**, and **Overdue**, with the time, the customer, a call link and a Convert link; the team leader's dashboard shows the team's. Closing or converting the lead, or clearing the date, removes the task. `POST /api/leads/:id/follow-up` (`follow_up_at`, `follow_up_time`).

**Calling a lead**: the mobile number on each lead is a call link. Tapping it asks "Call <name>?" with the number and **Call** or **Cancel**; Call opens the phone's dialler with the number (a `tel:` link), so the call is made from the staff member's own phone and nothing is dialled without the confirmation. This is on the leads page only; customer numbers on files stay as they are.

The page counts open leads, follow-ups due, converted, not interested and not eligible, and filters by status or text. API: `GET/POST /api/leads`, `GET/PATCH /api/leads/:id`, `POST /api/leads/:id/status`; `POST /api/cases` with `lead_id` converts the lead.

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

### Typing by voice and reading numbers back

On the case form, boxes for names, company, address, city, lead source and notes have a **microphone**: tap it and say the words, and they are typed in (names in Title Case; notes are added to what is already there). The browser does the recognition itself (Chrome, Edge and Safari; not Firefox) and nothing is sent to the CRM server. The buttons only appear where speech is available, and the microphone needs permission and HTTPS.

The Emirates ID and passport boxes also have **Read it back to check**: after typing or scanning the number, the sales person reads it aloud, digit by digit (letters as "N" or "November"; "double seven" works), and the form says whether it matches. A match is recorded on the case timeline as *Number checked by read-back*. Changing the number clears the check.

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

### Region view, team view and reports

**Region view.** Business heads, MIS and governance see every file. A switch in the top bar narrows the whole app to one region, DXB or AUH: the dashboard, case lists, targets, the team view and reports all follow it until it is set back to All regions. The choice is remembered in the browser.

**Team view** (`#/team`) is the dashboard for every level of the hierarchy. It shows the sales cycle's numbers rolled up at each level the viewer oversees, region → sales manager → team leader → sales staff, with groups that expand and collapse. Files count under the team stored on them, so a sales person who changed team appears under the old team too for the files sourced there:

| Viewer | Sees |
|--------|------|
| Business head, MIS, governance | Regions (each sales person's own), then sales managers, team leaders and staff |
| Sales manager, assistant sales manager | Their team leaders and staff |
| Team leader | Their sales staff |
| Sales | Themselves |

Columns: staff, sourced in the cycle, awaiting verification and verification pending (open now), verified and completed in the cycle, AED disbursed, credit cards and loans against target, cards active. The dashboard carries the top level of the same table.

**Reports** (`#/reports`) run on screen and download as CSV for Excel. Each covers the viewer's scope (a team leader's team, a regional processor's region) and a period: a sales cycle or two dates (up to 400 days), optionally one region. Every run is recorded.

| Report | Who | Rows |
|--------|-----|------|
| Sourcing by sales staff | MIS, business head, TL, SM, ASM | Files sourced per sales person, verification results, case outcomes, AED disbursed, temp ends, deviations, promotions and cards below eligibility |
| Pipeline by region and product | MIS, business head, governance | Where files sourced in the period stand, by region and core product |
| Verification team productivity | MIS, business head, governance | Calls, connect rate, results marked, hours from sourcing to verified, QC average per processor |
| Target achievement | MIS, business head, TL, SM, ASM | Target, achieved and % per product per sales person for a cycle |
| Card activation and ageing | MIS, business head | Temp ends, active/inactive/out of range, activation % and ageing buckets per sales person |
| Governance summary | Governance, business head | QC flags, urgent, recordings, complaints, scores, DNCR, re-verifications, read-backs, scans, card deviations, promotions, approvals waiting and cards below eligibility by region |
| Access and reveals | Governance, business head | Files opened, personal details revealed (by kind) and reports run per user |
| Personal loans | TL and above | Every personal loan on a file completed in the period: staff and team, loan type, amount, disbursed and counted, Emirates Islamic buy-out, top-up incremental, FPD, tenure, and whether it was a cross-sell |
| Auto loans | TL and above | Every auto loan on a file completed in the period: staff and team, new or used, payout class, car, amount, disbursed, points rate and points, and whether it was a cross-sell |
| Card deviations and promotions | MIS, business head, governance, TL, SM, ASM | Cards sold below the salary requirement: the reason, who decided and when, and files still awaiting approval |
| Cards sold below eligibility | MIS, business head, governance, TL, SM, ASM | Cards where the customer's salary qualified for a higher category: category sold and eligible, points earned, points the best eligible card would have earned, and points lost per file and per staff member |
| Case register (export) | MIS, business head, governance, TL, SM, ASM | One row per file including the card reason and eligibility; phone and ID numbers stay masked |

API: `GET /api/hierarchy?cycle=&region=`, `GET /api/reports` (the list for the role), `GET /api/reports/:key?cycle=|from=&to=&region=&format=csv`. `region=` is also accepted by `/api/cases`, `/api/stats` and `/api/targets`.

### Buyouts on a personal loan

A **fresh** loan (and a **top-up**) asks the sales person to confirm whether there are any **secondary buyouts**, Yes or No. A **buy-out** loan first asks for the **primary buyout**: the **personal loan being bought out** (bank and outstanding amount) is mandatory, and other liabilities the loan also clears can be added; then the same secondary question follows. Each buyout entry is a credit card, a non-STL loan, an auto loan or a mortgage with the bank it is held at and the amount: for credit cards the form asks how many cards and takes each card's bank and limit; for loans and mortgages the bank and the outstanding amount. The case page lists the primary and secondary buyouts with a total, and the sales person's No is recorded as confirmed.

API: `pl_buyouts` is a list of `{ role: primary|secondary, kind, bank, amount }` and `secondary_buyout` is `yes` or `no`; a buy-out with only `buyout_bank` is treated as a primary non-STL loan buyout. The cases bulk upload takes a **Buyouts** column (`Primary|Non-STL loan|RAKBANK|120000; Secondary|Credit card|FAB|15000`) and a **Secondary buyout** column.

### Auto loan details and loan tenures

When a file includes an **auto loan**, the form asks for the auto loan type (**New** or **Used**), car make, model and year (1990 to next year), the bank's **payout class** (Full payout by default; Algo loan or Low-payout non-algo, which set the points the loan earns), the loan amount, **ROI** (% a year), **tenure** (whole months, up to 60), dealer details (optional) and the lead source. A **personal loan** also needs a **tenure** of up to 48 months. All of these show on the case page and in the case register export, are columns in the cases bulk upload, and changing any of them after verification sends the file back for re-verification.

### Card salary requirement, deviations and team approval

Every card in the product list has a **minimum monthly salary** (AED 5,000 for Mass cards, 12,000 to 20,000 for Premium, 25,000 to 30,000 for Super Premium, as in the bank's list). On the form, once a card and the customer's salary are entered:

- **Salutation and names:** the form starts with a salutation (Mr, Mrs, Ms, Dr) and the customer's first, middle and last names; the salutation shows on the file's heading and addresses the customer in the DNCR permission email ("Dear Ms Al Ali"). The Emirates ID and passport number are no longer captured or kept: the fields, the Emirates ID scanner, the read-back check, the bulk-upload columns and the call bot's ID check are gone, a value sent by an older client is dropped, and anything stored before is wiped (and its reveal entries removed from the access log) the first time the server starts on this version. Card activation uploads match by CRM reference or App ID.
- **Salary below the requirement:** an error shows with two choices, **Product deviation** or **New promotion** (plus an optional reference). Picking one sends the file straight for verification with the reason recorded against the sales person. Submitting without one, after a confirmation, puts the file in **Awaiting TL/SM approval**: processors do not see it, and the file's team leader, sales manager and ASM are notified. One of them opens the file, records the reason and sends it for verification, or returns it to sales with a note. The sales person can also add the reason themselves while it waits, and a resubmitted or edited file is re-checked.
- **Completed based on deviation:** a processor who cannot reach the customer can still complete verification by choosing **Completed based on deviation** in the result list. A note with the reason is mandatory; it is recorded on the file, shown in the banner with a *Deviation* chip on lists, and the sales person and team leader are told.
- **Processor allocation:** the built-in **Verification Team Leader** role (a processor who also allocates; put a processing user on it from the Staff page) and business heads open **Processor allocation** and choose, for each sales team leader, which processor verifies their **credit cards**, **personal loans** and **auto loans**: one processor for everything via "All products", or different processors per product, or any two of the three. A file reaches only the processors allocated for its products (a bundle follows every product on it); a product left on the shared queue goes to every processor, as do team leaders with no allocation. Other processors cannot see or claim routed files, and alerts for them go to the allocated processor. The verification team leader sees every file. API: `GET /api/allocations`, `PUT /api/allocations/:teamLeaderId` with `product` (`credit_card`, `personal_loan`, `auto_loan` or `all`) and `processor_id` (null clears it).
- **Complaints and incentive:** governance adds the complaint number on a file and then marks the complaint **Valid** or **Invalid** under it, with an optional note. A file with a valid complaint is **removed from the sales person's incentive** for the cycle, under every scheme and in every team total built from the staff's files: the staff member's incentive card and the incentive reports show the remark *Removed from incentive due to valid complaint cases* with the number of files, and the file carries a *No incentive* chip. Marking it invalid puts the file back. The sales person and their team leader are notified either way.
- **Sourced on a Sunday, or entered after 6 pm:** the file is flagged (a *Sunday* or *After 6 pm* chip on lists and on the file) and also waits in **Awaiting TL/SM approval** until the team leader, sales manager or ASM approves it for verification or returns it to sales with a note. The Sunday rule reads the sourcing date on the file; the after-hours rule reads the UAE time the file is entered, since that is the only time the system knows. A file that is both below salary and flagged needs both decisions before it moves on. Bulk uploads carry past files and are not flagged. The **Approvals** page lists everything waiting, with the reason.
- **Salary qualifies for a higher card:** a prompt lists the higher cards the customer is eligible for, with one tap to switch.
- A card with a requirement needs the customer's salary; a file without it is refused.

The case page shows the card's requirement, whether the customer meets it, and the reason with who chose it and when. API: `card_salary_exception` and `card_exception_note` on create or update; actions `approve_card` (`exception`) and `decline_card` (`note`); status `awaiting_approval`; `card_approvals` in `/api/stats` for approvers.

### Credit card product list and card category

Every credit card has a **family**, a **card category** and, when the bank provides them, **points**. When a sales person chooses a card on the form, the category and points fill in automatically (read-only) and are saved on the file, so later changes to the list do not rewrite old files.

The CRM ships with the bank's product list built in: 34 cards in 18 families, each with its category (**Mass**, **Premium** or **Super Premium**), minimum salary and points (450 to 1,050 per card). MIS or a business head replaces it with a newer list from **Bulk upload → Card products** using the downloadable template (Card name, Family, Card category, Points). Cards left out of the upload are retired: they stay on existing files but are no longer offered. `GET /api/me` reports `card_list_source` as `built_in` or `uploaded`.

### Profit and loss, and salaries paid

**Bulk upload → Salaries paid** (business head or Dubai MIS) records the salary actually paid to each person for a sales cycle, any role, by HRMS code (`HRMS code, Cycle, Salary paid (AED), Incentive paid (AED), Notes`). The incentive column is only for an actual that differs from what the scheme computes; blank uses the computed amount. Uploading the same person and cycle again replaces the figure.

**Profit & loss** (business heads; a CEO account is a business head, or a role based on one) shows, per cycle and optionally per region: **revenue**, the bank's payout on files completed in the cycle by product; less **salaries** by role (sales staff, team leaders, ASMs, sales managers, business heads, processing, MIS, governance, IT), from the upload, with anyone lacking one **estimated from their profile salary and flagged**; less **incentives** by role, the schemes' amounts for the cycle or the uploaded actual; giving the **net** and margin. The same statement is a downloadable report (`pnl`). **By region and team**: the statement also follows the hierarchy, region → sales manager → team leader → sales staff, as an expandable table and a second report (`pnl_hierarchy`). Revenue follows the team on each completed file; salaries and incentives follow the people, a leader's at their own line; business heads, processing, MIS, governance and IT are the region's overheads; people with no region sit under "No region set". The top-bar region switch applies to the page. The uploaded salaries for the cycle are listed under the statement. API: `GET /api/pnl?cycle=&region=`, `POST /api/import/payroll`.

### Roles: defining roles on top of the built-in ones

**IT, Dubai MIS and business heads** can define roles on the **Roles** page. A custom role is **based on** a built-in role (Sales, Processing, Team Leader, ASM, Sales Manager, MIS, Business Head, Governance, IT) and behaves exactly like it in the workflow: the same files, the same actions, the same masking. What the definition changes is what the role is given, and it can only ever be **less** than the base:

- **Screens**: files, targets and incentives, team view, card activation, reports, bulk upload, staff, access log, tab register, messages, roles. A screen that is not ticked disappears from the sidebar and its API returns 403.
- **Reports**: every report the base role can run, or a chosen subset.
- **Uploads**: which bulk uploads, if any (only where the base role has them).
- **Downloads**: whether report spreadsheets and the staff list can be downloaded.
- **Pricing**: whether payouts and incentives are visible, where the base role (MIS in Dubai, business head) could see them.

**Approval.** Every new role needs a **Dubai business head's approval** before anyone can be put on it: a role created by IT or Dubai MIS waits as *Awaiting approval* (the business head sees a count on the Roles link and Approve / Reject buttons, a rejection needs a note, and an edited rejected role goes back for approval); a role a Dubai business head creates is approved by that act. A person is put on a role from the Staff page (new user, or the role field in the edit panel) or by the staff upload, by the role's name. Their account is stored as the base role plus the custom role, so every existing rule keyed on the base role (teams, targets, incentives, scoping) applies unchanged. A role cannot be deleted while someone has it, and its base cannot change while someone has it. API: `GET/POST /api/roles`, `PATCH/DELETE /api/roles/:key`; `GET /api/me` returns `meta.perms` for the signed-in user.

### Assets: the sourcing tabs issued to sales staff

Each sales person is issued a tab by the bank for sourcing. The **Tab register** records, per tab: the **serial number**, **tab number**, **accessories assigned** (charger, stylus, card reader), **network** (Etisalat or du), **SIM card number**, **Microsoft Entra ID** and the **mobile number registered** on it, plus notes. A tab is in one of four states: **Active, in use** (held by a named staff member), **With IT custody** (spare, in repair, or returned), **Handed over on exit** (returned by a leaver) or **Returned to bank**, which records the **date it went back** (shown on the register and the inventory). Assigning a tab puts it in use with that person; a person can hold only one tab at a time. Moving it to IT custody or marking it handed over clears the holder and remembers them as the previous holder. Every registration, edit, assignment and status change is logged with who did it and when.

- A new **IT** role keeps the register (`Staff → Add user → IT`). An IT account sees only the register, the staff list (names, codes, roles and regions, no salaries or contact details) and the inventory report: no files, chat or targets.
- **MIS and business heads** see and can change the register too, and the Staff page shows each sales person's tab (or "No tab issued").
- **Sales staff** have a **My tab** page in the sidebar with their tab's details and history; the dashboard stays uncluttered.
- The **Tab inventory** report (IT, MIS, business heads) lists every tab with its holder, accessories, SIM, Entra ID and mobile, and can be downloaded as a spreadsheet at any time; its note counts tabs by status and the active sales staff without one.

**Bulk upload → Tab register** (IT, MIS, business heads) takes a CSV with the tab and serial numbers, Yes/No for each accessory, network, SIM, Entra ID, registered mobile, an **Issued to** column (HRMS or sales code), an optional status and notes. A serial already registered updates that tab; naming a holder issues it; a status of With IT custody or Handed over on exit moves it. Nothing is saved until the preview is confirmed.

API: `POST /api/import/assets`, `GET/POST /api/assets`, `GET /api/assets/mine`, `GET/PATCH /api/assets/:id`, `POST /api/assets/:id/assign` (`holder_id`, `note`), `POST /api/assets/:id/status` (`status` it_custody, handed_over or returned_to_bank, `note`, `returned_on` for the bank return date), report key `assets`.

### Go-live staff list

`docs/go-live/` holds the upload files built from the agency's staff list (`staff-upload.csv`, `salary-targets.csv`) and a README on how the sheet was mapped and which placeholders to replace. Rules that came from that list: a sales person's **team leader may be a sales manager or ASM who leads the team directly**; the **sales manager is optional** (a team can report to the business head); **targets follow the core product** (a credit card seller gets only the card target, multi-product staff get every product with a band); and in the staff upload the **HRMS code is required for every role, leaders included**, while the **mobile number is optional**.

### Credit card incentives

The incentive structures below are the agency's own, for paying its staff; the bank sets only the payout rates per file and the data cut the amounts are subject to. The CRM works each one out per sales cycle from completed files.

What a credit card sales person earns on the points they make beyond their card target in a sales cycle, from completed files only:

- **Points** = card points (each card's points from the product list) + personal loan points, where **AED 50,000 of personal loans disbursed = 500 points** (AED 100 per point) and a loan **buying out an Emirates Islamic loan counts at 50%** of its disbursed amount.
- **Excess** = points beyond the credit card target for the cycle.
- **Rate**: **AED 1.25 per excess point** when at least **33% of the cards sold are Premium or Super Premium**, or at least **AED 50,000 of personal loans** (counted amount) were cross-sold; otherwise **AED 0.70**.

**Personal loan sales staff** earn a percentage of the cycle's disbursed production, on the whole amount, by band: 0.40% from AED 600K, 0.55% from 750K, 0.75% from 1M, 0.90% from 1.25M, 1.10% from 1.5M, 1.20% from 2M; nothing below AED 600K. An Emirates Islamic buy-out counts at 50% of its disbursed amount, and a **top-up counts 70% of its incremental amount from the October 2026 cycle** (100% of it in earlier cycles; both schemes). Their **My targets** page shows production, band, rate, the amount and how much more reaches the next band; the business head and DXB MIS run the **Personal loan incentives** report per cycle.

The band rate applies to the whole production, not slab by slab (confirmed). **Cards cross-sold** by personal loan staff pay a flat amount each (**Mass AED 500, Premium AED 900, Super Premium AED 1,100, noon nil**), paid only once the staff member's counted production reaches their **threshold of target less AED 100,000**; the production bands pay regardless. The total is the production incentive plus the cards.

**What the open files could earn.** Every sales scheme block also shows the person's **potential**: how many of their files are still in the system (sourced, awaiting or in verification, not yet completed or rejected), what the scheme would pay if they all completed this cycle (loan amounts taken as disbursed, cards at their points), how much more than today that is, and **how much more they need to start earning**: the points or production still short of the target or first band from today's completed files, and after the open files complete; for loan staff, the next band and the card cross-sell threshold too. Each block ends with a **push** that puts the next step in dirhams: for loan staff, what the whole production pays on reaching the first or next band and what every extra AED 100,000 adds; for card staff, what the first 1,000 points past target are worth and what each further 100 points add; for auto loan staff, what a AED 100,000 car loan earns past target. The dashboard tile carries the one-line version ("Could reach AED X if your N open files complete").

**Multi product sales staff** (core product Multi product) are paid under **each product scheme they hold a target for** in the cycle, with nothing counted twice: in the card scheme their personal loans add no points and no cross-sell criterion, and in the loan scheme their cards pay nothing (assumed, since the structures define core card, loan and auto loan staff only; change it if the business decides otherwise). Each scheme shows as its own block on My targets, the dashboard tile sums them, and the person appears in each product's incentive report. A multi product staff member with no target this cycle, or a sales person whose core product is not set, sees a note saying so instead of a blank.

**Core auto loan sales staff** (core product Auto Loans; nobody else, whatever auto loans they cross-sell) are paid on **points beyond their auto loan target**. A loan's points are its **disbursed amount at the bank's payout rate**: new and used car loans **0.80%** (AED 200,000 = 1,600 points), **algo loans 0.25%**, **low-payout non-algo loans nothing**. Excess points pay **AED 1.10 each once new and used car disbursal in the cycle reaches AED 250,000**, otherwise **AED 0.60**; algo loans earn points but do not count towards the AED 250,000. The worked example from the structure (200,000 new + 300,000 used + 100,000 algo = 4,250 points, threshold 2,000, excess 2,250 × 1.10 = AED 2,475) is reproduced in the tests. The same points count as the auto loan target achievement on the Targets page. Each auto loan file carries a **payout class** (Full payout, Algo loan, Low-payout non-algo): Full payout by default, set on the sourcing form, or corrected by MIS when the loan is completed or the disbursed amount is updated. There is **no incentive for auto loan team leaders or managers** (confirmed), so a leader whose only team is auto loans sees no incentive block and appears in no leader report.

**Credit card team leaders** (anyone whose team includes active core credit card staff: a team leader, or a sales manager or ASM leading a team directly) earn on the **team's card points beyond a team threshold of 75% of the team's combined card targets**. Team points are card points only, from the core card staff's files completed in the cycle; personal loan points are left out. Excess points pay **AED 0.30 each when the team's personal loan cross-sell reaches AED 50,000 (gross disbursed) or its Premium and Super Premium mix exceeds 20%**, otherwise **AED 0.20**. On top, the team's personal loan cross-sell earns **0.15% of the gross amount disbursed** as a separate line. The structure's example (combined targets 100,000, threshold 75,000, 95,000 points, 20,000 excess × 0.30 = AED 6,000) is reproduced in the tests. A team member without a card target adds nothing to the threshold and is counted on the report. Settled with the business: the mix must strictly exceed 20% (exactly 20% stays on AED 0.20), and "gross" cross-sell is the full disbursed amount with no Emirates Islamic haircut, for both the AED 50,000 test and the 0.15%.

**Personal loan team leaders** (anyone whose team includes active core personal loan staff) earn a percentage of the **team's whole counted production** by the team's achievement of its **combined personal loan targets**: nil below 80%, **0.05% from 80%**, **0.15% from 100%**, **0.20% from 125%**, **0.25% from 150%**. Production counts regular loans in full, top-ups at their counted share and Emirates Islamic buy-outs at 50%, exactly as for the staff. Cards the team cross-sells pay a flat amount each (**Mass AED 20, Premium AED 50, Super Premium AED 100, noon nil**), paid only once the team is at 80% of target. A leader with both a card team and a loan team gets both calculations separately, one block each on the Targets page and one row in each report.

**Credit card sales managers and ASMs** earn a **flat amount per card** their core card staff sold, by the team's achievement of its combined card targets: nil below 70%, **AED 15 from 70%, 20 from 80%, 30 from 100%, 35 from 110%, 40 from 125%, 45 from 140%, 50 from 150%** (the structure's example: 120% with 500 cards = AED 17,500). **Managers with personal loan production** earn a percentage of the team's **whole loan production**, core loan staff plus loans cross-sold by the rest of their team, by its achievement of the core staff's combined targets: nil below 80%, **0.02% from 80%, 0.0625% from 100%, 0.075% from 125%, 0.10% from 150%**. The same loan grid applies to every manager with loan staff (confirmed). **Cards cross-sold by the rest of a card manager's team** (loan staff and others) are **added to the team's card numbers**: they count in the cards paid at the slab and in the points measured against the core card staff's targets. A sales manager's team is everyone whose sales manager they are; an ASM's team is everyone whose ASM they are. A manager who also leads a team directly gets the team leader calculation as well. A manager of a mixed team gets one card calculation and one loan calculation on the relevant staff (settled).

Every incentive is calculated the same way in DXB and AUH; there is no AUH-specific treatment (confirmed). The whole incentive workflow is built.

**All incentives are subject to achieving a minimum of 60% of target in the next sales cycle, and to the bank's data cut finalisation.** Both conditions are printed under the staff member's incentive block and under the incentives report.

Two points settled with the business: the 50% rule for Emirates Islamic buy-outs applies to the AED 50,000 cross-sell test as well as to the points, and the premium mix is measured by the number of cards, not their points.

Sales staff see their own working on **My targets** for their core product (cards: points, excess, which criterion they meet; personal loans: production, band, next band; auto loans: points, excess, whether the AED 250,000 is met, incentive so far). Team leaders, sales managers and ASMs see one block per team they lead or manage (cards, personal loans). The business head and DXB MIS run the **Credit card incentives**, **Personal loan incentives**, **Auto loan incentives**, **Credit card team leader incentives**, **Personal loan team leader incentives**, **Credit card sales manager incentives** and **Personal loan sales manager incentives** reports for a cycle (one row per seller with every input and the amount, totals and the conditions underneath). Nobody else sees incentives. The rates live in `src/incentives.js`.

### Payouts: what the bank pays per file

Every file carries the revenue it earns the agency, from the bank's payout rates. **Only the business head and MIS staff whose region is DXB** see it (never sales staff, processors, team leaders, ASMs, sales managers, governance or MIS in AUH): on the case page (**Agency payout**, with the working), on the dashboard (**Payout from the bank**: earned on files completed this cycle, and what the open pipeline would earn) and in the reports: the sourcing report gains a **Payout (AED)** column, the case register a payout per file, and **Cards sold below eligibility** prices the lost upgrade (**Payout earned / possible / lost**). Everyone else gets no payout fields, no revenue tiles and no payout columns, and cannot open or use the Payout rules upload.

| Rule | Built-in rate |
|---|---|
| Mass card | AED 1,400 per card (noon One Visa: AED 1,100) |
| Premium card | AED 2,000 per card |
| Super Premium card | AED 2,600 per card |
| Personal loan | 3% of the amount (disbursed once completed, else sourced) |
| Personal loan buying out an Emirates Islamic loan | 1.5% of the amount |
| Auto loan, new car | 0.70% of the amount |
| Auto loan, used car | 1.75% of the amount |

The business head or DXB MIS changes any rate from **Bulk upload → Payout rules** (`Rule,Value`; rules named as above or by key, e.g. `card:Mass`, `personal_loan_pct`). `GET /api/me` reports `payout_rates` and `payout_source`.

### Targets and sales cycles

**Sales cycle.** A cycle runs from the **21st of one month to the 20th of the next** and is named after the month it ends in, so 21 May – 20 June is the **June cycle**. Dates are UAE dates.

**What counts.** A case counts towards a cycle when its **case status is set to Completed** during that cycle. How it counts depends on the product:

| Product | Completed case is a… | Target and achievement |
|---|---|---|
| Credit card | temp end | number of temp ends |
| Accounts | completed case | number of completed cases |
| Personal loan | disbursal | **AED amount disbursed** |
| Auto loan | disbursal | **points: the AED amount disbursed at the bank's payout rate** (new and used 0.80%, algo 0.25%, low-payout non-algo nil) |

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

**Setting targets.** Only **MIS and business heads** set targets, per sales person, cycle and product: card points and auto loan points, a number of cases for accounts, and an AED amount for personal loans (for example `1,500,000`). There are two ways:
- **Set targets** on the Targets page turns the staff table into an editable grid. **Copy *last month's* targets** fills empty boxes from the previous cycle.
- **Bulk upload → Targets** takes a CSV with a sales code, a cycle (`Jun 2026` or `2026-06`), card and auto loan points, account counts, and personal loan disbursal amounts in AED. Blank cells leave a target unchanged.

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

The **Staff** page (MIS and business heads only; team leaders no longer add users) lists every user with counts by role, a search and filters by role, region and status, a **Download staff list** button, and the add and edit forms. Every user added there needs a full name, an **HRMS code**, an **email address** and a **local mobile** number; a **WhatsApp number** is optional. Sales staff also carry a **core product** (Credit Cards, Personal Loans, Auto Loans or Multi product), the line they mainly sell, which pre-fills the core product on their new files. A **date of joining** is optional on every user (Users page or the bulk upload, DD/MM/YYYY). When someone resigns, a team leader sets their **date of leaving** (Edit on the Users page, or the bulk upload): the account is disabled from that day, up to 180 days ahead for a notice period, and cannot be re-enabled until the date is cleared. Their files, numbers and history stay. The HRMS code is the bank's staff code: it is unique, stored upper-case, and is the person's **username** at sign-in (the email address also works). The bulk users upload has an HRMS code column, and the sign-in details sheet it produces lists the HRMS code as the username.

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

When MIS or a business head registers a sales person on the **Staff** page, they enter a **sales code** and choose the person's **team leader** and **sales manager** from existing users, and optionally an **assistant sales manager**. A team leader can change these later with **Edit**.

At the top of every file, the **Sales staff** section shows the sales person's full name, sales code, team leader and sales manager:

- When a sales person enters a file, it fills in automatically from their profile and can't be edited.
- When a team leader or sales manager enters a file, they pick the sales person and the rest fills in.

These details are saved with the file as they were at submission, so later changes to a profile don't rewrite old files. A sales person can't submit until their profile is complete. The named sales person owns the file: they see it, can request edits and receive its notifications.

Every file also needs:

- a **Region**: `DXB` or `AUH`
- a **Core product**: Credit Card, Personal Loan, Auto Loan or Multi product. It is suggested from the product chosen, and a bundle suggests Multi product.

The API fields are `region`, `core_product` and, for team leaders and sales managers, `sales_staff_id`.

### Customer details

The Employment section also records the bank the customer's **salary is currently transferred to**, chosen from the bank list (with an Other option), required on the form; it shows on the case page and in the register export, and is a column in the cases bulk upload.


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

### Chat: case discussions, direct messages and groups

- **Discussion on every case.** Everyone who can see a file can post in its *Discussion* panel (sales staff see only their own files). Type `@` and a colleague's name to alert them; they get a notification linking to the case. Messages update every few seconds while the page is open.
- **Messages page.** Direct messages between any two colleagues (**New message**) and automatic groups: *Everyone*, *Processing team*, and one per team leader (the team leader, their sales staff and their sales managers). Groups follow the Users page, so membership updates itself. Direct messages notify the other person; in groups only the people `@mentioned` are notified. Unread counts show in the menu.
- **Kept, not deleted.** A message can be edited by its author for 5 minutes (marked *edited*); nothing can be deleted.
- **Oversight.** Governance and the business head can read every conversation, and can post only in the ones they belong to. The Messages page says so.
- **Personal data stays on the file.** A message that looks like it holds an Emirates ID or phone number is posted but marked *Personal data*, so the habit is visible to governance. `CRM-000123` in a message becomes a link to the case.
- API: `GET/POST /cases/:id/messages`, `GET /conversations`, `GET /colleagues`, `POST /conversations/direct {user_id}`, `GET/POST /conversations/:id/messages`, `POST /messages/:id/edit`.

### Privacy controls: masking, watermark and access log

A web page cannot stop screenshots or photos of the screen, so the CRM limits what a capture would show and makes it traceable:

- **Masked identifiers.** Emirates ID, passport, phone numbers and salary are masked on every screen (`784-••••-••••567-1`, `Z•••••36`, `+••• •• ••• 4567`, `AED ••,•••`) until someone clicks **Reveal** on the case page (**Reveal to call** turns a mobile number into a dial link). **Reveal all** uncovers everything at once. **Sales staff get no Reveal button and the server refuses their reveals**: once a file is submitted the customer's mobile and alternate phone numbers are hidden from them altogether (not shown, not searchable), the other identifiers show only as masks, and they correct a value by typing a new one on the edit form. Revealed values **hide again after 3 minutes**, and at once when the tab is hidden or the page is left. The mask is applied by the server, so the full value never reaches the browser until it is revealed. Search still works on full values. On the edit form a masked value stays as it is unless a new one is typed.
- **Who can read a discussion.** The Discussion card on each file opens a **Visible to N people** list: everyone whose role and scope lets them open the file (the sales person, their team leader, ASM and sales manager, the region's processors, MIS, business heads and governance), grouped by role, so nobody has to guess who is reading.
- **Access log.** Every reveal, and every opening of a case, is recorded with who, what and when (repeats within five minutes count once). Governance, MIS and business heads see it on **Access log**, filterable by staff, customer or CRM ref, and can open it for one case with `#/access-log?case=ID`. The API is `GET /cases/:id/reveal?fields=phone,eid_number` and `GET /access-log?case=&limit=`.
- **Watermark.** Every screen carries a faint repeating stamp of the signed-in user's name, sales code or role, and the time, refreshed each minute, so a leaked screenshot or photo can be traced to the session it came from. It prints darker.

### Who sees which files

Each role sees only the files that concern them. The server applies this to lists, search, the dashboard counts, case discussions, direct links and targets alike.

| Role | Sees |
|------|------|
| Sales | Their own files |
| Team leader | Files of the sales staff whose team leader they are, plus any they entered themselves |
| Assistant sales manager (ASM) | Files of the sales staff mapped to them as ASM |
| Sales manager | Files of the sales staff mapped to them as sales manager |
| Processor with a **region** | Files in that region (`DXB` or `AUH`) and files with no region |
| Processor without a region, MIS, business head, governance | Everything |

Every staff member has a **region** (Users page or the users bulk upload). For a processor it limits the files they verify. For a sales person it pre-fills the region on their new files, but every file names its own region and any sales person can source in any region. The region switch for business heads, MIS and governance filters file lists by the file's region, and the team view and targets by the sales person's region. Team leaders, sales managers and ASMs pick sales staff only from their own team when entering a file, and may only move a file to staff in their team. An ASM has the same powers as a sales manager (entering files, edit requests, case status) over their own team; sales staff get an optional **Assistant sales manager** in their profile.

**Team changes.** Every file stores the team leader, sales manager and ASM it was sourced under. When a sales person's team is changed on the Users page, their open files (anything not Completed or Rejected, including files still in the checker queue) move to the new team, with a `team_change` event on each. Completed and rejected files stay with the old managers, who keep seeing them in their lists, team view and reports; the team view shows them as a **Previous team** row under the old team leader.

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

- team leaders when a case is marked incomplete (reasons include *Customer in DNCR*, for customers on the Do Not Call Register who cannot be phoned; such files show a DNCR chip and carry a **drafted permission email** to the customer, naming the product they applied for and as an Emirates NBD product, and asking them to reply with their consent to be contacted; the processing team or the team leader sends it, signed in their own name and team, never the sales person, and the draft disappears once the file is back in verification)
- sales when their case is verified, returned or rejected
- the processor when a case they handled is sent back or rejected

### Verification bot

The CRM has a **calling bot** that phones customers and runs the verification call by voice. It is taught on the **Verification bot** page (Admin), by business heads and the verification team leader. It can complete verifications on its own when every detail is confirmed, if you allow it. An optional **AI** (Claude) reads answers its rules cannot settle.

**A bot call is never automatic.** Every call is pushed through by people:
1. The **verification team leader** asks for a bot call on a file (**Ask for a bot call** on the file), with a reason. Processors cannot.
2. **Governance** and a **business head** both approve it, in either order, on the file or on the **Bot call approvals** page (with a count in the sidebar). Either can **decline** it with a reason. The verification team leader can **withdraw** it until the bot calls. Approvers are notified of each request; the team leader hears when it is approved, declined or the result comes in.
3. Once both have approved, the call is placed straight away within the **approved calling hours, 09:00 to 18:00 UAE time** (not on Sundays unless allowed), otherwise when they next open. The playbook can narrow these hours but not widen them: saving hours outside 09:00–18:00 is refused, and a playbook saved earlier with wider hours is held to them. A file verified by a person in the meantime is not called.

The bot never calls new files on its own and never retries an unanswered call: another attempt is a new request with new approvals. The **Bot calls** page lists waiting requests and the last 30 days, with who approved what.

**How a bot call goes.**
1. The bot greets the customer and checks it is speaking to them: "Hello, this is the verification team calling on behalf of Emirates NBD. Am I speaking with Asha?"
2. It says why it is calling and asks if now is a good time.
3. It asks one question per detail and compares each answer with the file: by default the **full name**, **product applied for**, **employer** and **monthly salary**. A question is skipped when the file has no value for it.
4. It closes the call. If someone else answers, or it is not a good time, it says goodbye politely and records that.

The bot re-asks (up to twice, by default) when it hears nothing it understands. When an answer does not match, it asks once more before recording a mismatch, because speech recognition mishears. A voicemail is hung up on and counts as not answered.

**Teaching the bot** (Verification bot page).

| Section | What you teach |
|---|---|
| Voice | The bank name it says, the language (English UK/US/India or Arabic UAE) and, optionally, a voice |
| What the bot says | Every line: greeting, introduction, closing, what to say if someone else answers, when it is not a good time, when it did not understand, and when an answer does not match. Lines can use details from the file: `{first_name}`, `{name}`, `{product}`, `{bank}`, `{company_name}`, `{salary}`… A typo such as `{firstname}` is refused when you save. |
| What the bot checks | The questions, in order: switch each on or off, reword it, choose the detail on the file it is compared with and how (**Name**: sounds-alike spelling is fine but the first and last name must be heard; **Key words**: most of the words on file, or their initials, so "ADNOC" matches *Abu Dhabi National Oil Company*; **Amount**: within 20%, 10% or 2%; **Yes / no**: the customer must say yes), and how strict to be. Add your own questions, for example "Do you agree to a credit check with {bank}?" as a yes / no question. Up to 12. |
| Words the bot understands | The words and phrases that mean yes and no, in any language (it ships with English and common Arabic and Hindi words such as *aiwa*, *naam*, *haan*, *la*). |
| AI | Whether the AI reads answers the rules cannot settle, and whether details it confirmed count towards completing a verification. See below. |
| What the bot may decide | See below. |

**Practising.** The practice panel plays a call with a made-up customer, using your unsaved changes. Type what the customer says (or **Say nothing**), and each answer shows how the bot understood it: *Understood: yes*, *Matches the file*, *Does not match the file* or *Did not understand*. When it did not understand a yes or no, click **teach it: means yes / means no** and the call replays with the new word. At the end you see each check's result and what the bot would do with these rules. Nothing from real files is shown on the teaching page. **Save** to use the changes on the next call.

**What the bot may decide.** By default it decides nothing: every result is left for a processor to review. You can allow it to:
- **Complete the verification** when every detail is confirmed. It is recorded as verified by *Verification Bot*, with a note, and the sales person is told as usual.
- **Mark verification pending** when a detail does not match (reason *Incorrect details*), so the team leader decides, as when a processor marks it pending.
- **Mark verification pending** when the customer cannot be reached after the set number of attempts (reason *Customer unreachable*).

Unanswered calls are counted per file since it last went back into the queue; each one was separately asked for and approved. The bot never rejects a verification: rejection stays with people.

**The AI.** With the AI switched on (Verification bot page, **AI**), answers the bot's rules cannot settle are read by Claude (`claude-opus-5-5` by default):
- **When it is asked:** only when the rules could not understand an answer ("mm-hmm", "twenty-five K") or heard a name or wording that differs from the file and may be mishearing or a paraphrase ("the national oil company" for *Abu Dhabi National Oil Company*). Answers the rules settle never go to the AI.
- **What it does:** it only interprets. It returns what the customer meant (answered, asked who is calling, asked to repeat, wants a call later, is not the customer, will not answer) and whether the answer matches the file. Everything the bot says still comes from the taught lines; when asked who is calling it says the taught **When asked who is calling** line and repeats the question. It cannot read a customer's details back to them, and customers' words are treated as data, not instructions.
- **What it is sent:** the question, what speech recognition heard, and for detail checks the label and the value on file. Nothing else from the file.
- **How results show:** details it settled carry an **AI** chip on the file and in practice, and the summary says "Understood by the AI: Employer". In practice, answers it read are marked *read by the AI*.
- **Completing:** by default, details the AI confirmed do **not** count towards completing a verification automatically: the file is left for a processor to review. Tick **Details the AI confirmed count towards completing a verification** to change that.
- **Letting it word the conversation:** set **Conversation** to *Let the AI word each line* and the bot sounds like a person rather than a script. For each line, Claude is given the conversation so far, the taught line and what the line must do (ask the next question, ask again, close…), and words it naturally: it acknowledges what the customer said and answers questions about the call from **What the bot may tell customers** (taught facts, such as how long the call takes) or says it cannot help with that on this call. A question about the call that the rules cannot settle (*why do you need my salary?*) is answered and the question asked again. What it may not do is enforced by the bot, not left to the AI: Claude never sees the values on file, and a wording is replaced by the taught line when it names a detail on file or an amount the taught line does not say, says whether an answer was right or matched, drops the question it must ask (or asks one when closing), or runs over 350 characters. The greeting with the recording notice and the lines that end a call early (someone else answered, not a good time) are always said as taught, and results are decided by the checks and rules exactly as before. The transcript has what was said; the practice call shows each AI-worded line with its taught line, and a refused wording. The call's summary says how many lines the AI worded. Reading and wording one answer share a 9-second limit (wording alone 4 seconds, `BOT_AI_PHRASE_TIMEOUT_MS`), after which the taught line is said. It needs the AI switched on; the conversation so far is sent to Anthropic for each line.
- **When it is unavailable:** if it is slow (more than 6 seconds, as a caller is waiting), declines, or is not set up, the bot carries on with its rules and re-asks. Requests opt into Anthropic's refusal fallback (`fallbacks: "default"`), so a declined reading is retried on Anthropic's recommended fallback model.
- **Setting it up:** set `ANTHROPIC_API_KEY` on the CRM (practice calls) and on the calling service (live calls), then switch the AI on in the playbook. `BOT_AI_MODEL` picks another model (a smaller one answers faster) and `BOT_AI_TIMEOUT_MS` the time limit. Check with the bank's compliance team before switching it on: customer answers and file values are sent to Anthropic.

**Listening to bot calls.** Every bot call is recorded (the bot opens with the taught **recording notice**, "This call is recorded for verification and quality purposes."). **Governance, business heads and the verification team leader** can listen to the call from the **Bot call** card on the file or the **Bot calls** page, with a player in the page. The audio is played through the CRM: it fetches the recording from the calling service with a signed request, and the calling service fetches it from Twilio, so nobody needs Twilio access and no recording link leaves the CRM. Each listen is written to the **access log** ("Listened to a bot call recording"). Others see that a recording exists. Recordings stay in the bank's Twilio account; set its retention there. To hear how the bot sounds before any call, tick **Hear the bot** in a practice call: the browser reads the bot's lines aloud (in the browser's voice, not the phone voice).

**On the file.** The **Bot call** card shows the request, its reason and both approvals, then the call. Asking for a bot call does not pick the file up, so processors keep working it. Only one bot call per file runs at a time. A call with no result after 30 minutes no longer blocks a new one, and a late result for it is refused. The **Bot call** card shows each detail as *Confirmed*, *Did not match* or *Not answered*, the summary, the transcript and the recording. The call counts as a call attempt and appears in the activity history. The processor on the file is told the result, or else the verification team leader who asked for the call. Only the result of each check is saved with the file, not the value the customer gave; what was said is in the transcript. Sales staff don't see bot calls. The dashboard's processor table counts the bot's verifications under *Verification Bot*. The bot's account cannot sign in and is not listed on the Staff page.

#### Running the calling service

The calling service is in `bot/server.js`. It places calls through **Twilio** (text to speech and speech recognition) and runs the playbook the CRM sends with each call.

```bash
# On a server Twilio can reach over HTTPS:
TWILIO_ACCOUNT_SID=AC… TWILIO_AUTH_TOKEN=… TWILIO_FROM=+9714… \
BOT_PUBLIC_URL=https://bot.example.com CALL_BOT_SECRET=<shared secret> npm run bot   # port 4000

# The CRM:
CALL_BOT_URL=https://bot.example.com/calls CALL_BOT_SECRET=<same secret> PUBLIC_URL=https://crm.example.com npm start
```

| Bot variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | The Twilio account that places the calls |
| `TWILIO_FROM` | The caller number, a Twilio number in international format |
| `BOT_PUBLIC_URL` | The bot's own HTTPS address, which Twilio sends call events to |
| `CALL_BOT_SECRET` | The same secret as the CRM's, to sign requests and results |
| `BOT_RECORD` | Calls are recorded by default; `0` turns recording off (then clear the recording notice in the playbook). The result waits up to two minutes for the recording |
| `BOT_COUNTRY_CODE` | Country code for numbers written locally (default `971`, so `050 123 4567` is dialled as `+971501234567`) |
| `BOT_PORT` | Port (default `4000`) |
| `ANTHROPIC_API_KEY` | For the AI on live calls, when the playbook switches it on (`BOT_AI_MODEL`, `BOT_AI_TIMEOUT_MS` optional) |

- Twilio's webhooks are checked against Twilio's signature, and requests from the CRM against `CALL_BOT_SECRET`.
- Without the Twilio settings the service refuses calls with a clear reason, which shows on the file.
- `GET /health` reports whether telephony is set up and how many calls are in progress.
- `GET /recordings/:sid` hands a recording to the CRM only with a signature over `GET <path>\n<timestamp>` made with `CALL_BOT_SECRET` and a timestamp less than five minutes old, so `CALL_BOT_SECRET` is required to listen to calls.
- Calls in progress are kept in memory: restarting the service drops them, and the CRM stops waiting after 30 minutes.
- Before going live, check with the bank's compliance team: automated calls to customers, the caller number, call recording, and the customer details sent to Twilio for the call (name, number, and the values the bot compares answers with) all need approval. Practise with your own number as the customer first.

#### Running the calling service on your own SIP line (nothing leaves your server)

`bot/sip-server.js` is a second calling service that does the same job as the Twilio one without any telephony or speech provider: it dials over **your SIP trunk** from the server it runs on, and the bot's voice and the recognition of what the customer says are **programs installed on that server**. No one outside hears or stores the call, and recordings are WAV files in a folder on the server. The CRM does not know the difference: point `CALL_BOT_URL` at it and everything on the file (requests, approvals, results, transcripts, the recording player, the playbook) works as described above.

```bash
# On the server with the SIP line (reachable by the CRM; no public address needed):
SIP_SERVER=sip.yourprovider.ae SIP_USERNAME=97140000000 SIP_PASSWORD=… \
STT_MODEL=/opt/speech/ggml-small.bin TTS_MODEL=/opt/speech/en_GB-alba-medium.onnx \
CALL_BOT_SECRET=<shared secret> npm run bot:sip         # port 4000

# Before the first call: engines, registration, then a test call to your own phone
node bot/sip-check.js --call 0501234567

# The CRM:
CALL_BOT_URL=http://bot-host:4000/calls CALL_BOT_SECRET=<same secret> PUBLIC_URL=https://crm.example.com npm start
```

**The speech programs.** Any program that turns a WAV file into text, and any that turns text into a WAV file, will do; the defaults are two well-known open-source ones that run on a CPU:

| Engine | What to install | Setting |
|---|---|---|
| Recognition: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Build it (`cmake -B build && cmake --build build`), put `whisper-cli` on the `PATH`, download a model (`ggml-small.bin` is a good start; `ggml-medium.bin` hears better and needs more CPU) | `STT_MODEL=/opt/speech/ggml-small.bin` |
| Voice: [Piper](https://github.com/rhasspy/piper) | Download the release binary, put `piper` on the `PATH`, download a voice (`en_GB-alba-medium`, `en_US-lessac-medium`, `ar_JO-kareem-medium`…), both the `.onnx` and its `.onnx.json` | `TTS_MODEL=/opt/speech/en_GB-alba-medium.onnx` |

Both models are single files; keep them on the server with the service. A voice per language: `TTS_MODEL_AR=/opt/speech/ar_JO-kareem-medium.onnx` is used when the playbook's language is Arabic (`STT_MODEL_AR` likewise; whisper's models are multilingual, so one is enough). To use other programs, give the whole command: `STT_COMMAND='my-recogniser --wav {file} --lang {lang}'` must print the text; `TTS_COMMAND='my-voice --out {file}'` is given the line on standard input (or use `{text}`) and must write a 16-bit WAV. Placeholders: `{file}`, `{lang}` (two letters), `{model}`, `{voice}` (the playbook's voice), `{hints}` (the words the answer may contain, passed to whisper as its prompt), `{text}`. Lines are synthesised once and reused, so the voice only works hard on the first call.

| Variable | Purpose |
|---|---|
| `SIP_SERVER` | The provider's SIP server, `host` or `host:port` (UDP; port 5060 by default). Registrar and outbound proxy: every request goes there |
| `SIP_USERNAME`, `SIP_PASSWORD` | The trunk's credentials (digest authentication). For a trunk that authenticates by IP address, leave the password empty and set `SIP_REGISTER=0` |
| `SIP_DOMAIN` | The SIP domain for the addresses, when it differs from the server host |
| `SIP_CALLER_ID` | The number the customer sees (default: the username). Sent in `From` and `P-Asserted-Identity` (`SIP_ASSERT_IDENTITY=0` leaves the latter out) |
| `SIP_DISPLAY_NAME` | Name shown with the number, e.g. `Verification team` |
| `SIP_REGISTER`, `SIP_EXPIRES` | Register with the provider before calling (default on, 300 s, refreshed) |
| `SIP_LOCAL_IP`, `SIP_LOCAL_PORT` | The address the provider reaches this server at (default: the interface towards the server, port 5060). Behind NAT set `SIP_LOCAL_IP` and `SIP_MEDIA_IP` to the public address and forward the ports |
| `RTP_PORT_RANGE` | UDP ports for the audio (default `10000-20000`); open them on the firewall towards the provider |
| `BOT_RING_TIMEOUT_MS` | How long the phone rings before the call counts as not answered (default 45 s) |
| `BOT_NO_SPEECH_MS`, `BOT_SILENCE_MS`, `BOT_MAX_ANSWER_MS` | Silence after a question before the bot re-asks (6 s); the pause that ends an answer (0.8 s); the longest answer (15 s) |
| `BOT_BARGE_IN` | `1` lets the customer cut a line short by speaking over it (off by default: on a noisy line the bot would hear itself) |
| `BOT_MACHINE_DETECTION` | Hang up when a voicemail greeting answers: speech longer than 3.5 s right after pick-up (default on; `0` to turn off) |
| `BOT_MAX_CALLS` | Calls at the same time (default 4; each runs a recognition after every answer, so size it to the CPU) |
| `BOT_RECORD`, `BOT_RECORDINGS_DIR`, `BOT_RECORDING_DAYS` | Recordings (default on) are WAV files in `data/recordings` (8 kHz mono, about 1 MB a minute); set a retention in days, or keep them until deleted |
| `BOT_PUBLIC_URL` | The address the CRM reaches this service at, used only in the recording links (default: this host and port) |
| `CALL_BOT_SECRET`, `BOT_COUNTRY_CODE`, `BOT_PORT` | As for the Twilio service |
| `ANTHROPIC_API_KEY` | **Leave unset to keep the call on your server.** With it set and the AI switched on in the playbook, what the customer says is sent to Anthropic to be read, as described above |

- The conversation, matching rules, re-asks, what the bot may decide and the results are exactly the Twilio service's: both run `src/bot-engine.js`. Speech recognition has no "hints" on this path; instead the expected words are given to whisper as its prompt, which has a similar effect.
- `GET /health` reports whether the line is registered and the engines set up. Calls are placed only while the line is registered.
- A voicemail is recognised by its greeting (long, uninterrupted speech right after pick-up); a person saying a quick "hello?" is not. If customers' long greetings get hung up on, turn the detection off or raise it in `bot/sip/call.js`.
- Audio is G.711 (µ-law or A-law, whichever the provider picks), 20 ms packets, with symmetric RTP so trunks behind NAT work. There is no codec negotiation beyond that; a provider that offers only G.729 or Opus will have the call refused with that reason on the file.
- What the SIP agent does not do: receive calls (an incoming INVITE is refused), TLS/SRTP, TCP transport, or SIP over IPv6. These can be added if the provider needs them.
- Before going live, check with the bank's compliance team as for any automated call: the caller number, the recording notice and where the recordings are kept. On this path no customer detail leaves the server.

#### Using another calling service

Any voice-bot or IVR provider can stand in for `bot/server.js` if it speaks the same protocol. The CRM sends a `POST` to `CALL_BOT_URL`:

```json
{ "event": "verification_call.request", "call_id": 7, "case_id": 12, "ref": "CRM-000012",
  "callback_url": "https://crm.example.com/api/bot/calls/3f9c…",
  "customer": { "name": "Asha Rao", "phone": "0501234567", "alt_phone": null },
  "checks": [ { "key": "full_name", "label": "Full name", "question": "Please confirm your full name.", "match": "name", "strictness": "normal", "expected": "Asha Rao" },
              { "key": "product", "label": "Product applied for", "question": "Which product did you apply for?", "match": "text", "strictness": "relaxed", "expected": ["Personal Loan", "Personal Loan (Fresh)"] } ],
  "values": { "bank": "Emirates NBD", "first_name": "Asha", "product": "Personal Loan", "…": "…" },
  "playbook": { "greeting": "…", "intro": "…", "closing": "…", "yes_words": ["yes", "…"], "…": "…" },
  "check_results": ["confirmed", "mismatch", "not_answered"],
  "call_outcomes": ["connected", "no_answer", "busy", "switched_off", "wrong_number", "call_back_later"] }
```

`expected` is the value on file, or a list of accepted answers. `src/bot-engine.js` holds the conversation and matching rules and has no other imports, so another service can reuse it. Any `2xx` answer means the call was accepted; an error answer with `{"error": "…"}` shows that reason on the file. The service then posts to `callback_url`, once with `{"status": "in_progress"}` when the customer picks up (optional), and once with the result:

```json
{ "status": "completed", "outcome": "connected",
  "checks": [ { "key": "full_name", "result": "confirmed" }, { "key": "product", "result": "mismatch" } ],
  "summary": "Confirmed: Full name. Did not match: Product applied for.",
  "transcript": "Bot: …\nCustomer: …", "recording_url": "https://…" }
```

or `{"status": "failed", "error": "number not in service"}`. Checks left out count as not answered. A check settled by an AI rather than fixed rules carries `"by": "ai"`, so the playbook's rule on AI-confirmed details applies.

**Security.**
- The callback URL holds a random one-time token for that call. A result is accepted once.
- Set `CALL_BOT_SECRET` to sign both directions. Each request carries `x-crm-signature: sha256=<hex>`, an HMAC-SHA256 of the raw body with the secret. The CRM signs its requests to the bot and refuses results without a valid signature.
- The request contains the customer's details so the bot can compare answers. Only point `CALL_BOT_URL` at a service your bank has approved to handle them.
- Set `PUBLIC_URL` to the address the bot can reach the CRM at (for example `https://crm.example.com`). Without it, the callback URL uses the address the approver opened the CRM with (or, for calls held for calling hours, the address someone last opened it with).

### Team-leader webhook

Set `TL_WEBHOOK_URL` to POST a JSON alert every time a case is marked incomplete. The payload includes a `text` field, so a Slack or Microsoft Teams incoming webhook works as-is:

```json
{ "text": "⚠️ CRM-000012 (Asha Rao) marked INCOMPLETE by Pam — incorrect details: …",
  "event": "case.incomplete", "case_id": 12, "ref": "CRM-000012", "customer_name": "Asha Rao",
  "reason": "incorrect_details", "note": "…", "marked_by": "Pam", "at": "2026-10-06T08:00:00.000Z" }
```

## Deploying to a server

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md): Docker (`deploy/Dockerfile`, `deploy/docker-compose.yml`) or systemd (`deploy/sourcing-crm.service`), an nginx HTTPS example, an environment file template and a nightly backup script.

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
| `CALL_BOT_URL` | – | The calling bot service (`npm run bot`, at `…/calls`); turns on bot calls |
| `ANTHROPIC_API_KEY` | – | Lets the verification bot's AI read answers in practice calls (`BOT_AI_MODEL`, `BOT_AI_TIMEOUT_MS` optional) |
| `CALL_BOT_SECRET` | – | Shared secret for signing bot requests and results (recommended) |
| `PUBLIC_URL` | – | The CRM's address as the bot reaches it, for callback URLs |
| `COOKIE_SECURE` | – | Set to `1` when serving over HTTPS |

## Project layout

```
src/
  index.js     entry point (first-run admin, starts server)
  server.js    HTTP routing, auth cookies, JSON API, static files, webhook dispatch
  cases.js     case workflow / state machine, notifications, stats
  bot.js       verification calls through the calling bot: playbook, practice, requests, signed results, the bot's decisions and own calls
  bot-engine.js  the bot's conversation and answer matching (shared with bot/server.js)
  bot-ai.js    the bot's AI: Claude reads answers the rules cannot settle and, when allowed, words what the bot says
  chat.js      case discussions, direct messages, groups, mentions
  imports.js   bulk upload of users, cases, card activation and targets (CSV parsing, row checks, column guide)
  cycles.js    sales cycles (21st to 20th, UAE time)
  performance.js  targets, achievement per cycle and card activation counts
  users.js     user profiles, contact details and phone number rules
  credit-cards.js  the credit card list shown when Credit Card is selected
  auth.js      users, scrypt password hashing, sessions
  db.js        SQLite schema
public/        single-page UI (vanilla JS, no build step); speech.js handles dictation and read-back
scripts/       demo seed data
bot/server.js  the calling bot service (Twilio): `npm run bot`
bot/sip-server.js  the native calling bot service (your SIP line, speech on the server): `npm run bot:sip`; `bot/sip/` its SIP, RTP, audio and speech pieces; `bot/sip-check.js` the go-live check
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
| `POST /cases/:id/actions` with `bot_call` | Asks for a bot call, with a `note` giving the reason (verification team leader) |
| `POST /bot/calls/:token` | Result from the calling bot (no session; one-time token, plus signature when `CALL_BOT_SECRET` is set) |
| `POST /cases/:id/actions` with `approve_bot_call` / `decline_bot_call` (note) / `withdraw_bot_call` | Governance and business heads approve or decline a requested bot call; the verification team leader withdraws one |
| `GET /bot/calls/:id/recording` | The bot call's audio, streamed through the CRM (governance, business heads, verification team leader); logged in the access log |
| `GET /bot/requests` | Bot calls waiting for approval and the last 30 days (governance, business heads, verification team leader) |
| `GET/PUT /bot/playbook`, `POST /bot/practice` | Teach the bot and practise with it (`{playbook, sample, answers}`); business heads and the verification team leader |
| `GET /stats` | Dashboard counts |
| `GET /notifications`, `POST /notifications/read` | In-app alerts |
| `GET/POST /users`, `PATCH /users/:id` | User management (team leader only). Users have `mobile_number` (required on create) and `whatsapp_number` |
| `GET /targets?cycle=2026-06`, `PUT /targets` | Targets and achievement for a cycle (default: current). `PUT {cycle, targets: [{user_id, credit_card, personal_loan, auto_loan, accounts}]}`, MIS and business head only |
| `GET /cases?cycle=2026-06&staff=:id&card=active\|inactive\|out_of_range\|all` | Cases completed in a cycle, for one sales person, or by card activation |
| `POST /cases/:id/actions` with `set_case_status` / `set_disbursal` | Completing a loan takes `pl_disbursed_amount` / `al_disbursed_amount` (AED; defaults to the file's amount). `set_disbursal` corrects them on a completed case |
| `POST /cases/:id/actions` with `set_card_status` | `{card_status: 'active'\|'inactive'\|'', activation_date?}` (the status date; defaults to today) on a completed card case (MIS and business head) |
| `POST /import/users`, `/import/cases`, `/import/cards`, `/import/targets` | Bulk upload (MIS and business head only): `{csv, dry_run}`. Returns `{total, ok, failed, rows: [{line, ok, error?, ref?, temp_password?}]}`; `dry_run: true` checks without saving |
