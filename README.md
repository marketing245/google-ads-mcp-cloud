# Google Ads MCP Server (Cloud)

Deploy to any Node.js hosting (Railway, Render, Fly.io, etc.) and connect via **claude.ai**.

40 tools: 20 read + 20 write for full Google Ads management.

## Quick Start

### 1. Get Google Ads API Credentials

1. **Google Cloud Project** with Google Ads API enabled
2. **OAuth 2.0 Client ID** (Web application type)
3. **Developer Token** from MCC > Tools > API Center
4. **Refresh Token** - run locally to get it:

```bash
git clone <this-repo>
cd google-ads-mcp-cloud
npm install

# Add http://localhost:8765/callback as redirect URI in Google Cloud Console
# Then get refresh token:
node -e "
const http = require('http');
const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
const REDIRECT = 'http://localhost:8765/callback';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8765');
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' })
    });
    const data = await r.json();
    res.end('Done! Check terminal.');
    console.log('REFRESH TOKEN:', data.refresh_token);
    server.close();
  }
});
server.listen(8765, () => {
  console.log('Open this URL:');
  console.log(\`https://accounts.google.com/o/oauth2/v2/auth?client_id=\${CLIENT_ID}&redirect_uri=\${REDIRECT}&response_type=code&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent\`);
});
"
```

### 2. Deploy

**Railway:**
```bash
railway init
railway variables set GOOGLE_ADS_CLIENT_ID=xxx
railway variables set GOOGLE_ADS_CLIENT_SECRET=xxx
railway variables set GOOGLE_ADS_DEVELOPER_TOKEN=xxx
railway variables set GOOGLE_ADS_REFRESH_TOKEN=xxx
railway variables set GOOGLE_ADS_MCC_ID=1234567890
railway up
```

**Render:**
- Create Web Service, connect this repo
- Add env vars from `.env.example`
- Build: `npm install` | Start: `npm start`

**Fly.io:**
```bash
fly launch
fly secrets set GOOGLE_ADS_CLIENT_ID=xxx GOOGLE_ADS_CLIENT_SECRET=xxx GOOGLE_ADS_DEVELOPER_TOKEN=xxx GOOGLE_ADS_REFRESH_TOKEN=xxx GOOGLE_ADS_MCC_ID=1234567890
fly deploy
```

### 3. Connect to claude.ai

1. Go to **claude.ai > Settings > MCP Servers**
2. Click **Add MCP Server**
3. Enter URL: `https://YOUR_APP.HOST/sse`
4. Done! Claude can now manage your Google Ads.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_ADS_CLIENT_ID` | Yes | OAuth Client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | Yes | OAuth Client Secret |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Yes | Developer Token |
| `GOOGLE_ADS_REFRESH_TOKEN` | Yes | OAuth Refresh Token |
| `GOOGLE_ADS_MCC_ID` | Yes | MCC Account ID |
| `PORT` | No | Server port (default: 8765) |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `/sse` | SSE connection for MCP clients (claude.ai) |
| `/messages` | JSON-RPC message handler |
| `/health` | Health check |
| `/` | Server info |

## 40 Tools

**READ (20):** list_accounts, list_campaigns, campaign_performance, ad_group_performance, keyword_performance, ad_performance, search_terms_report, get_campaign_structure, get_ad_group_ads, get_geo_performance, get_device_performance, get_age_gender_performance, get_quality_scores, get_conversion_actions, get_campaign_budget_details, get_bidding_strategy_details, get_change_history, run_gaql_query, get_location_targets, search_geo_target

**WRITE (20):** create_search_campaign, create_pmax_campaign, create_ad_group, create_responsive_search_ad, add_keywords, add_negative_keywords, remove_keywords, remove_negative_keywords, update_campaign_status, update_campaign_budget, update_campaign_name, update_bidding_strategy, update_ad_group_status, update_ad_group_bid, update_keyword_status, update_keyword_bid, remove_ad, add_sitelinks, set_location_targets, remove_location_targets

## Health Check

```bash
curl https://YOUR_APP.HOST/health
# {"status":"ok","tools":40,"sessions":0}
```
