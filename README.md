# Lead Research Agent - Cloudflare Worker

Takes a lead email, runs CompanyEnrich API calls (person lookup, company enrichment, workforce data), and sends a formatted report to Slack.

## What it does

1. Extracts domain from the email
2. Runs 3 API calls in parallel:
   - `POST /people/lookup` - person name, position, seniority, department, LinkedIn
   - `GET /companies/enrich` - company name, description, categories, funding
   - `GET /companies/workforce` - department headcount, trends
3. Formats everything into a Slack Block Kit message
4. Posts to Slack via webhook
5. Returns JSON response with all parsed data

## Deploy

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CompanyEnrich/lead-research-agent)

### Manual deploy

#### 1. Install Wrangler

```bash
npm install -g wrangler
```

#### 2. Login to Cloudflare

If you don't have a Cloudflare account, sign up at [dash.cloudflare.com](https://dash.cloudflare.com) first.

```bash
wrangler login
```

#### 3. Deploy

```bash
npx wrangler deploy
```

Your worker will be live at: `https://lead-research-agent.<your-subdomain>.workers.dev`

### Configure

**CompanyEnrich API Key:** Sign up and get your access token from the [CompanyEnrich website](https://companyenrich.com).

**Slack Incoming Webhook:** Set up an incoming webhook for your Slack workspace via the [Slack Marketplace](https://slack.com/marketplace/A0F7XDUAZ-incomming-webhooks).

Edit `wrangler.toml` and fill in the `[vars]` section:

```toml
[vars]
COMPANYENRICH_API_KEY = "your-api-key"
SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/..."
AUTH_TOKEN = ""  # optional, protects the endpoint
```

## Usage

### GET request

```
https://lead-research-agent.<your-subdomain>.workers.dev?email=john@acme.com
```

### POST request

Send any JSON payload — the worker will automatically find the email address in your body, no matter the structure or key name.

```bash
curl -X POST https://lead-research-agent.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"email": "john@acme.com"}'
```

All of these work too:

```json
{"contact_email": "john@acme.com"}
{"user": {"mail": "john@acme.com"}}
{"data": [{"value": "john@acme.com"}]}
```

### With auth token (if AUTH_TOKEN is set)

```bash
curl -X POST https://lead-research-agent.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{"email": "john@acme.com"}'
```

## Response format

```json
{
  "email": "john@acme.com",
  "domain": "acme.com",
  "person": { "name": "...", "position": "...", ... },
  "company": { "name": "...", "description": "...", "totalFunding": "...", ... },
  "workforce": { "total": 74, "topDepartments": [...], "trends": [...] },
  "slackSent": true
}
```
