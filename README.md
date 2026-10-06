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
| **Processing** | See the verification queue, **pick up** a case (locks it to them), **log calls** with an outcome, mark **Completed**, or mark **Incomplete** (a reason and a note are required) |
| **Team leader** | **Action required** queue of incomplete cases: **Return to sales** (note required), **Re-verify**, or **Reject** (note required). Also sees team stats, manages users, and can edit any open case |

### Products

Each case records one product: **Personal Loan**, **Credit Card**, **Auto Loan**, **Accounts**, or a **Bundle**. Choosing Bundle shows checkboxes for the products in it, and a bundle needs at least two. The API takes `product` as one of `personal_loan`, `credit_card`, `auto_loan`, `accounts` or `bundle`. For a bundle it also takes `bundle_products`, as an array such as `["credit_card", "accounts"]` or a comma-separated string. Cases created before this change keep their original free-text product until someone edits them.

Every step is recorded in the case's activity timeline. People are notified in-app (the 🔔 icon) when something needs them:

- team leaders when a case is marked incomplete
- sales when their case is verified, returned or rejected
- the processor when a case they handled is sent back or rejected

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
| `COOKIE_SECURE` | – | Set to `1` when serving over HTTPS |

## Project layout

```
src/
  index.js     entry point (first-run admin, starts server)
  server.js    HTTP routing, auth cookies, JSON API, static files, webhook dispatch
  cases.js     case workflow / state machine, notifications, stats
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
| `GET /cases?status=a,b&q=…&assigned=me` | List cases (sales only see their own) |
| `POST /cases`, `GET /cases/:id`, `PUT /cases/:id` | Create, read, edit |
| `POST /cases/:id/actions` | `{action, note?, outcome?, reason?}`, where action is one of `claim`, `release`, `log_call`, `complete`, `mark_incomplete`, `return_to_sales`, `reverify`, `reject`, `resubmit` |
| `GET /stats` | Dashboard counts |
| `GET /notifications`, `POST /notifications/read` | In-app alerts |
| `GET/POST /users`, `PATCH /users/:id` | User management (team leader only) |
