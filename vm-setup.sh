#!/bin/bash
# ─── One-time VM setup — run this once inside the Google Cloud browser terminal
set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  WhatsApp Delivery Bot — VM Setup    ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. System packages ─────────────────────────────────────────────────────────
echo "🔄  Updating system..."
sudo apt-get update -qq

echo "📦  Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - -qq
sudo apt-get install -y nodejs git chromium-browser -qq

# ── 2. Swap (critical on 1 GB e2-micro) ───────────────────────────────────────
if [ ! -f /swapfile ]; then
  echo "💾  Adding 2 GB swap..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile -q
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
fi

# ── 3. Clone repo ──────────────────────────────────────────────────────────────
echo ""
read -p "GitHub repo URL (e.g. https://github.com/meet101/sj-delivery-bot): " REPO_URL

if [ -d ~/delivery-bot ]; then
  echo "   Folder already exists — pulling latest..."
  cd ~/delivery-bot && git pull origin main
else
  git clone "$REPO_URL" ~/delivery-bot
  cd ~/delivery-bot
fi

# ── 4. Install npm packages ────────────────────────────────────────────────────
echo "📦  Installing npm packages..."
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install --quiet

# ── 5. PM2 ────────────────────────────────────────────────────────────────────
sudo npm install -g pm2 --quiet

# ── 6. Credentials ────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
echo "  Enter your settings:"
echo "────────────────────────────────────────"
read -p "WhatsApp group name (exact):   " GROUP
read -p "Gemini API key:                " GEMINI
read -p "Google Spreadsheet ID:         " SHEET_ID
read -p "Timezone [Asia/Kolkata]:       " TZ_VAL
TZ_VAL=${TZ_VAL:-Asia/Kolkata}

cat > ~/delivery-bot/.env << ENVEOF
WHATSAPP_GROUP_NAME=${GROUP}
GEMINI_API_KEY=${GEMINI}
GOOGLE_SPREADSHEET_ID=${SHEET_ID}
TIMEZONE=${TZ_VAL}
ENVEOF

echo ""
echo "📋  Upload google-credentials.json now."
echo "    In this browser terminal: gear icon → Upload file → select it."
echo "    Then press Enter to continue..."
read -p ""
mv ~/google-credentials.json ~/delivery-bot/google-credentials.json 2>/dev/null || true

# ── 7. Generate deploy SSH key for GitHub Actions ─────────────────────────────
echo ""
echo "🔑  Generating SSH key for GitHub Actions..."
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github_deploy -N "" -q
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# ── 8. Start bot ──────────────────────────────────────────────────────────────
cd ~/delivery-bot
pm2 start index.js --name delivery-bot
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

# ── 9. Print what to add to GitHub ────────────────────────────────────────────
VM_IP=$(curl -s ifconfig.me)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Add these 3 secrets to GitHub:                         ║"
echo "║  github.com/meet101/delivery-bot → Settings → Secrets   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Name: VM_HOST"
echo "  Value: ${VM_IP}"
echo ""
echo "  Name: VM_USER"
echo "  Value: $(whoami)"
echo ""
echo "  Name: VM_SSH_KEY"
echo "  Value: (copy everything below, including the header/footer lines)"
echo ""
cat ~/.ssh/github_deploy
echo ""
echo "══════════════════════════════════════════════════════════"
echo ""
echo "Once secrets are added, any push to main auto-deploys. 🎉"
echo ""
echo "Now scan the QR code to link WhatsApp:"
echo "  pm2 logs delivery-bot"
echo ""
