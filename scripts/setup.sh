#!/usr/bin/env bash
# One-shot setup: starts the stack and installs the required n8n modules.
set -euo pipefail

echo "▶ Starting n8n + Browserless..."
docker compose up -d

echo "▶ Waiting for n8n to boot..."
until curl -sf http://localhost:5678/healthz >/dev/null 2>&1; do sleep 2; done

CID="$(docker compose ps -q n8n)"
echo "▶ Installing n8n-nodes-puppeteer + exceljs into the n8n custom-nodes folder..."
docker exec "$CID" sh -c 'mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && ([ -f package.json ] || npm init -y >/dev/null 2>&1) && npm install n8n-nodes-puppeteer exceljs --no-audit --no-fund'

echo "▶ Restarting n8n to load the new modules..."
docker compose restart n8n
until curl -sf http://localhost:5678/healthz >/dev/null 2>&1; do sleep 2; done

echo ""
echo "✅ Done. Next:"
echo "   1. Open http://localhost:5678 (create your local owner account)"
echo "   2. Import workflow/Job_Scraper_v2.json  (Workflows → Import from File)"
echo "   3. Open the 'Konfiguracja' node, set your filters, Save, and Execute."
