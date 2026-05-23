require('dotenv').config();
process.env.TZ = 'America/New_York';
const express = require('express');

const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const cron = require('node-cron');

/* ════════════ DATA DIRECTORY (absolute, volume-safe) ════════════ */
// On Railway: __dirname = /app → DATA_DIR = /app/data (volume mount target)
// Locally: __dirname = project root → DATA_DIR = ./data
const DATA_DIR = path.resolve(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true }); // ensure mount point exists

function dataFilePath(name) { return path.join(DATA_DIR, name + '.json'); }

function loadDataFile(name) {
  try { return JSON.parse(fs.readFileSync(dataFilePath(name), 'utf8')); }
  catch { return []; }
}
function saveDataFile(name, data) {
  fs.writeFileSync(dataFilePath(name), JSON.stringify(data, null, 2));
}

/* ════════════ WEB PUSH SETUP ════════════ */
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_CONTACT || 'dev@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function loadSubscriptions() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('push_subscriptions'), 'utf8'));
  } catch {
    return [];
  }
}

function saveSubscriptions(subs) {
  fs.writeFileSync(dataFilePath('push_subscriptions'), JSON.stringify(subs, null, 2));
}

function loadUserContext() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('user_context'), 'utf8'));
  } catch {
    return null;
  }
}

function saveUserContext(ctx) {
  fs.writeFileSync(dataFilePath('user_context'), JSON.stringify(ctx, null, 2));
}

const INSIGHTS_CACHE = dataFilePath('insights_cache');

/* ════════════ WORKOUT DATA (structured: today + history + streak) ════════════ */
function loadWorkoutData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFilePath('workouts'), 'utf8'));
    // Migrate old flat array format → new structured format
    if (Array.isArray(raw)) {
      const history = [];
      const todayStr = userDateStr('America/New_York');
      let today_workouts = [];
      for (const entry of raw) {
        if (entry.date === todayStr) {
          today_workouts = today_workouts.concat(entry.sessions || []);
        } else {
          history.push(entry);
        }
      }
      return { today_workouts, streak_count: 0, history };
    }
    // Ensure all fields exist
    return {
      today_workouts: raw.today_workouts || [],
      streak_count: raw.streak_count || 0,
      history: raw.history || [],
    };
  } catch {
    return { today_workouts: [], streak_count: 0, history: [] };
  }
}
function saveWorkoutData(data) {
  fs.writeFileSync(dataFilePath('workouts'), JSON.stringify(data, null, 2));
}
function computeServerStreak(wkData) {
  // Build a set of dates that had workouts (from history + today)
  const datesWithWorkouts = new Set();
  if (wkData.today_workouts && wkData.today_workouts.length) {
    datesWithWorkouts.add(userDateStr('America/New_York'));
  }
  for (const entry of (wkData.history || [])) {
    if (entry.sessions && entry.sessions.length) {
      datesWithWorkouts.add(entry.date);
    }
  }
  // Walk backward from today, count consecutive days
  let streak = 0;
  let gapDays = 0;
  const check = new Date();
  const todayStr = userDateStr('America/New_York');
  if (!datesWithWorkouts.has(todayStr)) {
    check.setDate(check.getDate() - 1);
    gapDays = 1;
  }
  while (gapDays < 3) {
    const ds = check.getFullYear() + '-' + String(check.getMonth() + 1).padStart(2, '0') + '-' + String(check.getDate()).padStart(2, '0');
    if (datesWithWorkouts.has(ds)) { streak++; gapDays = 0; } else { gapDays++; }
    check.setDate(check.getDate() - 1);
    if (streak > 365) break;
  }
  return streak;
}

const app = express();
const PORT = process.env.PORT || 8000;

// Block access to sensitive files
const BLOCKED = new Set(['/.env', '/server.js', '/package.json', '/package-lock.json', '/.gitignore']);
app.use((req, res, next) => {
  if (BLOCKED.has(req.path) || req.path.startsWith('/data/')) return res.status(403).end();
  next();
});
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));

// Redirect root to dashboard
app.get('/', (req, res) => res.redirect('/dashboard.html'));

/* ════════════ CHAT (Groq streaming) ════════════ */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'getWorkoutHistory',
      description: 'Get the user\'s workout sessions, weekly stats, and current consecutive workout streak count.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCalendarEvents',
      description: 'Get upcoming calendar events for the next 7 days.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFinancialSummary',
      description: 'Get the user\'s monthly spending, income, and budget status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getHealthMetrics',
      description: 'Get the user\'s water intake, sleep data, and supplement status for today.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function buildSystemMsg(ctx) {
  let msg = 'You are Aura, a sleek, premium personal coach and tracker assistant. Be conversational, highly supportive, concise, and professional.\n\n';

  if (ctx.currentDate) {
    msg += `Today's date: ${ctx.currentDate}. Use this to anchor all "today"/"tomorrow"/"this week" references.\n\n`;
  }

  msg += 'CRITICAL RULES:\n';
  msg += '- ONLY reference data provided below. Never invent, guess, or fabricate numbers.\n';
  msg += '- If a stat is 0 or empty, the user has NOT logged data yet. Say so honestly and encourage them to log it.\n';
  msg += '- Never pretend the user did something when the data shows 0 sessions, 0 glasses, etc.\n';
  msg += '- Reference specific numbers when they are non-zero. When zero, be honest about it.\n';
  msg += '- CRITICAL DATA RULE: You must only report numbers from the user data below. If a count is 0 or a list is empty, report exactly that — never invent numbers. If water shows "0 units out of 8", say zero. If supplements show "0 out of 5", say zero. Never assume or guess.\n\n';

  if (ctx.workout) {
    const w = ctx.workout;
    const hasWorkoutData = w.todaySessions > 0 || w.weekSessions > 0;
    msg += `[Workout History]\n`;
    if (hasWorkoutData) {
      if (w.todaySessions > 0) msg += `- Today: ${w.todaySessions} session(s), ${w.todayMinutes} min total\n`;
      else msg += `- Today: No workout logged yet\n`;
      msg += `- This week: ${w.weekSessions} session(s), ${w.weekMinutes} min total\n`;
      msg += `- Current streak: ${w.streak} day${w.streak !== 1 ? 's' : ''} \u{1F525}\n`;
      if (w.recentTypes && w.recentTypes !== 'none') msg += `- Recent types: ${w.recentTypes}\n`;
    } else {
      msg += `- No workouts logged this week yet\n`;
    }
    msg += `\nCOACHING RULES FOR WORKOUT STREAK:\n`;
    msg += `- If streak >= 3, celebrate it enthusiastically! Mention the specific number.\n`;
    msg += `- If user hasn\'t worked out today AND streak > 0, gently motivate them to keep it alive.\n`;
    msg += `- If streak === 0 and no workouts logged, encourage them to start a streak today.\n`;
    msg += `- If streak === 0 but they worked out today, say they just started one!\n\n`;
  }

  if (ctx.calendarSummary) {
    msg += `[Calendar]\n${ctx.calendarSummary}\n\n`;
  }

  if (ctx.finance) {
    const f = ctx.finance;
    const hasFinance = parseFloat(f.totalSpent) > 0;
    msg += `[Financial Summary]\n`;
    if (hasFinance) {
      msg += `- Spent this month: $${f.totalSpent}\n`;
      if (f.income) msg += `- Monthly income: $${f.income}\n`;
      if (f.budgetPct !== null) msg += `- Budget used: ${f.budgetPct}%\n`;
    } else {
      msg += `- No expenses logged yet this month\n`;
      if (!f.income) msg += `- Income not set\n`;
    }
    if (f.itemizedExpenses && f.itemizedExpenses.length) {
      msg += `\nRecent expenses this week:\n`;
      f.itemizedExpenses.forEach(e => msg += `- ${e.name}: $${e.amount}\n`);
    }
    if (f.activeSubscriptions && f.activeSubscriptions.length) {
      msg += `\nActive subscriptions:\n`;
      f.activeSubscriptions.forEach(s => msg += `- ${s.name}: $${s.amount}/${s.cycle}\n`);
    }
    msg += '\n';
  }

  if (ctx.health) {
    const h = ctx.health;
    msg += `[Health Metrics Today]\n`;
    if (h.waterSummary) {
      msg += `- ${h.waterSummary}\n`;
    }
    msg += `- Sleep: ${h.sleepHours}h (${h.sleepQuality} quality)\n`;
    if (h.supplementSummary) {
      msg += `- ${h.supplementSummary}\n`;
    }
    msg += '\n';
  }

  return msg;
}

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GROQ_API_KEY not set on server' });

  const messages = req.body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  const context = req.body.context || {};
  const systemMsg = buildSystemMsg(context);

  const payload = {
    model: 'llama-3.1-8b-instant',
    stream: true,
    messages: [{ role: 'system', content: systemMsg }, ...messages],
  };

  try {
    const groqResp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!groqResp.ok) {
      const errText = await groqResp.text();
      return res.status(502).json({ error: 'Groq API error: ' + groqResp.status });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const reader = groqResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            res.write('data: ' + JSON.stringify({ content }) + '\n\n');
          }
        } catch {}
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Chat error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Chat failed: ' + err.message });
    } else {
      res.end();
    }
  }
});

/* ════════════ PUSH NOTIFICATION ENDPOINTS ════════════ */

// Return VAPID public key so the client can subscribe
app.get('/api/notifications/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Register a push subscription from the browser
app.post('/api/notifications/register', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: 'Missing subscription object' });
  }

  const subs = loadSubscriptions();
  // Deduplicate by endpoint
  const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subs[idx] = sub;
  } else {
    subs.push(sub);
  }
  saveSubscriptions(subs);
  res.json({ ok: true, count: subs.length });
});

// Test endpoint — sends a push notification to all saved subscriptions
app.post('/api/notifications/test', async (req, res) => {
  const subs = loadSubscriptions();
  if (!subs.length) {
    return res.status(400).json({ error: 'No subscriptions registered' });
  }

  const payload = JSON.stringify({
    title: 'Aura',
    body: req.body?.body || 'Test notification from Aura!'
  });

  const results = { sent: 0, failed: 0, removed: 0 };
  const alive = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      results.sent++;
      alive.push(sub);
    } catch (err) {
      results.failed++;
      if (err.statusCode === 410) {
        results.removed++;
      } else {
        alive.push(sub);
      }
      console.error('Push send error:', err.statusCode, err.message);
    }
  }

  if (alive.length !== subs.length) {
    saveSubscriptions(alive);
  }

  res.json(results);
});

/* ════════════ CONTEXT SYNC ════════════ */

// Client sends its localStorage context so the server can use it for briefings
app.post('/api/context', (req, res) => {
  const ctx = req.body;
  if (!ctx || typeof ctx !== 'object') {
    return res.status(400).json({ error: 'Missing context object' });
  }
  ctx._syncedAt = new Date().toISOString();
  saveUserContext(ctx);
  res.json({ ok: true });
});

/* ════════════ FINANCE API ════════════ */

// loadDataFile returns [] for missing files, but finance.json is an object
function loadFinanceData() {
  var raw = loadDataFile('finance');
  return (raw && !Array.isArray(raw)) ? raw : {};
}

// POST /api/v1/finance/income — persist income structure
app.post('/api/v1/finance/income', (req, res) => {
  const { amount, freq } = req.body;
  if (!amount || !freq) return res.status(400).json({ error: 'Missing amount or freq' });
  const finance = loadFinanceData();
  finance.income = { amount: parseFloat(amount), freq, updatedAt: Date.now() };
  saveDataFile('finance', finance);
  res.json({ ok: true });
});

// GET /api/v1/finance/savings — read savings goal
app.get('/api/v1/finance/savings', (req, res) => {
  const finance = loadFinanceData();
  const savings = finance.savings || { target: 0, current: 0, title: 'Savings Goal' };
  res.json(savings);
});

// POST /api/v1/finance/savings — update savings goal or contribute
app.post('/api/v1/finance/savings', (req, res) => {
  const { target, current, title, action } = req.body;
  if (!target && !current && !title && !action) {
    return res.status(400).json({ error: 'Provide target, current, title, or action' });
  }
  const finance = loadFinanceData();
  if (!finance.savings) {
    finance.savings = { target: 0, current: 0, title: 'Savings Goal' };
  }
  if (target !== undefined) finance.savings.target = parseFloat(target);
  if (current !== undefined) finance.savings.current = parseFloat(current);
  if (title !== undefined) finance.savings.title = String(title).trim();
  if (action === 'contribute' && req.body.amount) {
    finance.savings.current = (finance.savings.current || 0) + parseFloat(req.body.amount);
  }
  finance.savings.updatedAt = Date.now();
  saveDataFile('finance', finance);
  res.json({ ok: true, savings: finance.savings });
});

// POST /api/v1/finance/expense — persist single expense
app.post('/api/v1/finance/expense', (req, res) => {
  const { amount, desc, cat, time } = req.body;
  if (!amount) return res.status(400).json({ error: 'Missing amount' });
  const finance = loadFinanceData();
  if (!Array.isArray(finance.expenses)) finance.expenses = [];
  finance.expenses.push({
    amount: parseFloat(amount),
    desc: desc || '',
    cat: cat || 'Other',
    time: time || Date.now()
  });
  saveDataFile('finance', finance);
  res.json({ ok: true });
});

// POST /api/v1/finance/advisory — AI spending optimization tips
app.post('/api/v1/finance/advisory', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GROQ_API_KEY not configured' });

  const { expenses, income } = req.body || {};
  const monthlyIncome = income ? getMonthlyAmount(income) : 0;
  const totalExpenses = (expenses || []).reduce((s, e) => s + (e.amount || 0), 0);

  // Build expense summary by description
  const expenseLines = (expenses || []).slice(-30).map(e =>
    '- $' + (e.amount || 0).toFixed(2) + ' on ' + (e.desc || e.cat || 'unknown')
  ).join('\n');

  const prompt = `You are a concise personal finance advisor. Based on this user's financial data, provide exactly 3 high-impact, specific optimization tips. Each tip must be ONE sentence, actionable, and under 20 words.

Monthly income: $${monthlyIncome.toFixed(2)}
Total recent expenses: $${totalExpenses.toFixed(2)}
Expenses:
${expenseLines || 'No expenses logged yet.'}

Rules:
- Output ONLY a JSON array of 3 strings. No markdown, no explanation, no code fences.
- Be specific to their actual spending patterns. Reference real categories they're spending on.
- If expenses are empty, give 3 general budgeting starter tips.
- Focus on: reducing waste, optimizing subscriptions, automating savings, or finding hidden costs.`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300
      })
    });

    if (!resp.ok) {
      console.error('Advisory Groq error:', resp.status);
      return res.status(502).json({ error: 'AI request failed' });
    }

    const data = await resp.json();
    var content = data.choices[0].message.content.trim();
    // Strip markdown fences if AI wraps them
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    var tips;
    try { tips = JSON.parse(content); }
    catch {
      // Fallback: split by newlines
      tips = content.split('\n').map(function(l) { return l.replace(/^[\d\.\-\*\)\s]+/, '').trim(); }).filter(Boolean).slice(0, 3);
    }

    res.json({ tips: tips.slice(0, 3) });
  } catch (err) {
    console.error('Advisory error:', err.message);
    res.status(500).json({ error: 'Advisory failed' });
  }
});

function getMonthlyAmount(inc) {
  if (!inc || !inc.amount) return 0;
  if (inc.freq === 'weekly') return inc.amount * 52 / 12;
  if (inc.freq === 'biweekly') return inc.amount * 26 / 12;
  return inc.amount;
}

/* ════════════ DEEP WORK API ════════════ */

app.post('/api/v1/deepwork', (req, res) => {
  const { date, duration, intention } = req.body;
  if (!duration) return res.status(400).json({ error: 'Missing duration' });
  const sessions = loadDataFile('deepwork');
  const arr = Array.isArray(sessions) ? sessions : [];
  arr.push({
    date: date || new Date().toISOString().slice(0, 10),
    duration: parseInt(duration, 10),
    intention: intention || '',
    completedAt: Date.now()
  });
  saveDataFile('deepwork', arr);
  // Clear any active deepwork session
  const activeSessions = loadActiveSessions();
  if (activeSessions.deepwork) { activeSessions.deepwork = null; saveActiveSessions(activeSessions); }
  res.json({ ok: true });
});

app.get('/api/v1/deepwork', (req, res) => {
  const sessions = loadDataFile('deepwork');
  res.json(Array.isArray(sessions) ? sessions : []);
});

/* ════════════ GOAL POLISH (Anthropic proxy) ════════════ */

app.post('/api/polish', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Missing text' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'Clean up this goal and return it as a one-element JSON array of strings. No preamble, no fences. Goal: ' + text }]
      })
    });

    if (!resp.ok) {
      console.error('Polish Anthropic error:', resp.status);
      return res.status(502).json({ error: 'Anthropic request failed' });
    }

    const data = await resp.json();
    res.json({ content: data.content[0].text });
  } catch (err) {
    console.error('Polish error:', err.message);
    res.status(500).json({ error: 'Polish failed' });
  }
});

/* ════════════ TIMEZONE HELPERS ════════════ */

function userDateStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz || 'UTC' });
}
function userDayName(tz) {
  return new Date().toLocaleDateString('en-US', { timeZone: tz || 'UTC', weekday: 'long' });
}

/* ════════════ VOICE LOG PARSER ════════════ */

const VOICE_SYSTEM_PROMPT = `You are a specialized NLP engine responsible for parsing unstructured user voice logs into a structured JSON payload for a personal tracking app.

Analyze the user's input string and extract data for five categories: health, workouts, finance, calendar goals, and calendar events (CREATE/DELETE).

CRITICAL RULES:
1. Output ONLY a valid JSON object. No markdown wrapping, no conversational filler, no code fences.
2. If a category or specific metric is not mentioned, omit it from the payload or set it to null.
3. Normalize all water/fluid units to fluid ounces (oz). (e.g., "a cup" = 8oz, "a shaker" = 20oz, "a liter" = 33oz).
4. Parse relative time references ("today", "tomorrow", "next Monday") relative to the date provided.
5. If the user says "add water" or "drank water" without a quantity, assume 8oz (one glass).
6. Detect workout types: cardio, strength, hiit, yoga, running, cycling, swimming, walking, stretching, sports.
7. Detect calendar EVENT actions: "schedule", "add event", "create event", "book", "put on calendar" → calendar_action: "CREATE".
8. Detect calendar DELETE actions: "remove event", "cancel", "delete event", "clear from calendar" → calendar_action: "DELETE".
9. For DELETE, set event_match_keyword to a substring that would match the event title (e.g., "dentist" to match "Dentist Appointment").
10. For CREATE, set target_date to the specific date the event should occur.
11. Do NOT confuse calendar events (scheduled appointments) with calendar goals (daily tasks/todos). Goals use calendar.task_title; events use calendar_action.

EXPECTED JSON SCHEMA:
{
  "health": {
    "water_oz": int | null,
    "supplements": array of strings | null
  },
  "workout": {
    "type": string | null,
    "duration_minutes": int | null,
    "notes": string | null
  },
  "finance": {
    "amount": float | null,
    "category": string | null,
    "type": "expense" | "income" | null,
    "description": string | null
  },
  "calendar": {
    "task_title": string | null,
    "due_date": string | null (ISO 8601 YYYY-MM-DD),
    "is_goal": boolean
  },
  "calendar_action": "CREATE" | "DELETE" | null,
  "calendar_details": {
    "title": string | null,
    "target_date": string | null (ISO 8601 YYYY-MM-DD),
    "event_match_keyword": string | null
  },
  "intent": "CALENDAR_EVENT" | null,
  "data": {
    "title": string,
    "date": string (ISO 8601 YYYY-MM-DD),
    "time": string (HH:MM)
  } | null
}`;

app.post('/api/parse-voice', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GROQ_API_KEY not configured' });

  const { text, user_timezone } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Missing text' });

  const tz = user_timezone || 'America/New_York';
  const dateStr = userDateStr(tz);
  const dayName = userDayName(tz);

  try {
    const groqResp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        stream: false,
        messages: [
          { role: 'system', content: VOICE_SYSTEM_PROMPT + '\n\nThe user\'s current local date, time, and timezone profile is: ' + dateStr + ' at ' + new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }) + ' (' + dayName + ') (' + tz + '). You are an omniscient parser. For relative date and time calculations, note that right now is explicitly: ' + new Date().toString() + '. Use this absolute anchor to convert phrases like "this Friday", "tomorrow", or "the 21st of this month" into exact standard format calendar records.' },
          { role: 'user', content: text }
        ],
        max_tokens: 500,
        temperature: 0
      }),
    });

    if (!groqResp.ok) {
      console.error('Voice parse Groq error:', groqResp.status);
      return res.status(502).json({ error: 'Groq request failed' });
    }

    const groqData = await groqResp.json();
    let raw = groqData.choices?.[0]?.message?.content?.trim() || '{}';

    // Strip markdown fences if model wraps them
    raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw: raw };
    }

    // If calendar event intent detected, persist directly to calendar file
    if (parsed.intent === 'CALENDAR_EVENT' && parsed.data && parsed.data.title && parsed.data.date) {
      const events = loadDataFile('calendar_events');
      const ev = {
        id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        title: String(parsed.data.title).trim(),
        date: parsed.data.date,
        time: parsed.data.time || null,
        createdAt: Date.now(),
      };
      events.push(ev);
      saveDataFile('calendar_events', events);
      parsed.calendar_created = true;
      parsed.calendar_event = ev;
    }

    res.json(parsed);
  } catch (err) {
    console.error('Voice parse error:', err.message);
    res.status(500).json({ error: 'Parse failed' });
  }
});

/* ════════════ QUICK-LOG — SERVER-SIDE PERSISTENCE ════════════ */

app.post('/api/v1/quick-log', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid payload' });
  }

  const dateStr = userDateStr(payload.user_timezone || 'America/New_York');
  const now = Date.now();
  const mutations = [];
  const summaryParts = [];

  // Snapshot current state of all files for rollback
  const snapshot = {
    water:           loadDataFile('water'),
    workouts:        loadWorkoutData(),
    expenses:        loadDataFile('expenses'),
    goals:           loadDataFile('goals'),
    calendar_events: loadDataFile('calendar_events'),
  };

  try {
    // ── Water ──
    if (payload.health && payload.health.water_oz) {
      const glasses = Math.max(1, Math.round(payload.health.water_oz / 8));
      const waterData = snapshot.water;
      let entry = waterData.find(e => e.date === dateStr);
      if (!entry) {
        entry = { date: dateStr, glasses: 0, log: [] };
        waterData.push(entry);
      }
      for (let i = 0; i < glasses; i++) {
        entry.glasses++;
        entry.log.push(now);
      }
      saveDataFile('water', waterData);
      mutations.push('added_water');
      summaryParts.push(glasses + ' glass' + (glasses > 1 ? 'es' : '') + ' of water');
    }

    // ── Workout (structured: today_workouts + history + streak) ──
    if (payload.workout && payload.workout.type) {
      const secs = (payload.workout.duration_minutes || 10) * 60;
      const wkData = loadWorkoutData();
      wkData.today_workouts.push({ type: payload.workout.type, duration: secs, time: now });
      wkData.streak_count = computeServerStreak(wkData);
      saveWorkoutData(wkData);
      mutations.push('logged_workout');
      summaryParts.push(payload.workout.type + ' ' + (payload.workout.duration_minutes || 10) + 'min');
    }

    // ── Finance (expense) ──
    if (payload.finance && payload.finance.amount > 0) {
      const amt = parseFloat(payload.finance.amount) || 0;
      const cat = (payload.finance.category || 'other').toLowerCase();
      const desc = payload.finance.description || '';
      const catMap = {
        food: 'food', grocery: 'food', groceries: 'food', restaurant: 'food',
        coffee: 'food', lunch: 'food', dinner: 'food', snack: 'food', breakfast: 'food',
        transport: 'transportation', transportation: 'transportation',
        uber: 'transportation', lyft: 'transportation', gas: 'transportation', taxi: 'transportation',
        entertainment: 'entertainment', movie: 'entertainment', game: 'entertainment',
        subscription: 'subscriptions', subscriptions: 'subscriptions',
        netflix: 'subscriptions', spotify: 'subscriptions',
        shopping: 'shopping', clothes: 'shopping', amazon: 'shopping',
        health: 'health', medicine: 'health', doctor: 'health', pharmacy: 'health',
        bills: 'bills', rent: 'bills', electric: 'bills', internet: 'bills', phone: 'bills',
      };
      const normalized = catMap[cat] || cat;
      const expData = snapshot.expenses;
      expData.push({ cat: normalized, amount: amt, desc: desc, time: now });
      saveDataFile('expenses', expData);
      mutations.push('added_expense');
      summaryParts.push('$' + amt.toFixed(2) + ' on ' + (desc || normalized));
    }

    // ── Goal / Calendar task ──
    if (payload.calendar && payload.calendar.task_title) {
      const title = payload.calendar.task_title.trim();
      const goalData = snapshot.goals;
      let dayEntry = goalData.find(e => e.date === dateStr);
      if (!dayEntry) {
        dayEntry = { date: dateStr, items: [] };
        goalData.push(dayEntry);
      }
      dayEntry.items.push({ text: title, done: false, addedAt: now });
      saveDataFile('goals', goalData);
      mutations.push('added_goal');
      summaryParts.push('goal: ' + title);
    }

    // ── Calendar Event CREATE ──
    if (payload.calendar_action === 'CREATE' && payload.calendar_details && payload.calendar_details.title) {
      const calData = snapshot.calendar_events;
      const ev = {
        id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        title: payload.calendar_details.title.trim(),
        date: payload.calendar_details.target_date ? payload.calendar_details.target_date.slice(0, 10) : dateStr,
        time: payload.calendar_details.target_date && payload.calendar_details.target_date.length > 16 ? payload.calendar_details.target_date.slice(11, 16) : null,
        createdAt: now,
      };
      calData.push(ev);
      saveDataFile('calendar_events', calData);
      mutations.push('created_calendar_event');
      summaryParts.push("scheduled '" + ev.title + "' on " + ev.date);
    }

    // ── Calendar Event DELETE ──
    if (payload.calendar_action === 'DELETE' && payload.calendar_details && payload.calendar_details.event_match_keyword) {
      const keyword = payload.calendar_details.event_match_keyword.toLowerCase();
      const calData = snapshot.calendar_events;
      const before = calData.length;
      const removed = calData.filter(e => e.title.toLowerCase().includes(keyword));
      const remaining = calData.filter(e => !e.title.toLowerCase().includes(keyword));
      if (removed.length > 0) {
        saveDataFile('calendar_events', remaining);
        mutations.push('deleted_calendar_event');
        summaryParts.push('removed ' + removed.length + ' event(s) matching "' + payload.calendar_details.event_match_keyword + '"');
      } else {
        summaryParts.push('no events found matching "' + payload.calendar_details.event_match_keyword + '"');
      }
    }

    if (mutations.length === 0 && summaryParts.length === 0) {
      return res.json({ status: 'success', mutations: [], summary: 'No metrics found in payload' });
    }

    res.json({ status: 'success', mutations: mutations, summary: summaryParts.join(' and ') });
  } catch (err) {
    // Rollback — restore all files to their snapshot state
    console.error('Quick-log error, rolling back:', err.message);
    saveDataFile('water',           snapshot.water);
    saveWorkoutData(snapshot.workouts);
    saveDataFile('expenses',        snapshot.expenses);
    saveDataFile('goals',           snapshot.goals);
    saveDataFile('calendar_events', snapshot.calendar_events);
    res.status(500).json({ error: 'Write failed, all changes rolled back' });
  }
});

/* ════════════ LOCAL CALENDAR ════════════ */

// GET /api/v1/calendar — fetch all events
app.get('/api/v1/calendar', (req, res) => {
  const events = loadDataFile('calendar_events');
  res.json({ events: events });
});

// POST /api/v1/calendar/add — append a new event
app.post('/api/v1/calendar/add', (req, res) => {
  const { title, date, time } = req.body;
  if (!title || !date) {
    return res.status(400).json({ error: 'title and date are required' });
  }
  const events = loadDataFile('calendar_events');
  const ev = {
    id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    title: String(title).trim(),
    date: date,
    time: time || null,
    createdAt: Date.now(),
  };
  events.push(ev);
  saveDataFile('calendar_events', events);
  res.json({ ok: true, event: ev });
});

/* ════════════ INSIGHTS ENGINE ════════════ */

// Cache freshness: 12 hours in ms
const INSIGHTS_TTL = 12 * 60 * 60 * 1000;

function getHistoricalMatrix(daysBack) {
  daysBack = daysBack || 7;
  const now = Date.now();
  const cutoff = now - daysBack * 24 * 60 * 60 * 1000;

  // Helper: filter array entries by their timestamp field
  function byDate(items, tsField) {
    return items.filter(function(e) {
      var ts = e[tsField];
      // For date-keyed arrays with nested sessions/items, check inner timestamps
      if (!ts && e.sessions && e.sessions.length) ts = e.sessions[0].time;
      if (!ts && e.log && e.log.length) ts = e.log[0];
      if (!ts && e.items && e.items.length) ts = e.items[0].addedAt;
      return ts && ts >= cutoff;
    });
  }

  var water = byDate(loadDataFile('water'), 'time');
  var wkRaw = loadWorkoutData();
  var todayStr = userDateStr('America/New_York');
  var allWorkouts = wkRaw.history.slice();
  if (wkRaw.today_workouts && wkRaw.today_workouts.length) {
    allWorkouts.push({ date: todayStr, sessions: wkRaw.today_workouts });
  }
  var workouts = byDate(allWorkouts, 'time');
  var expenses = byDate(loadDataFile('expenses'), 'time');
  var goals = byDate(loadDataFile('goals'), 'time');
  var calEvents = loadDataFile('calendar_events');
  var healthData = loadHealthData();

  // Build structured summary
  var lines = [];
  var i, j, e, d;

  // Water
  if (water.length) {
    var totalGlasses = 0;
    lines.push('[Water Intake — last ' + daysBack + ' days]');
    for (i = 0; i < water.length; i++) {
      e = water[i];
      totalGlasses += e.glasses;
      lines.push('  ' + e.date + ': ' + e.glasses + ' glasses');
    }
    lines.push('  Total: ' + totalGlasses + ' glasses over ' + water.length + ' day(s), avg ' + (totalGlasses / water.length).toFixed(1) + '/day');
  } else {
    lines.push('[Water Intake — last ' + daysBack + ' days]');
    lines.push('  No data logged');
  }
  lines.push('');

  // Workouts
  if (workouts.length) {
    var totalMin = 0, totalSessions = 0;
    lines.push('[Workouts — last ' + daysBack + ' days]');
    for (i = 0; i < workouts.length; i++) {
      e = workouts[i];
      for (j = 0; j < e.sessions.length; j++) {
        var s = e.sessions[j];
        var mins = Math.round(s.duration / 60);
        totalMin += mins;
        totalSessions++;
        lines.push('  ' + e.date + ': ' + s.type + ' ' + mins + 'min');
      }
    }
    lines.push('  Total: ' + totalSessions + ' session(s), ' + totalMin + ' min, avg ' + (totalMin / workouts.length).toFixed(0) + ' min/day');
  } else {
    lines.push('[Workouts — last ' + daysBack + ' days]');
    lines.push('  No data logged');
  }
  lines.push('');

  // Expenses
  if (expenses.length) {
    var totalSpent = 0, cats = {};
    lines.push('[Expenses — last ' + daysBack + ' days]');
    for (i = 0; i < expenses.length; i++) {
      e = expenses[i];
      totalSpent += e.amount;
      cats[e.cat] = (cats[e.cat] || 0) + e.amount;
      d = new Date(e.time).toLocaleDateString('en-CA');
      lines.push('  ' + d + ': $' + e.amount.toFixed(2) + ' (' + (e.desc || e.cat) + ')');
    }
    lines.push('  Total spent: $' + totalSpent.toFixed(2));
    lines.push('  By category: ' + Object.keys(cats).map(function(c) { return c + ': $' + cats[c].toFixed(2); }).join(', '));
  } else {
    lines.push('[Expenses — last ' + daysBack + ' days]');
    lines.push('  No data logged');
  }
  lines.push('');

  // Goals
  if (goals.length) {
    var totalGoals = 0, completedGoals = 0;
    lines.push('[Goals — last ' + daysBack + ' days]');
    for (i = 0; i < goals.length; i++) {
      e = goals[i];
      for (j = 0; j < e.items.length; j++) {
        var g = e.items[j];
        totalGoals++;
        if (g.done) completedGoals++;
        lines.push('  ' + e.date + ': "' + g.text + '" — ' + (g.done ? 'completed' : 'pending'));
      }
    }
    lines.push('  Total: ' + completedGoals + '/' + totalGoals + ' completed');
  } else {
    lines.push('[Goals — last ' + daysBack + ' days]');
    lines.push('  No data logged');
  }
  lines.push('');

  // Supplements
  var checked = healthData.checked_supplements || {};
  var totalSupps = 0, takenSupps = 0;
  if (typeof checked === 'object' && !Array.isArray(checked)) {
    totalSupps = Object.keys(checked).length;
    takenSupps = Object.values(checked).filter(Boolean).length;
  }
  lines.push('[Supplements — today]');
  if (totalSupps > 0) {
    lines.push('  ' + takenSupps + '/' + totalSupps + ' taken');
    Object.keys(checked).forEach(function(name) {
      lines.push('  - ' + name + ': ' + (checked[name] ? 'taken' : 'not taken'));
    });
  } else {
    lines.push('  No supplements configured');
  }
  lines.push('');

  // Calendar Events
  var upcoming = [];
  var nowMs = Date.now();
  var fourteenDays = 14 * 24 * 60 * 60 * 1000;
  if (calEvents && calEvents.length) {
    calEvents.forEach(function(ev) {
      if (ev.date) {
        var evTime = new Date(ev.date + 'T00:00:00').getTime();
        if (evTime >= nowMs - 86400000 && evTime <= nowMs + fourteenDays) {
          upcoming.push(ev);
        }
      }
    });
  }
  lines.push('[Calendar Events — next 14 days]');
  if (upcoming.length) {
    upcoming.forEach(function(ev) {
      lines.push('  ' + ev.date + ': ' + ev.title);
    });
  } else {
    lines.push('  No upcoming events');
  }

  return lines.join('\n');
}

const INSIGHTS_PROMPT = `You are Aura's daily brief engine. The user wants a QUICK snapshot — not a deep analysis.

FOCUS ON THESE 4 AREAS ONLY:
1. Workouts — did they train? streak status?
2. Supplements — how many taken vs total?
3. Events/Appointments — anything coming up?
4. Finance — spending trend this week?

STYLE RULES:
- 2-3 short sentences MAX, under 50 words total
- Bullet-point style if needed — no paragraphs
- Just facts + one action item: "Log your workout" / "3 supplements left today" / "Dentist at 2pm tomorrow"
- No fluff, no cross-domain analysis, no motivational speeches
- If all data is empty, one line: "Nothing logged yet — tap quick-log to start."
- Do NOT use emojis`;

async function generateInsights() {
  var apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return null;
  }

  var matrix = getHistoricalMatrix(7);

  try {
    var groqResp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        stream: false,
        messages: [
          { role: 'system', content: INSIGHTS_PROMPT },
          { role: 'user', content: 'Here is my 7-day tracking data matrix:\n\n' + matrix + '\n\nGenerate my quick daily brief.' }
        ],
        max_tokens: 150,
        temperature: 0.4,
      }),
    });

    if (!groqResp.ok) {
      console.error('Insights Groq error:', groqResp.status);
      return null;
    }

    var groqData = await groqResp.json();
    var text = groqData.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.error('Insights: empty response from Groq');
      return null;
    }

    var cache = {
      text: text,
      generatedAt: new Date().toISOString(),
      matrixSummary: matrix,
      daysCovered: 7,
    };
    fs.writeFileSync(INSIGHTS_CACHE, JSON.stringify(cache, null, 2));
    return cache;
  } catch (err) {
    console.error('Insights error:', err.message);
    return null;
  }
}

// GET /api/v1/insights/latest — returns cached insight, refreshes if stale
app.get('/api/v1/insights/latest', async function(req, res) {
  var cache = null;
  try { cache = JSON.parse(fs.readFileSync(INSIGHTS_CACHE, 'utf8')); } catch {}

  var stale = !cache || !cache.generatedAt ||
    (Date.now() - new Date(cache.generatedAt).getTime()) > INSIGHTS_TTL;

  if (stale) {
    cache = await generateInsights();
  }

  if (!cache) {
    return res.status(503).json({ error: 'Insights unavailable — check GROQ_API_KEY and data files' });
  }

  res.json(cache);
});

// POST /api/v1/insights/refresh — force regenerate (manual refresh)
app.post('/api/v1/insights/refresh', async function(req, res) {
  var cache = await generateInsights();
  if (!cache) {
    return res.status(503).json({ error: 'Insights generation failed' });
  }
  res.json(cache);
});

// Auto-refresh insights every 12 hours
cron.schedule('0 */12 * * *', function() { generateInsights(); }, { timezone: 'America/New_York' });

/* ════════════ WORKOUT DATA ENDPOINTS ════════════ */

// GET /api/v1/workouts — returns structured workout data with streak
app.get('/api/v1/workouts', (req, res) => {
  const wkData = loadWorkoutData();
  res.json(wkData);
});

// POST /api/v1/workouts — log a workout session to server (also clears active session)
app.post('/api/v1/workouts', express.json(), (req, res) => {
  const { type, duration_minutes } = req.body;
  if (!type || typeof type !== 'string') {
    return res.status(400).json({ error: 'type is required' });
  }
  const secs = Math.max(60, (duration_minutes || 1) * 60);
  const wkData = loadWorkoutData();
  const now = Date.now();
  wkData.today_workouts.push({ type, duration: secs, time: now });
  wkData.streak_count = computeServerStreak(wkData);
  saveWorkoutData(wkData);
  // Clear any active workout session
  const sessions = loadActiveSessions();
  if (sessions.workout) { sessions.workout = null; saveActiveSessions(sessions); }
  res.json({ ok: true, streak: wkData.streak_count });
});

// Midnight rollover: archive today's workouts to history, recompute streak
cron.schedule('55 23 * * *', function() {
  try {
    const wkData = loadWorkoutData();
    const todayStr = userDateStr('America/New_York');
    if (wkData.today_workouts && wkData.today_workouts.length) {
      wkData.history.push({ date: todayStr, sessions: wkData.today_workouts });
    }
    wkData.streak_count = computeServerStreak(wkData);
    wkData.today_workouts = [];
    saveWorkoutData(wkData);
    console.log('Workout midnight rollover complete. Streak:', wkData.streak_count);
  } catch (err) {
    console.error('Workout rollover error:', err.message);
  }
}, { timezone: 'America/New_York' });

/* ════════════ HEALTH / SUPPLEMENT ENDPOINTS ════════════ */

function loadHealthData() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('health'), 'utf8'));
  } catch {
    return { checked_supplements: [] };
  }
}
function saveHealthData(data) {
  fs.writeFileSync(dataFilePath('health'), JSON.stringify(data, null, 2));
}

// GET /api/v1/health/supplements — returns today's checked supplement state from server
app.get('/api/v1/health/supplements', (req, res) => {
  const health = loadHealthData();
  res.json({ checked_supplements: health.checked_supplements || {} });
});

// POST /api/v1/health/supplements — updates checked supplements on server
app.post('/api/v1/health/supplements', express.json(), (req, res) => {
  const { checked_supplements } = req.body;
  if (!checked_supplements || typeof checked_supplements !== 'object') {
    return res.status(400).json({ error: 'checked_supplements must be an object' });
  }
  const health = loadHealthData();
  health.checked_supplements = checked_supplements;
  saveHealthData(health);
  res.json({ ok: true });
});

/* ════════════ SCHEDULED BRIEFINGS ════════════ */

function buildBriefingMsg(ctx, timeOfDay) {
  // Build the same rich system prompt used in the interactive chat
  let msg = buildSystemMsg(ctx);

  // Add briefing-specific framing
  if (timeOfDay === 'morning') {
    msg += 'BRIEFING INSTRUCTION:\n';
    msg += 'Write a short morning briefing (2-3 sentences, under 280 characters) for a push notification.\n';
    msg += '- Give a quick snapshot of today based on the data above.\n';
    msg += '- Mention specific numbers (water goal, workout streak, calendar events today, supplements to take).\n';
    msg += '- Motivate the user to start strong.\n';
  } else if (timeOfDay === 'midday') {
    msg += 'BRIEFING INSTRUCTION:\n';
    msg += 'Write a short midday check-in (1-2 sentences, under 200 characters) for a push notification.\n';
    msg += '- Remind the user what they still need to do today (water, supplements, workout).\n';
    msg += '- Keep it encouraging and brief — a quick nudge to stay on track.\n';
  } else {
    msg += 'BRIEFING INSTRUCTION:\n';
    msg += 'Write a short evening briefing (2-3 sentences, under 280 characters) for a push notification.\n';
    msg += '- Summarize what was accomplished today based on the data above.\n';
    msg += '- Mention what was left undone (incomplete supplements, missed workout, water under goal).\n';
    msg += '- Give a gentle nudge for anything incomplete and a motivational sign-off.\n';
  }

  msg += '\n\nADDITIONAL RULES:\n';
  msg += '- Do NOT use emojis.\n';
  msg += '- Do NOT include a greeting prefix like "Good morning" — just start the message.\n';
  msg += '- Keep it punchy and specific — this shows on a lock screen.\n';

  return msg;
}

async function sendBriefing(timeOfDay) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return;
  }

  const subs = loadSubscriptions();
  if (!subs.length) {
    return;
  }

  const ctx = loadUserContext();
  if (!ctx) {
    return;
  }

  try {
    const systemMsg = buildBriefingMsg(ctx, timeOfDay);

    // Call Groq for a short briefing
    const groqResp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        stream: false,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: `Generate my ${timeOfDay} briefing now based on my current data.` }
        ],
        max_tokens: 200,
      }),
    });

    if (!groqResp.ok) {
      console.error('Briefing Groq error:', groqResp.status);
      return;
    }

    const groqData = await groqResp.json();
    const briefing = groqData.choices?.[0]?.message?.content?.trim();
    if (!briefing) {
      console.error('Briefing: empty response from Groq');
      return;
    }

    // Push to all subscribers
    const payload = JSON.stringify({ title: `Aura ${timeOfDay === 'morning' ? 'Morning' : 'Evening'} Briefing`, body: briefing });
    let sent = 0, failed = 0;
    const alive = [];

    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
        alive.push(sub);
      } catch (err) {
        failed++;
        if (err.statusCode !== 410) alive.push(sub);
        console.error('Push error:', err.statusCode || err.message);
      }
    }

    if (alive.length !== subs.length) {
      saveSubscriptions(alive);
    }
  } catch (err) {
    console.error('Briefing error:', err.message);
  }
}

// Morning briefing at 7:00 AM
cron.schedule('0 7 * * *', () => sendBriefing('morning'), { timezone: 'America/New_York' });
// Midday check-in at 12:00 PM
cron.schedule('0 12 * * *', () => sendBriefing('midday'), { timezone: 'America/New_York' });
// Evening briefing at 9:00 PM
cron.schedule('0 21 * * *', () => sendBriefing('evening'), { timezone: 'America/New_York' });

/* ════════════ ACTIVE SESSION HELPERS ════════════ */

function loadActiveSessions() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('active_sessions'), 'utf8'));
  } catch {
    return { workout: null, deepwork: null };
  }
}

function saveActiveSessions(data) {
  fs.writeFileSync(dataFilePath('active_sessions'), JSON.stringify(data, null, 2));
}

// GET /api/v1/active-sessions — check all running sessions
app.get('/api/v1/active-sessions', (req, res) => {
  res.json(loadActiveSessions());
});

// POST /api/v1/active-sessions — set an active session for a type
app.post('/api/v1/active-sessions', (req, res) => {
  const { type } = req.body;
  if (!type || !['workout', 'deepwork'].includes(type)) {
    return res.status(400).json({ error: 'type must be workout or deepwork' });
  }
  const sessions = loadActiveSessions();
  sessions[type] = {
    session_start_time: req.body.session_start_time || Date.now(),
    target_duration_minutes: req.body.target_duration_minutes || null,
    meta: req.body.meta || null,
  };
  saveActiveSessions(sessions);
  res.json({ ok: true });
});

// DELETE /api/v1/active-sessions/:type — clear an active session
app.delete('/api/v1/active-sessions/:type', (req, res) => {
  const type = req.params.type;
  if (!['workout', 'deepwork'].includes(type)) {
    return res.status(400).json({ error: 'type must be workout or deepwork' });
  }
  const sessions = loadActiveSessions();
  sessions[type] = null;
  saveActiveSessions(sessions);
  res.json({ ok: true });
});

/* ════════════ SERVER START ════════════ */
app.listen(PORT, () => {
  console.log(`Aura server running on port ${PORT} | TZ=${process.env.TZ || 'system'}`);
});
