# Recall — Spaced Repetition Tracker

A spaced repetition tracker that stores your data permanently in Google Sheets.

## Deploy to Vercel (5 minutes)

### Step 1 — Push to GitHub
1. Create a new repo on GitHub (github.com → New repository)
2. Upload all these files, or run:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/recall-app.git
   git push -u origin main
   ```

### Step 2 — Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"Add New Project"**
3. Import your `recall-app` repository
4. Vercel auto-detects Vite — no build settings needed
5. Before clicking Deploy, go to **Environment Variables** and add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from [console.anthropic.com](https://console.anthropic.com)
6. Click **Deploy** — done! You get a URL like `recall-app.vercel.app`

### Step 3 — Connect Google Drive
On first open, the app will use the Anthropic API (via your key) to access Google Drive MCP and find/create your sheet named **"Recall - Spaced Repetition"** automatically.

> **Note:** The Google Drive MCP (`drivemcp.googleapis.com`) requires the user to have authorized Google Drive access via Anthropic's MCP. This works automatically when deployed and accessed from a browser where you're logged into Claude.ai with Google Drive connected.

## Local Development
```bash
npm install
cp .env.example .env.local
# Edit .env.local with your ANTHROPIC_API_KEY
npm run dev
```

## Project Structure
```
recall-app/
├── api/
│   └── claude.js        # Serverless function — keeps API key secret
├── src/
│   ├── main.jsx         # React entry point
│   └── App.jsx          # Main application
├── index.html
├── package.json
├── vite.config.js
└── vercel.json
```

## How it works
- **Frontend**: React + Vite, no heavy dependencies
- **Backend**: Single Vercel serverless function (`/api/claude.js`) proxies requests to Anthropic API — your API key never touches the browser
- **Storage**: Google Sheets via Anthropic's MCP (Model Context Protocol) — all data lives in a sheet called "Recall - Spaced Repetition" in your Google Drive
