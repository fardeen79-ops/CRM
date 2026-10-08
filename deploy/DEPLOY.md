# Deploying the Sourcing CRM to a test server

The CRM is a single Node.js 22 service with a SQLite database file. It needs no other software.
Put it behind the bank's HTTPS gateway (or nginx) and it is ready for a pilot.

## 1. Before you start

- A Linux server or container inside the bank's network with **Node.js 22.13 or newer** (or Docker).
- A **DNS name and TLS certificate** for it, e.g. `crm-test.yourbank.ae`. HTTPS is required: the sign-in
  cookie is marked Secure, and browsers only allow the camera (Emirates ID scanner) and microphone
  (voice typing) over HTTPS.
- Decide who the **first team leader** is (`ADMIN_EMAIL` / `ADMIN_PASSWORD`). They add everyone else.
- If real customer data will be entered, compliance should know it is on this server.

## 2a. With Docker (simplest)

```bash
git clone <repo> sourcing-crm && cd sourcing-crm
git checkout claude/sales-sourcing-crm-workflow-rdlw4h
cp deploy/.env.example deploy/.env       # fill it in
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The app listens on `127.0.0.1:3000`; point the reverse proxy at it (see `deploy/nginx.conf`).
The database is in the `crm-data` volume.

## 2b. Without Docker (systemd)

```bash
sudo useradd -r -s /usr/sbin/nologin crm
sudo mkdir -p /opt/sourcing-crm /var/lib/sourcing-crm
sudo git clone <repo> /opt/sourcing-crm && cd /opt/sourcing-crm
sudo git checkout claude/sales-sourcing-crm-workflow-rdlw4h
sudo npm run setup:ocr                   # scanner files served from this server
sudo cp deploy/.env.example /etc/sourcing-crm.env && sudo nano /etc/sourcing-crm.env
sudo chown -R crm:crm /opt/sourcing-crm /var/lib/sourcing-crm
sudo chmod 600 /etc/sourcing-crm.env
sudo cp deploy/sourcing-crm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sourcing-crm
sudo journalctl -u sourcing-crm -f       # watch it start
```

## 3. HTTPS in front

Use the bank's gateway, or install nginx and adapt `deploy/nginx.conf` (server name, certificate
paths). Allow uploads of 8 MB. Then open `https://crm-test.yourbank.ae`.

## 4. First sign-in and setup

1. Sign in as the first team leader (`ADMIN_EMAIL`). Change the password on the Users page.
2. Add an **MIS** user. Bulk upload and target setting are for MIS and business heads.
3. As MIS: **Bulk upload → Users** (team leaders and sales managers first, then sales staff), then
   **Bulk upload → Targets** for the current cycle. Share the downloaded sign-in details securely.
4. Each role signs in and checks their dashboard.

## 5. Backups and updates

- `deploy/backup.sh` makes a consistent copy of the database; run it nightly from cron and keep the
  copies off the server. Restore = stop the service, replace the file, start the service.
- To update: `git pull`, then `systemctl restart sourcing-crm` (or `docker compose up -d --build`).
  Database changes apply themselves on start.
- Logs: `journalctl -u sourcing-crm` or `docker compose logs crm`.

## 6. Optional integrations

| Setting | Turns on |
|---|---|
| `IT_EMAIL`, `IT_EMAIL_WEBHOOK_URL` | Emailing IT for approved call recording requests |
| `TL_WEBHOOK_URL` | Teams/Slack alert when a case is marked verification pending |
| `PROCESSING_WEBHOOK_URL` | Teams/Slack alert when a scheduled call-back is due |
| `CALL_BOT_URL`, `CALL_BOT_SECRET`, `PUBLIC_URL` | The calling bot (on hold) |

## 7. What to test first on the server

1. Scan a real Emirates ID from a phone (front and back) on the New case form.
2. One file through the whole flow: sales → processor verifies → team leader actions.
3. A "call back later" set two minutes ahead, and the alert that follows.
4. Reveal a number, then check the Access log as governance; screenshot a page to see the watermark.
5. Voice typing and "Read it back to check" with a real microphone.
6. Bulk uploads with your own spreadsheets, from the templates.

## 8. Before go-live (not needed for the test environment)

Single sign-on with the bank's directory, login lockout and password policy, a shorter session
timeout, field-level encryption of Emirates ID and passport numbers, and a penetration test.
