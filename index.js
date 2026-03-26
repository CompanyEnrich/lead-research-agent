// Lead Research Agent - Cloudflare Worker
// Takes a lead email, runs CompanyEnrich API calls, sends formatted results to Slack.
//
// Environment variables (set via wrangler secret):
//   COMPANYENRICH_API_KEY - Your CompanyEnrich API key
//   SLACK_WEBHOOK_URL    - Your Slack incoming webhook URL

const BASE_URL = "https://api.companyenrich.com";

// ─── API Calls ───────────────────────────────────────────────

async function reverseEmailLookup(email, apiKey) {
  try {
    const resp = await fetch(`${BASE_URL}/people/lookup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });
    if (resp.ok) return await resp.json();
    console.log(`Person lookup ${resp.status}: ${await resp.text()}`);
    return {};
  } catch (e) {
    console.error("Person lookup error:", e);
    return {};
  }
}

async function companyEnrich(domain, apiKey) {
  try {
    const resp = await fetch(
      `${BASE_URL}/companies/enrich?domain=${encodeURIComponent(domain)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    if (resp.ok) return await resp.json();
    console.log(`Company enrich ${resp.status}: ${await resp.text()}`);
    return {};
  } catch (e) {
    console.error("Company enrich error:", e);
    return {};
  }
}

async function companyWorkforce(domain, apiKey) {
  try {
    const resp = await fetch(
      `${BASE_URL}/companies/workforce?domain=${encodeURIComponent(domain)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    if (resp.ok) return await resp.json();
    console.log(`Workforce ${resp.status}: ${await resp.text()}`);
    return {};
  } catch (e) {
    console.error("Workforce error:", e);
    return {};
  }
}

// ─── Parsers ─────────────────────────────────────────────────

function parsePerson(data) {
  let person = data || {};
  if (person.data) person = person.data;
  if (Array.isArray(person) && person.length > 0) person = person[0];

  const name = person.name || "N/A";
  const firstName = person.first_name || "";
  const lastName = person.last_name || "";
  const location = person.location?.address || "N/A";
  const linkedin = person.socials?.linkedin_url || "N/A";

  let position = "N/A";
  let seniority = "N/A";
  let department = "N/A";
  let currentCompany = "N/A";

  const experiences = person.experiences || [];
  for (const exp of experiences) {
    if (exp.isCurrent) {
      position = exp.position || "N/A";
      seniority = exp.seniority || "N/A";
      department = exp.department || "N/A";
      currentCompany = exp.company?.name || "N/A";
      break;
    }
  }

  return {
    name,
    firstName,
    lastName,
    seniority,
    department,
    position,
    location,
    linkedin,
    currentCompany,
  };
}

function parseCompany(data) {
  let company = data || {};
  if (company.data) company = company.data;

  const name = company.name || "N/A";
  const description = company.description || "N/A";

  let categories = "N/A";
  const raw = company.categories;
  if (Array.isArray(raw) && raw.length) {
    categories = raw.slice(0, 5).join(", ");
  } else if (typeof raw === "string") {
    categories = raw;
  }

  // Funding
  const financial = company.financial || {};
  const totalFundingRaw = financial.total_funding;
  let totalFunding = "N/A";
  if (totalFundingRaw && typeof totalFundingRaw === "number" && totalFundingRaw > 0) {
    if (totalFundingRaw >= 1_000_000) {
      totalFunding = `$${(totalFundingRaw / 1_000_000).toFixed(1)}M`;
    } else if (totalFundingRaw >= 1_000) {
      totalFunding = `$${Math.round(totalFundingRaw / 1_000)}K`;
    } else {
      totalFunding = `$${totalFundingRaw.toLocaleString()}`;
    }
  }

  let fundingStage = financial.funding_stage || "N/A";
  if (fundingStage !== "N/A") {
    fundingStage = fundingStage
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const fundingRounds = financial.funding || [];

  const website = company.website || "N/A";
  const linkedin = company.socials?.linkedin_url || "N/A";

  return {
    name,
    website,
    linkedin,
    description,
    categories,
    totalFunding,
    fundingStage,
    fundingRounds,
  };
}

function parseWorkforce(data) {
  let workforce = data || {};
  if (workforce.data) workforce = workforce.data;

  const deptData = workforce.department_headcount || {};
  const departments = Object.entries(deptData)
    .map(([name, count]) => ({ name, count: Number(count) }))
    .sort((a, b) => b.count - a.count);

  const total =
    workforce.observed_employee_count ||
    departments.reduce((sum, d) => sum + d.count, 0);
  const employeeRange = workforce.employee_count_range || "";

  // Trends from history
  const trends = [];
  const history = workforce.history || [];
  if (Array.isArray(history) && history.length >= 2) {
    const latest = history[0];
    const prev = history[1];
    const latestDepts = latest.department_headcount || {};
    const prevDepts = prev.department_headcount || {};

    const allDepts = new Set([
      ...Object.keys(latestDepts),
      ...Object.keys(prevDepts),
    ]);

    for (const dept of allDepts) {
      const current = latestDepts[dept] || 0;
      const previous = prevDepts[dept] || 0;

      let changePct = 0;
      if (previous > 0) {
        changePct = ((current - previous) / previous) * 100;
      } else if (current > 0) {
        changePct = 100;
      } else {
        continue;
      }

      if (Math.abs(changePct) > 15) {
        trends.push({
          department: dept,
          changePct: Math.round(changePct * 10) / 10,
          prev: previous,
          current,
          prevDate: prev.date || "",
          currentDate: latest.date || "",
        });
      }
    }
  }

  return { departments, trends, total, employeeRange };
}

// ─── Slack Message Builder ───────────────────────────────────

function titleCase(str) {
  return str.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatAmount(amountStr) {
  if (!amountStr || typeof amountStr !== "string") return "N/A";
  const match = amountStr.match(/^(\d+)/);
  if (!match) return amountStr;
  const num = parseInt(match[1], 10);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${Math.round(num / 1_000)}K`;
  return `$${num.toLocaleString()}`;
}

function buildSlackMessage(email, person, company, workforce) {
  let personName = person.name;
  if (personName === "N/A" && (person.firstName || person.lastName)) {
    personName = `${person.firstName} ${person.lastName}`.trim();
  }

  const blocks = [];

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `:mag: Lead Research: ${personName}`,
      emoji: true,
    },
  });

  // Person
  const linkedinLine =
    person.linkedin !== "N/A"
      ? `\n>*LinkedIn:* <${person.linkedin}|Profile>`
      : "";

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*:bust_in_silhouette: Person Details*\n` +
        `>*Email:* ${email}\n` +
        `>*Name:* ${personName}\n` +
        `>*Position:* ${person.position}\n` +
        `>*Seniority:* ${person.seniority}\n` +
        `>*Department:* ${person.department}\n` +
        `>*Location:* ${person.location}` +
        linkedinLine,
    },
  });

  blocks.push({ type: "divider" });

  // Company
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*:office: Company Overview*\n` +
        `>*Name:* ${company.name}\n` +
        (company.website !== "N/A" ? `>*Website:* \`${company.website}\`\n` : "") +
        (company.linkedin !== "N/A" ? `>*LinkedIn:* <${company.linkedin}|Profile>\n` : "") +
        `>*Categories:* ${company.categories}\n` +
        `>*Description:* ${company.description}`,
    },
  });

  blocks.push({ type: "divider" });

  // Funding
  if (company.totalFunding !== "N/A" || company.fundingRounds.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*:moneybag: Funding*\n` +
          `>*Total Raised:* ${company.totalFunding}  |  *Stage:* ${company.fundingStage}`,
      },
    });

    for (const r of company.fundingRounds) {
      const date = r.date ? r.date.slice(0, 10) : "N/A";
      const amount = formatAmount(r.amount);
      let roundType = r.type || "N/A";
      if (roundType.includes(" - ")) roundType = roundType.split(" - ")[0];
      const investor = r.from || "N/A";

      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `:small_orange_diamond:  *${roundType}*  ${amount}  :point_right:  _${investor}_  (${date})`,
          },
        ],
      });
    }

    blocks.push({ type: "divider" });
  }

  // Workforce
  const { departments, total, employeeRange } = workforce;
  const rangeStr = employeeRange ? ` | Range: ${employeeRange}` : "";

  if (departments.length > 0) {
    const deptLines = [
      `*:bar_chart: Workforce Breakdown*  |  Observed: *${total}*${rangeStr}`,
      "```",
      `${"Department".padEnd(25)} ${"Count".padStart(10)}`,
      `${"-".repeat(25)} ${"-".repeat(10)}`,
    ];

    for (const d of departments.slice(0, 15)) {
      const displayName = d.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      deptLines.push(`${displayName.padEnd(25)} ${String(d.count).padStart(10)}`);
    }

    deptLines.push("```");

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: deptLines.join("\n") },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*:bar_chart: Workforce*\nNo workforce data available.",
      },
    });
  }

  // Trends
  if (workforce.trends.length > 0) {
    blocks.push({ type: "divider" });
    const trendLines = ["*:eyes: Notable Department Trends*"];
    for (const t of workforce.trends) {
      const sign = t.changePct > 0 ? "+" : "";
      const emoji =
        t.changePct > 0 ? ":arrow_upper_right:" : ":arrow_lower_right:";
      const deptName = titleCase(t.department);
      let period = "";
      if (t.prevDate && t.currentDate) {
        period = `  _(${t.prevDate} to ${t.currentDate})_`;
      }
      trendLines.push(
        `${emoji}  *${deptName}*: ${sign}${t.changePct}% (${t.prev} to ${t.current})${period}`
      );
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: trendLines.join("\n") },
    });
  }

  // Footer
  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: ":zap: Powered by CompanyEnrich | Data may not reflect real-time changes",
      },
    ],
  });

  return { blocks };
}

// ─── Slack Sender ────────────────────────────────────────────

async function sendToSlack(webhookUrl, message) {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const text = await resp.text();
    return resp.ok && text === "ok";
  } catch (e) {
    console.error("Slack error:", e);
    return false;
  }
}

// ─── Email Finder ────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function findEmail(obj, depth = 0) {
  if (depth > 10) return null;

  if (typeof obj === "string") {
    const match = obj.match(EMAIL_RE);
    return match ? match[0] : null;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findEmail(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (obj && typeof obj === "object") {
    // Prioritize keys that likely hold the email
    const priorityKeys = ["email", "email_address", "mail", "e-mail", "contact_email", "user_email"];
    for (const key of priorityKeys) {
      if (obj[key]) {
        const found = findEmail(obj[key], depth + 1);
        if (found) return found;
      }
    }
    // Then scan remaining keys
    for (const [key, val] of Object.entries(obj)) {
      if (priorityKeys.includes(key)) continue;
      const found = findEmail(val, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

// ─── Main Handler ────────────────────────────────────────────

async function handleRequest(request, env) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // Get email from query param or POST body
  let email = null;

  if (request.method === "GET") {
    const url = new URL(request.url);
    email = url.searchParams.get("email");
  } else if (request.method === "POST") {
    try {
      const body = await request.json();
      email = findEmail(body);
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }
  }

  if (!email || !email.includes("@")) {
    return Response.json(
      { error: "Missing or invalid email. Use ?email=lead@example.com or POST {\"email\": \"lead@example.com\"}" },
      { status: 400 }
    );
  }

  email = email.trim().toLowerCase();
  const domain = email.split("@")[1];

  // Run all 3 API calls in parallel
  const apiKey = env.COMPANYENRICH_API_KEY;
  const [personRaw, companyRaw, workforceRaw] = await Promise.all([
    reverseEmailLookup(email, apiKey),
    companyEnrich(domain, apiKey),
    companyWorkforce(domain, apiKey),
  ]);

  // Parse
  const person = parsePerson(personRaw);
  const company = parseCompany(companyRaw);
  const workforce = parseWorkforce(workforceRaw);

  // Build and send Slack message
  const message = buildSlackMessage(email, person, company, workforce);
  const slackSent = await sendToSlack(env.SLACK_WEBHOOK_URL, message);

  // Return JSON response
  return Response.json(
    {
      email,
      domain,
      person,
      company: {
        name: company.name,
        description: company.description,
        categories: company.categories,
        totalFunding: company.totalFunding,
        fundingStage: company.fundingStage,
      },
      workforce: {
        total: workforce.total,
        employeeRange: workforce.employeeRange,
        topDepartments: workforce.departments.slice(0, 5),
        trends: workforce.trends,
      },
      slackSent,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    }
  );
}

// ─── Worker Export ────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};
