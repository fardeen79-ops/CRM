# Deploying STRIDE (the Sourcing CRM) to a test server

The full guide for IT, with the architecture, every setting, the calling bot on the company's SIP
line, the acceptance checklist and troubleshooting, is `deploy/STRIDE-IT-Deployment-Guide.pdf`
(source: `tools/deploy-guide/guide.html`, rendered with `node tools/deploy-guide/render.cjs`).
This file is the short version.

The CRM is a single Node.js 22 service with a SQLite database file and one package dependency.
Put it behind the bank's HTTPS gateway (or nginx) and it is ready for a pilot.

## 1. Before you start

- A Linux server or container inside the bank's network with **Node.js 22.13 or newer** (or Docker).
- A **DNS name and TLS certificate** for it, e.g. `crm-test.yourbank.ae`. HTTPS is required: the sign-in
  cookie is marked Secure, and browsers only allow the camera (lead-sheet scanner) and microphone
  (voice typing) over HTTPS.
- Decide who the **first business head** is (`ADMIN_EMAIL` / `ADMIN_PASSWORD`). They (or an MIS user they add) add everyone else.
- If real customer data will be entered, compliance should know it is on this server.

## 2. Getting the code onto the server

The repository is on a personal GitHub account, which the bank server will usually not be allowed to
reach. Transfer the code once as a file, then let the server work from a local copy. Pick one option
and replace the `git clone` / `git checkout` lines in 3a or 3b with the "on the server" commands here.

### Option 1: Source archive (both routes, simplest)

On the personal machine, with Node.js 22 installed:

```bash
git clone https://github.com/fardeen79-ops/crm.git sourcing-crm
cd sourcing-crm
git checkout claude/sales-sourcing-crm-workflow-rdlw4h
npm ci --omit=dev                      # packages (needs internet, so do it here; they go in the archive)
npm run setup:ocr                      # lead-sheet scanner files (needs internet, so do it here)
tar czf ../sourcing-crm.tar.gz --exclude=.git --exclude=data --exclude='*.db' --exclude=.env .
sha256sum ../sourcing-crm.tar.gz       # note the checksum
```

Move `sourcing-crm.tar.gz` (about 25 MB) to the server by the bank's approved method (file transfer
portal, SFTP from the admin network, encrypted USB). On the server:

```bash
sha256sum /path/to/sourcing-crm.tar.gz   # must match
sudo mkdir -p /opt/sourcing-crm
sudo tar xzf /path/to/sourcing-crm.tar.gz -C /opt/sourcing-crm
```

Skip `npm ci` and `npm run setup:ocr` on the server; the package and the files are in the archive. Updates arrive as a new
archive: stop the service, extract over `/opt/sourcing-crm`, start the service. The database is in
`/var/lib/sourcing-crm`, so it is untouched.

### Option 2: Mirror into the bank's internal Git (best for ongoing updates)

Create an empty project on the bank's GitLab, Bitbucket or Azure DevOps, then on the personal machine:

```bash
git clone --mirror https://github.com/fardeen79-ops/crm.git
cd crm.git
git push --mirror https://git.yourbank.ae/sales/sourcing-crm.git
```

The server then follows 3a or 3b with the internal URL. Future updates are `git push` from the
personal machine and `git pull` on the server. The scanner files still need internet once, so run
`npm run setup:ocr` on the personal machine and commit `public/vendor/tesseract` to the internal
repository (it is git-ignored here; use `git add -f`), or transfer that folder with Option 1.

### Option 3: Docker image file (Docker route only)

```bash
# personal machine
git clone https://github.com/fardeen79-ops/crm.git sourcing-crm && cd sourcing-crm
git checkout claude/sales-sourcing-crm-workflow-rdlw4h
docker build -f deploy/Dockerfile -t sourcing-crm:1.0 .
docker save sourcing-crm:1.0 | gzip > sourcing-crm-1.0.tar.gz   # about 70 MB
```

Transfer the image file plus `deploy/docker-compose.yml` and `deploy/.env.example`. On the server:

```bash
docker load < sourcing-crm-1.0.tar.gz
mkdir -p /opt/sourcing-crm/deploy && cp docker-compose.yml .env.example /opt/sourcing-crm/deploy/
```

In the copied `docker-compose.yml`, replace the `build:` block with `image: sourcing-crm:1.0`, then
run the compose command from 3a without `--build`. Each update is a new image file with a new tag.

Whichever option is used, the transferred file contains code only, no customer data. Keep the
checksum with the change record.

## 3a. With Docker (simplest)

```bash
git clone <repo> sourcing-crm && cd sourcing-crm
git checkout claude/sales-sourcing-crm-workflow-rdlw4h
cp deploy/.env.example deploy/.env       # fill it in
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The app listens on `127.0.0.1:3000`; point the reverse proxy at it (see `deploy/nginx.conf`).
The database is in the `crm-data` volume.

## 3b. Without Docker (systemd)

```bash
sudo useradd -r -s /usr/sbin/nologin crm
sudo mkdir -p /opt/sourcing-crm /var/lib/sourcing-crm
sudo git clone <repo> /opt/sourcing-crm && cd /opt/sourcing-crm
sudo git checkout claude/sales-sourcing-crm-workflow-rdlw4h
sudo npm ci --omit=dev                   # Anthropic's SDK, for the verification bot's AI
sudo npm run setup:ocr                   # scanner files served from this server
sudo cp deploy/.env.example /etc/sourcing-crm.env && sudo nano /etc/sourcing-crm.env
sudo chown -R crm:crm /opt/sourcing-crm /var/lib/sourcing-crm
sudo chmod 600 /etc/sourcing-crm.env
sudo cp deploy/sourcing-crm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sourcing-crm
sudo journalctl -u sourcing-crm -f       # watch it start
```

## 4. HTTPS in front

Use the bank's gateway, or install nginx and adapt `deploy/nginx.conf` (server name, certificate
paths). Allow uploads of 8 MB. Then open `https://crm-test.yourbank.ae`.

## 5. First sign-in and setup

1. Sign in as the first business head (`ADMIN_EMAIL`). Change the password on the Staff page.
2. Add an **MIS** user. Bulk upload and target setting are for MIS and business heads.
3. As MIS: **Bulk upload → Users** (rows in any order; leaders are added before the staff who name them), then
   **Bulk upload → Salary targets** with `docs/go-live/salary-targets.csv` (the salary bands), then on the
   **Targets** page press **Generate from salaries** for the current cycle. That gives every sales person
   the target of their core product from their salary, and team leaders, ASMs and sales managers see
   their teams' targets added up. This is exactly what the demo does. Hand-set targets go through
   **Bulk upload → Targets** or **Set targets** instead. Share the downloaded sign-in details securely.
4. Each role signs in and checks their dashboard.

**Test environment shortcut: the demo users.** To try every role on the server without uploading
real staff, load the same sample accounts the demo uses into the live database:

```bash
# systemd route (uses the same DB_FILE as the service, e.g. /var/lib/sourcing-crm/crm.db)
cd /opt/sourcing-crm
sudo -u crm env $(sudo cat /etc/sourcing-crm.env | grep -v '^#' | xargs) npm run seed:demo

# Docker route
docker compose exec crm npm run seed:demo
```

It adds ten `@demo.local` accounts (team leader, sales manager, two sales staff, processing,
verification lead, CEO, accounts, governance, business head), all with password `password123`,
plus four sample files. Existing users and files are untouched and the script is safe to re-run.
Delete or disable the demo accounts on the Staff page before real staff are loaded.

## 6. Backups and updates

**Two branches.** Development happens on `claude/sales-sourcing-crm-workflow-rdlw4h`. The server follows
`production`, which only moves when the business owner says a change is ready: then the development
branch is fast-forwarded into `production` and pushed, and the server picks it up with the update
script (by hand, or with the nightly timer below). Nothing reaches the server by being merely developed.

**Updates come from git.** Once `/opt/sourcing-crm` is a git checkout (it is if it was cloned in step 3b;
if it was extracted from an archive, run `sudo bash /opt/sourcing-crm/deploy/switch-to-git.sh` once,
with git installed and a GitHub token for the private repository), every update is:

```bash
sudo bash /opt/sourcing-crm/deploy/update.sh
```

It pulls the branch, refreshes packages only if `package.json` changed, restarts the service and prints
its status. The database and the environment file are never touched. Changes are developed and tested
in Claude Code first and pushed to the branch; the server only ever pulls.

To pull unattended every night instead, install the timer (`deploy/sourcing-crm-update.timer`, 03:10
Gulf time; it restarts the service only when something new was pulled):

```bash
sudo cp /opt/sourcing-crm/deploy/sourcing-crm-update.service /opt/sourcing-crm/deploy/sourcing-crm-update.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sourcing-crm-update.timer
```

- `deploy/backup.sh` makes a consistent copy of the database; run it nightly from cron and keep the
  copies off the server. Restore = stop the service, replace the file, start the service.
- Docker route: `git pull`, then `docker compose up -d --build`. Database changes apply themselves on start.
- Logs: `journalctl -u sourcing-crm` or `docker compose logs crm`.

## 7. The calling bot on the company's SIP line (optional)

`bot/sip-server.js` phones customers to confirm the details on a file, over the company's own SIP
line, with the voice and the recognition as programs on this server and recordings in a folder here;
nothing leaves the server. Install whisper.cpp (`whisper-cli`) and Piper with one model each under
`/opt/speech`, then:

```bash
sudo mkdir -p /var/lib/sourcing-crm/recordings && sudo chown crm:crm /var/lib/sourcing-crm/recordings
sudo cp deploy/.env.example /etc/sourcing-crm-bot.env && sudo nano /etc/sourcing-crm-bot.env   # SIP_*, STT_MODEL, TTS_MODEL, CALL_BOT_SECRET
sudo chmod 600 /etc/sourcing-crm-bot.env
sudo cp deploy/sourcing-crm-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sourcing-crm-bot
node bot/sip-check.js --call 0501234567    # engines, registration, one test call to your own phone
```

Set `CALL_BOT_URL=http://127.0.0.1:4000/calls` and the same `CALL_BOT_SECRET` in the CRM's file and
restart it. Firewall: outbound UDP 5060 and 10000-20000 to the SIP provider only. Leave
`ANTHROPIC_API_KEY` blank to keep every call on the server. Compliance signs off the caller number
and the recording notice before the first live call. The README has every setting.

## 8. Optional integrations

| Setting | Turns on |
|---|---|
| `IT_EMAIL`, `IT_EMAIL_WEBHOOK_URL` | Emailing IT for approved call recording requests |
| `TL_WEBHOOK_URL` | Teams/Slack alert when a case is marked verification pending |
| `PROCESSING_WEBHOOK_URL` | Teams/Slack alert when a scheduled call-back is due |
| `CALL_BOT_URL`, `CALL_BOT_SECRET`, `PUBLIC_URL` | Bot calls, through the calling service: `npm run bot` (Twilio) or `npm run bot:sip` (your own SIP line, speech on the server, nothing leaves it; see the README). The **Verification bot** teaching page works without it |
| `ANTHROPIC_API_KEY` | The verification bot's AI in practice calls (set it on the calling service too, for live calls) |
| `RECORDING_SOURCE`, `RECORDING_DIR` or `RECORDING_API_URL`, `RECORDING_API_TOKEN`, `RECORDING_API_MAP` | Calls to this customer on every file: the recording server's calls for the customer's numbers, played through the CRM. `folder` points at the PBX's recordings share mounted on the server (read-only is enough); `http` at the PBX's recording API. The README has the field map |

## 9. What to test first on the server

1. Photograph a lead sheet on My leads from a phone, then convert the lead into a file.
2. One file through the whole flow: sales → processor verifies → team leader actions.
3. A "call back later" set two minutes ahead, and the alert that follows.
4. Reveal a number, then check the Access log as governance; screenshot a page to see the watermark.
5. Voice typing and "Read it back to check" with a real microphone.
6. Bulk uploads with your own spreadsheets, from the templates.
7. With the calling bot: a bot call on a test file, approved by governance and the business head.

## 10. Before go-live (not needed for the test environment)

Single sign-on with the bank's directory, login lockout and password policy, a shorter session
timeout, a penetration test, log forwarding, a retention policy, and compliance sign-off on bot calls.
Emirates ID and passport numbers are no longer stored, so no field-level encryption is needed.
