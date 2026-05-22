require('dotenv').config();
process.env.TZ = 'America/New_York';
const express = require('express');
const ical = require('node-ical');
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
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// In-memory cache keyed by ICS URL
const cache = new Map();

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

app.get('/api/calendar', async (req, res) => {
  const icsUrl = req.query.url;
  if (!icsUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter (Google Calendar ICS URL)' });
  }

  // Check cache
  const cached = cache.get(icsUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return res.json({ events: cached.events, cachedAt: cached.fetchedAt });
  }

  try {
    const data = await new Promise((resolve, reject) => {
      ical.fromURL(icsUrl, {}, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });

    // Window: this Monday through next Sunday (14 days)
    const now = new Date();
    const windowStart = new Date(now);
    const dow = windowStart.getDay(); // 0=Sun
    windowStart.setDate(windowStart.getDate() - ((dow + 6) % 7)); // Monday
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 27); // 4 weeks
    windowEnd.setHours(23, 59, 59, 999);

    const events = [];

    for (const key in data) {
      const event = data[key];
      if (event.type !== 'VEVENT') continue;

      const title = event.summary || '(No title)';

      if (event.rrule) {
        const startDate = new Date(event.start);
        const endDate = new Date(event.end);
        const duration = endDate - startDate;

        const occurrences = event.rrule.between(windowStart, windowEnd, true);
        for (const occ of occurrences) {
          const occStart = new Date(occ);
          const occEnd = new Date(occStart.getTime() + duration);
          events.push({
            id: (event.uid || key) + '-' + occStart.toISOString(),
            title,
            start: occStart.toISOString(),
            end: occEnd.toISOString(),
            allDay: event.datetype === 'date',
          });
        }
      } else {
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (end >= windowStart && start <= windowEnd) {
          events.push({
            id: event.uid || key,
            title,
            start: start.toISOString(),
            end: end.toISOString(),
            allDay: event.datetype === 'date',
          });
        }
      }
    }

    // Sort by start time (numeric timestamp for timezone-safe ordering)
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    // Update cache
    cache.set(icsUrl, { events, fetchedAt: Date.now() });

    res.json({ events, cachedAt: Date.now() });
  } catch (err) {
    console.error('Calendar fetch error:', err.message);
    // Return cached data if available, even if stale
    if (cached) {
      return res.json({ events: cached.events, cachedAt: cached.fetchedAt, stale: true });
    }
    res.status(502).json({ error: 'Failed to fetch calendar: ' + err.message });
  }
});

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
  }
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
          { role: 'system', content: VOICE_SYSTEM_PROMPT + '\n\nThe user\'s current local date, time, and timezone profile is: ' + dateStr + ' at ' + new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }) + ' (' + dayName + ') (' + tz + '). Interpret relative terms like "today", "tomorrow", "tonight", or "3 PM" strictly matching this specific geographic timeline context.' },
          { role: 'user', content: text }
        ],
        max_tokens: 300,
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
        date: payload.calendar_details.target_date || dateStr,
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

/* ════════════ USER CALENDAR EVENTS ════════════ */

app.get('/api/v1/calendar-events', (req, res) => {
  const events = loadDataFile('calendar_events');
  res.json({ events: events });
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

  return lines.join('\n');
}

const INSIGHTS_PROMPT = `You are Aura's analytical engine. You receive a 7-day cross-domain health, fitness, financial, and goal-tracking data matrix for a single user.

YOUR JOB: Find cross-domain correlations and produce a brief personalized insight.

CROSS-DOMAIN PATTERNS TO LOOK FOR:
- Hydration levels vs workout performance (did more water correlate with longer sessions?)
- Financial spending patterns vs goal completion (high-spend days vs productivity)
- Workout consistency vs goal completion rates
- Days with multiple metrics logged vs days with gaps
- Weekend vs weekday patterns across all domains

STYLE RULES:
- Be supportive yet direct — no fluff, no filler
- Highly personalized — reference the user's actual numbers
- EXACTLY 3 sentences maximum
- Sentence 1: State the strongest cross-domain pattern you found (or acknowledge if data is too sparse)
- Sentence 2: Provide a specific, data-backed observation
- Sentence 3: End with ONE clear, actionable goal for tomorrow
- Do NOT use emojis
- Do NOT greet the user — just deliver the insight
- If data is empty or only one domain has entries, say so honestly and suggest logging more metrics`;

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
          { role: 'user', content: 'Here is my 7-day tracking data matrix:\n\n' + matrix + '\n\nGenerate my cross-domain insight.' }
        ],
        max_tokens: 300,
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
  res.json({ checked_supplements: health.checked_supplements || [] });
});

// POST /api/v1/health/supplements — updates checked supplements on server
app.post('/api/v1/health/supplements', express.json(), (req, res) => {
  const { checked_supplements } = req.body;
  if (!Array.isArray(checked_supplements)) {
    return res.status(400).json({ error: 'checked_supplements must be an array' });
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

/* ════════════ SERVER START ════════════ */
app.listen(PORT, () => {
  console.log(`Aura server running on port ${PORT} | TZ=${process.env.TZ || 'system'}`);
});
