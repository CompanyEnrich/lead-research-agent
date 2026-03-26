# Lead Research Agent - Cloudflare Worker

Takes a lead email, runs CompanyEnrich API calls (person lookup, company enrichment, workforce data), and sends a formatted report to Slack.

## Setup

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Set your secrets

```bash
npx wrangler secret put COMPANYENRICH_API_KEY
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put AUTH_TOKEN          # optional, protects the endpoint
```

### 4. Deploy

```bash
npx wrangler deploy
```

Your worker will be live at: `https://lead-research-agent.<your-subdomain>.workers.dev`

## Usage

### GET request

```
https://lead-research-agent.<your-subdomain>.workers.dev?email=john@acme.com
```

### POST request

```bash
curl -X POST https://lead-research-agent.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"email": "john@acme.com"}'
```

### With auth token (if AUTH_TOKEN is set)

```bash
curl -X POST https://lead-research-agent.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{"email": "john@acme.com"}'
```

## What it does

1. Extracts domain from the email
2. Runs 3 API calls in parallel (faster than the Python version):
   - `POST /people/lookup` - person name, position, seniority, department, LinkedIn
   - `GET /companies/enrich` - company name, description, categories, funding
   - `GET /companies/workforce` - department headcount, trends
3. Formats everything into a Slack Block Kit message
4. Posts to Slack via webhook
5. Returns JSON response with all parsed data

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
