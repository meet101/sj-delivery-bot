# SJ Delivery Bot

Automatically reads delivery order PDFs posted in a WhatsApp group and populates a Google Sheet — one summary row per delivery and one detailed row per line item.

## How it works

```
PDF posted in WhatsApp group
        ↓
Bot running on Google Cloud VM detects it (via Baileys — no browser needed)
        ↓
Claude AI extracts all line items
        ↓
Google Sheet updated:
  • "Summary" tab    — one row per delivery with totals
  • "All Deliveries" — one row per line item across all orders
```

## Project structure

```
sj-delivery-bot/
├── .github/workflows/
│   └── deploy.yml        # Auto-deploys to VM on every push to main
├── index.js              # WhatsApp bot (runs 24/7 on the VM)
├── import.js             # One-time local importer for historical PDFs
├── migrate.js            # Migrates old per-tab data to new structure
├── format.js             # Applies formatting and filters to Google Sheet
├── package.json
├── vm-setup.sh           # One-time VM setup script
└── .env.example          # Environment variable template
```

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- A Google Cloud VM (e2-micro, us-central1 — free tier)
- [Anthropic API key](https://console.anthropic.com) (Claude Haiku — ~$0.005/PDF)
- A Google Cloud service account with Sheets API enabled
- A Google Sheet shared with the service account

## Environment variables

Copy `.env.example` to `.env` and fill in:

```
WHATSAPP_GROUP_NAME=Your WhatsApp Group Name
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_SPREADSHEET_ID=your-sheet-id
TIMEZONE=America/Los_Angeles
```

## First-time VM setup

Upload `vm-setup.sh` to your Google Cloud VM via the browser SSH terminal, then:

```bash
bash vm-setup.sh
```

This installs Node.js, adds swap memory, PM2, clones the repo, and walks you through entering credentials. At the end it prints the 3 GitHub Secrets needed for auto-deployment.

## GitHub Secrets required

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `VM_HOST` | VM external IP |
| `VM_USER` | VM username (e.g. `meet_vadaria`) |
| `VM_SSH_KEY` | Private SSH key (generate with `ssh-keygen -t ed25519 -C "meet_vadaria"`) |

Once added, every push to `main` automatically deploys to the VM in ~20 seconds.

## WhatsApp connection (Baileys)

The bot uses [Baileys](https://github.com/WhiskeySockets/Baileys) to connect to WhatsApp — a lightweight WebSocket library with no browser dependency. It uses ~80MB RAM vs ~500MB for browser-based alternatives.

**First-time link:** When the bot starts for the first time, it prints a QR code in the terminal. Scan it with WhatsApp → Settings → Linked Devices → Link a Device. The session is saved in `wa_auth/` and persists across restarts.

**Session storage:** The WhatsApp session lives in `~/delivery-bot/wa_auth/` on the VM. This folder is excluded from git — never commit it.

**PDF filtering:** Only files named `Delivery_*.pdf` (capital D) posted in the configured group are processed. Everything else is silently ignored.

**Duplicate prevention:** Before writing to the sheet, the bot checks the Summary tab for a matching Order No + Seq. Duplicate PDFs are skipped automatically.

## Google Sheet output

| Tab | Contents |
|-----|----------|
| **Summary** | One row per delivery — date, order, totals, variance |
| **All Deliveries** | One row per line item — category, item name, code, ordered, delivered, variance |

Run `node format.js` to apply header colours, alternating row banding, conditional formatting on the variance column, and auto-filters.

## Importing historical PDFs

Place past delivery PDFs (named `Delivery_*.pdf`) in a `pdfs/` folder, then run locally:

```bash
node import.js
```

Progress is saved to `.processed.json` — safe to re-run if interrupted. Already-processed files are skipped automatically.

## Deployment

Push to `main` → GitHub Actions SSHes into the VM → pulls latest code → restarts PM2:

```bash
git add .
git commit -m "your change"
git push
```

## Monitoring (UptimeRobot)

The bot runs an HTTP health check on **port 3000**. When WhatsApp is connected it returns `200 ok`; when disconnected it returns `503 error`.

Set up free monitoring at [uptimerobot.com](https://uptimerobot.com):
1. Add New Monitor → HTTP(s) → URL: `http://YOUR_VM_IP:3000`
2. Interval: 5 minutes
3. Add your email as an alert contact

You'll receive an email within 5 minutes of any disconnection.

## Maintenance

**Check bot status:**
```bash
pm2 status
```

**View live logs:**
```bash
pm2 logs delivery-bot --lines 0
```

**View recent logs:**
```bash
pm2 logs delivery-bot --lines 50
```

**Restart the bot:**
```bash
pm2 restart delivery-bot
```

**Stop and start fresh:**
```bash
pm2 stop delivery-bot
pm2 delete delivery-bot
cd ~/delivery-bot
pm2 start index.js --name delivery-bot
pm2 save
```

**Re-scan WhatsApp QR** (if session expires):
```bash
pm2 stop delivery-bot
rm -rf ~/delivery-bot/wa_auth
pm2 start index.js --name delivery-bot
pm2 logs delivery-bot
```
Scan the QR code that appears, then press Ctrl+C — the bot keeps running.

**When will you need to re-scan?**
- If your primary phone is offline for 14+ days
- After a major WhatsApp update (rare)
- Roughly 2–3 times per year at most

Temporary disconnections (network blips, VM restarts) are handled automatically — the bot reconnects by itself without any QR scan.

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Test locally with `node import.js`
4. Open a pull request
