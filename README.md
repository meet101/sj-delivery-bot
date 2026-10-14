# SJ Delivery Bot

Automatically reads delivery order PDFs posted in a WhatsApp group and populates a Google Sheet — one tab per delivery slip.

## How it works

```
PDF posted in WhatsApp group
        ↓
Bot running on Google Cloud VM detects it
        ↓
Claude AI extracts all line items
        ↓
New tab created in Google Sheet (e.g. "Order 149 - Seq 5 - 08 Oct 2026")
```

## Project structure

```
sj-delivery-bot/
├── .github/workflows/
│   └── deploy.yml        # Auto-deploys to VM on every push to main
├── index.js              # WhatsApp bot (runs 24/7 on the VM)
├── import.js             # One-time local importer for historical PDFs
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

This installs Node.js, Chromium, PM2, clones the repo, and walks you through entering credentials. At the end it prints the 3 GitHub Secrets needed for auto-deployment.

## GitHub Secrets required

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `VM_HOST` | VM external IP |
| `VM_USER` | VM username (e.g. `meet_vadaria`) |
| `VM_SSH_KEY` | Private SSH key printed by vm-setup.sh |

Once added, every push to `main` automatically deploys to the VM.

## Importing historical PDFs

Place past delivery PDFs (named `Delivery_*.pdf`) in a `pdfs/` folder, then run locally:

```bash
node import.js
```

Progress is saved to `.processed.json` — safe to re-run if interrupted.

## Google Sheet output

Each PDF creates a new tab named `Order {no} - Seq {seq} - {date}` with columns:

| Received At | Date | Order No | Delivery Seq No | Requested By | Delivery To | Category | Item Name | Item Code | Ordered | Delivered |

## Deployment

Push to `main` → GitHub Actions SSHes into the VM → pulls latest code → restarts PM2. Takes ~20 seconds.

```bash
git add .
git commit -m "your change"
git push
```

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and test locally with `node import.js`
4. Open a pull request

## Notes

- The bot uses WhatsApp Web under the hood — it runs as a linked device on your phone's WhatsApp account
- Only PDFs named `Delivery_*.pdf` are processed; all other messages are ignored
- Re-scanning the WhatsApp QR code may be needed occasionally if the session expires
