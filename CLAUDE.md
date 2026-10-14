# STRIDE sourcing CRM: notes for an agent working on this code

Sales-sourcing CRM for Derby Group's Emirates NBD business. Zero-dependency Node 22 (`node:sqlite`),
ESM, vanilla-JS single-page app. Development happens on the branch
`claude/sales-sourcing-crm-workflow-rdlw4h`. The server follows the `production` branch
(`deploy/update.sh`), which is fast-forwarded from the development branch only when the user says a
change is ready for the server. README.md is the functional spec and is kept in step with every change.

## Layout
- `src/server.js` routes (`['GET', /^\/api\/x$/, async ({ user, params, query, body }) => …]`); `src/cases.js`
  workflow and statuses; `src/incentives.js`, `src/payouts.js`, `src/pnl.js`, `src/reports.js`,
  `src/dashboard.js`, `src/ceo.js`; `src/users.js`/`src/auth.js`/`src/roles.js` people and access;
  `src/imports.js` bulk uploads; `src/recordings.js` call recordings; `src/db.js` schema and migrations.
- `public/app.js` the whole client (`html` tagged templates, `state`, `api()`, `go()`), `public/styles.css`.
- `test/*.test.js` with `test/setup.mjs` (clock pinned to 2026-10-05). `scripts/seed-demo.js` demo users.
- `docs/go-live/` real staff and salary-band upload files; `deploy/` server files and the IT guide PDF
  built from `tools/deploy-guide/guide.html` (`node render.cjs` there, then move the PDF into `deploy/`).
- `tools/demo/build-demo.mjs` builds the single-file browser demo (routes live inside a template literal:
  no backticks in that code).

## Rules that must hold
- Sales cycles run from the 21st to the 20th, named after the month they end in. Saturday is a working day.
- Every sales submission waits with the team leader (`awaiting_approval`) until validated; then verification.
- Business head salaries are seen only by the CEO profile, Accounts and that business head.
- Customer phone numbers never appear in any downloaded file (`NO_DOWNLOAD_KEYS` in reports).
- Cards are paid by the bank on activation within 90 days; incentives follow the structures in README.md
  (Emirates Islamic buy-outs count at 50%, top-ups 70% of the increment from Oct 2026).
- Non-sales salaries are not split across regions in the P&L.
- Never write to `/var/lib/sourcing-crm` or `/etc/sourcing-crm.env` from code or scripts; the database
  migrates itself on start.

## Removed on request: do not rebuild unless the user explicitly asks
- Camera scanning on the case form (Scan application form, Scan Emirates ID): built in f862176, 3772132 and
  594e598, reverted in the commit after. It must never reach the server unless the user says to rebuild it.

## Working
- Run tests per file: `node --disable-warning=ExperimentalWarning --import ./test/setup.mjs --test test/<f>.test.js`
  (the whole suite takes several minutes). One pre-existing date-sensitive failure in `test/leads.test.js`.
- A feature is done when the server, the client, README.md and a test cover it, and the commit is pushed.
- Commit messages describe the business change, never the model or tooling.
