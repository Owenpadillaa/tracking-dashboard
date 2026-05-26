require('dotenv').config();
process.env.TZ = 'America/Los_Angeles';
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
      const todayStr = userDateStr('America/Los_Angeles');
      let today_workouts = [];
      for (const entry of raw) {
        if (entry.date === todayStr) {
          today_workouts = today_workouts.concat(entry.sessions || []);
  } else if (timeOfDay === 'night' || timeOfDay === 'evening') {
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
    datesWithWorkouts.add(userDateStr('America/Los_Angeles'));
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
  const todayStr = userDateStr('America/Los_Angeles');
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
let msg = `ROLE CRITICAL DIRECTIVE: You are a data-driven scheduling assistant. You must communicate EXCLUSIVELY in English.

REASONING & FORMATTING MANDATE: When the user requests a scheduling action (e.g., 'Study calc'), you must provide a concise, data-driven 2-sentence explanation in English outlining exactly WHY you selected those times based on their upcoming calendar gaps, class structures, or peak focus habits.

Immediately following your text explanation, you must append an independent, valid JSON block wrapped in opening and closing [PROPOSED_ACTION] tags for EACH proposed option slot.

CRITICAL: Do not let any conversational text mix inside the [PROPOSED_ACTION] tags. Keep the data payload entirely pure so the frontend can strip it from view.

Example Output Structure:
I am proposing Tuesday morning and Wednesday afternoon because those are your largest available blocks before Friday's exam, matching your high-focus deep work habits.
[PROPOSED_ACTION]{'type':'SCHEDULE_EVENT','title':'Calculus Study Session','date':'2026-05-26','time':'09:00'}[PROPOSED_ACTION]
[PROPOSED_ACTION]{'type':'SCHEDULE_EVENT','title':'Calculus Study Session','date':'2026-05-27','time':'14:00'}[PROPOSED_ACTION]

`;

  if (ctx.currentDate) {
    msg += `Today's date: ${ctx.currentDate}. Use this to anchor all "today"/"tomorrow"/"this week" references.\n\n`;
  }

  msg += 'CRITICAL RULES:\n';
  msg += '- ONLY reference data provided below. Never invent, guess, or fabricate numbers.\n';
  msg += '- If a stat is 0 or empty, the user has NOT logged data yet. Say so honestly and encourage them to log it.\n';
  msg += '- Never pretend the user did something when the data shows 0 sessions, 0 glasses, etc.\n';
  msg += '- Reference specific numbers when they are non-zero. When zero, be honest about it.\n';
  msg += '- CRITICAL DATA RULE: You must only report numbers from the user data below. If a count is 0 or a list is empty, report exactly that — never invent numbers. If water shows "0 units out of 8", say zero. If supplements show "0 out of 5", say zero. Never assume or guess.\n\n';

  msg += 'AUTONOMOUS SCHEDULING RULES:\n';
  msg += '- If the user implies or states an intention to schedule an event, set up a block, make an appointment, or book something on the calendar, you MUST include a [PROPOSED_ACTION] block at the very end of your response.\n';
  msg += '- The [PROPOSED_ACTION] block must use EXACTLY this format on its own lines:\n';
  msg += '  [PROPOSED_ACTION]\n';
  msg += '  {"type":"SCHEDULE_EVENT","title":"Event Title Here","date":"YYYY-MM-DD","time":"HH:MM"}\n';
  msg += '  [/PROPOSED_ACTION]\n';
  msg += '- The "date" field must be YYYY-MM-DD format. The "time" field must be HH:MM in 24-hour format (e.g., "14:30" for 2:30pm).\n';
  msg += '- If the user does not specify a time, use "09:00" as the default. If the user does not specify a date, use today\'s date.\n';
  msg += '- Only include [PROPOSED_ACTION] when the user clearly intends to schedule something. Do NOT include it for casual mentions or hypotheticals.\n';
  msg += '- The [PROPOSED_ACTION] block must be the VERY LAST thing in your response — after all other text.\n\n';

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
    msg += `\nWORKOUT STREAK GUIDELINES:\n`;
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
  const auraContext = await getAuraSystemContext();
  const systemMsg = buildSystemMsg(context) + '\n\n=== LIVE USER TELEMETRY ===\nThe following is the user\'s actual live data snapshot. Use these exact numbers in your responses:\n\n' + auraContext + '\n\n=== 🚨 MANDATORY OUTPUT FORMAT — READ THIS LAST 🚨 ===\n\nWhen the user wants to schedule, study, log, plan, or book ANYTHING, you MUST propose each option with a SEPARATE, INDEPENDENT [PROPOSED_ACTION] block. Output your brief English intent statement first (under 15 words), then append each [PROPOSED_ACTION] block on its own — no other text after the final [PROPOSED_ACTION].\n\n[PROPOSED_ACTION]\n{"type":"SCHEDULE_EVENT","title":"Event Title","date":"YYYY-MM-DD","time":"HH:MM"}\n[PROPOSED_ACTION]\n\nABSOLUTE RULES:\n- You may output MULTIPLE [PROPOSED_ACTION] blocks — each must be self-contained and independent.\n- After your brief English intent statement, append ALL [PROPOSED_ACTION] blocks. No text, emojis, or sign-offs after the final closing [PROPOSED_ACTION] tag. Period.\n- CRITICAL: use ONLY double-quotes for JSON keys/values (example: "type":"SCHEDULE_EVENT"). Single quotes will BREAK the parser.\n- NEVER wrap the JSON inside markdown code fences (no \`\`\`json, no \`\`\`). Output it RAW on its own lines.\n- Compute dates relative to today. If today is Wednesday and user says "Friday", use that Friday\'s YYYY-MM-DD.\n- "type" is always "SCHEDULE_EVENT". Default "time" to "09:00" if not specified.\n- NEVER discuss water targets, workout streaks, or financial statuses in your response — only output the scheduling intent and action blocks.\n- If you fail to include this block when the user intends to schedule, you have FAILED the task.\n';

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
/* ════════════ AI PULSE SCHEDULE CONFIG ════════════ */
function loadPulseConfig() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('notification_config'), 'utf8'));
  } catch {
    return { morning: '06:00', midday: '12:00', night: '21:00' };
  }
}
function savePulseConfig(config) {
  fs.writeFileSync(dataFilePath('notification_config'), JSON.stringify(config, null, 2));
}

app.post('/api/v1/settings/notifications', express.json(), (req, res) => {
  const { morning, midday, night } = req.body;
  if (!morning || !midday || !night) {
    return res.status(400).json({ error: 'All three pulse times required' });
  }
  savePulseConfig({ morning, midday, night });
  console.log(`Pulse config updated: M=${morning} D=${midday} N=${night}`);
  res.json({ ok: true });
});

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

// GET /api/v1/finance/savings — read savings goal with computed advice
app.get('/api/v1/finance/savings', (req, res) => {
  const finance = loadFinanceData();
  const savings = finance.savings || { target: 0, current: 0, title: 'Savings Goal' };
  const income = finance.income || {};
  const monthlyIncome = getMonthlyAmount(income);
  const remaining = Math.max(0, (savings.target || 0) - (savings.current || 0));
  let suggestedMonthly = 0;
  let monthsRemaining = 0;
  let suggestedPct = 0;
  if (savings.deadline && remaining > 0) {
    const now = new Date();
    const deadline = new Date(savings.deadline);
    if (deadline > now) {
      monthsRemaining = Math.max(1, (deadline - now) / (1000 * 60 * 60 * 24 * 30.44));
      suggestedMonthly = remaining / monthsRemaining;
    }
  }
  if (monthlyIncome > 0 && suggestedMonthly > 0) {
    suggestedPct = Math.round((suggestedMonthly / monthlyIncome) * 100);
  }
  res.json({ ...savings, suggestedMonthly: Math.round(suggestedMonthly * 100) / 100, suggestedPct, monthsRemaining: Math.ceil(monthsRemaining), monthlyIncome: Math.round(monthlyIncome) });
});

// POST /api/v1/finance/savings — update savings goal or contribute
app.post('/api/v1/finance/savings', (req, res) => {
  const { target, current, title, action, deadline } = req.body;
  if (target === undefined && current === undefined && !title && !action && deadline === undefined) {
    return res.status(400).json({ error: 'Provide target, current, title, deadline, or action' });
  }
  const finance = loadFinanceData();
  if (!finance.savings) {
    finance.savings = { target: 0, current: 0, title: 'Savings Goal' };
  }
  if (target !== undefined) finance.savings.target = parseFloat(target);
  if (current !== undefined) finance.savings.current = parseFloat(current);
  if (title !== undefined) finance.savings.title = String(title).trim();
  if (deadline !== undefined) finance.savings.deadline = deadline || null;
  if (action === 'contribute' && req.body.amount) {
    const amt = parseFloat(req.body.amount);
    finance.savings.current = (finance.savings.current || 0) + amt;
    if (!Array.isArray(finance.savings.contributions)) finance.savings.contributions = [];
    finance.savings.contributions.push({ id: Date.now(), amount: amt, timestamp: Date.now() });
  }
  finance.savings.updatedAt = Date.now();
  saveDataFile('finance', finance);
  res.json({ ok: true, savings: finance.savings });
});

// DELETE /api/v1/finance/savings/contribution/:id — undo a contribution
app.delete('/api/v1/finance/savings/contribution/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Missing contribution id' });
  const finance = loadFinanceData();
  const contribs = finance.savings?.contributions;
  if (!Array.isArray(contribs)) return res.status(404).json({ error: 'No contributions found' });
  const idx = contribs.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Contribution not found' });
  const removed = contribs.splice(idx, 1)[0];
  finance.savings.current = Math.max(0, (finance.savings.current || 0) - removed.amount);
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


/* ════════════ QUICK-LOG — SERVER-SIDE PERSISTENCE ════════════ */

app.post('/api/v1/quick-log', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid payload' });
  }

  const dateStr = userDateStr(payload.user_timezone || 'America/Los_Angeles');
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

// POST /api/v1/calendar/delete — remove an event by id
app.post('/api/v1/calendar/delete', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }
  let events = loadDataFile('calendar_events');
  const lenBefore = events.length;
  events = events.filter(e => e.id !== id);
  if (events.length === lenBefore) {
    return res.status(404).json({ error: 'event not found' });
  }
  saveDataFile('calendar_events', events);
  res.json({ ok: true });
});

// ─── Calendar Overlap Detection ───
// Compare incoming event against existing events. Default duration: 1h.
// Uses startA < endB && endA > startB overlap check.
function checkForConflicts(incoming, existingEvents, defaultDurationMin) {
  defaultDurationMin = defaultDurationMin || 60;
  var inStart = parseTimeToMinutes(incoming.date, incoming.time || '09:00');
  var inEnd = inStart + defaultDurationMin;
  var conflicts = [];
  for (var i = 0; i < existingEvents.length; i++) {
    var ev = existingEvents[i];
    if (ev.date !== incoming.date) continue;
    var evStart = parseTimeToMinutes(ev.date, ev.time || '09:00');
    var evEnd = evStart + (ev.duration_min || 60);
    if (inStart < evEnd && inEnd > evStart) {
      conflicts.push(ev);
    }
  }
  return conflicts;
}

// Parse date+time into absolute minutes since epoch for comparison
function parseTimeToMinutes(dateStr, timeStr) {
  var d = new Date(dateStr + 'T' + (timeStr || '00:00') + ':00');
  var mins = d.getTime() / 60000; // minutes since epoch
  if (isNaN(mins)) return 0; // fallback for malformed dates
  return mins;
}

// Scan the upcoming week for the next open 2-hour window (default 120 min).
// Returns { date, time } of the first available slot, or null.
function findNextOpenWindow(existingEvents, requiredMin, startDate) {
  requiredMin = requiredMin || 120;
  var scanDate = startDate ? new Date(startDate + 'T00:00:00') : new Date();
  var tz = 'America/Los_Angeles';
  var maxDays = 14; // search up to 2 weeks out
  
  for (var day = 0; day < maxDays; day++) {
    var ds = scanDate.getFullYear() + '-' + 
      String(scanDate.getMonth() + 1).padStart(2, '0') + '-' + 
      String(scanDate.getDate()).padStart(2, '0');
    
    // Get events for this day, sorted by time
    var dayEvents = existingEvents
      .filter(function(e) { return e.date === ds && e.time; })
      .sort(function(a, b) { return (a.time || '').localeCompare(b.time || ''); });
    
    // Build busy intervals for this day
    var busy = [];
    for (var i = 0; i < dayEvents.length; i++) {
      var ev = dayEvents[i];
      var evStart = parseHM(ev.time);
      var evEnd = evStart + (ev.duration_min || 60);
      busy.push([evStart, evEnd]);
    }
    // Merge overlapping busy intervals
    busy.sort(function(a, b) { return a[0] - b[0]; });
    var merged = [];
    for (var i = 0; i < busy.length; i++) {
      if (merged.length === 0 || busy[i][0] > merged[merged.length - 1][1]) {
        merged.push(busy[i].slice());
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], busy[i][1]);
      }
    }
    
    // Search for an open window from 06:00 to 22:00
    var dayStart = 6 * 60;  // 6:00 AM
    var dayEnd = 22 * 60;   // 10:00 PM
    var cursor = dayStart;
    
    for (var i = 0; i < merged.length; i++) {
      var gap = merged[i][0] - cursor;
      if (gap >= requiredMin) {
        var h = Math.floor(cursor / 60);
        var m = cursor % 60;
        return {
          date: ds,
          time: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
        };
      }
      cursor = Math.max(cursor, merged[i][1]);
    }
    // Check after last busy interval
    if (dayEnd - cursor >= requiredMin) {
      var h = Math.floor(cursor / 60);
      var m = cursor % 60;
      return {
        date: ds,
        time: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
      };
    }
    
    // Advance to next day
    scanDate.setDate(scanDate.getDate() + 1);
  }
  return null; // no window found in search range
}

function parseHM(timeStr) {
  var parts = (timeStr || '09:00').split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// POST /api/v1/calendar/add — append a new event with conflict detection
app.post('/api/v1/calendar/add', async (req, res) => {
  const { title, date, time } = req.body;
  if (!title || !date) {
    return res.status(400).json({ error: 'title and date are required' });
  }
  const events = loadDataFile('calendar_events');
  
  // Check for overlapping events before writing
  const incoming = { title: String(title).trim(), date: date, time: time || '09:00' };
  const conflicts = checkForConflicts(incoming, events, 60);
  
  if (conflicts.length > 0) {
    // Found conflicts — find alternative window and generate reschedule suggestion
    var altWindow = findNextOpenWindow(events, 120, date);
    
    // Build collision summary for Llama
    var conflictLines = conflicts.map(function(c) {
      return '- ' + c.title + ' on ' + c.date + ' @ ' + (c.time || 'N/A');
    }).join('\n');
    
    var altDesc = altWindow ? 
      altWindow.date + ' at ' + altWindow.time : 
      'No open 2-hour window found in the next 14 days';
    
    // Use Llama to generate a conversational RESCHEDULE_EVENT block
    var reschedulePayload = null;
    var apiKey = process.env.GROQ_API_KEY;
    if (apiKey && altWindow) {
      try {
        var prompt = 'You are a scheduling assistant. A calendar conflict was detected.\n\n' +
          'Requested event: "' + incoming.title + '" on ' + incoming.date + ' at ' + (incoming.time || '09:00') + '\n' +
          'Conflicting events:\n' + conflictLines + '\n\n' +
          'Suggested alternative window: ' + altWindow.date + ' at ' + altWindow.time + ' (2-hour block)\n\n' +
          'Output ONLY a JSON object with no markdown wrapping. The JSON must have these exact fields:\n' +
          '{"type":"RESCHEDULE_EVENT","title":"Event Title","date":"YYYY-MM-DD","time":"HH:MM","message":"Brief 1-sentence explanation of the conflict and proposed reschedule"}\n\n' +
          'Set "title" to the original event title, "date" and "time" to the suggested alternative window. Keep "message" under 140 chars.';
        
        var groqResp = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 200,
            temperature: 0.3
          })
        });
        
        if (groqResp.ok) {
          var data = await groqResp.json();
          var content = (data.choices[0].message.content || '').trim();
          content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          try { reschedulePayload = JSON.parse(content); } catch(e) {
            // Fallback: build payload from altWindow
            reschedulePayload = {
              type: 'RESCHEDULE_EVENT',
              title: incoming.title,
              date: altWindow.date,
              time: altWindow.time,
              message: 'Conflict with "' + conflicts[0].title + '". Suggested alternative: ' + altWindow.date + ' at ' + altWindow.time
            };
          }
        } else {
          // Groq failed — build fallback
          reschedulePayload = {
            type: 'RESCHEDULE_EVENT',
            title: incoming.title,
            date: altWindow.date,
            time: altWindow.time,
            message: 'Conflict with "' + conflicts[0].title + '". Suggested alternative: ' + altWindow.date + ' at ' + altWindow.time
          };
        }
      } catch(e) {
        console.error('Reschedule Llama error:', e.message);
        reschedulePayload = {
          type: 'RESCHEDULE_EVENT',
          title: incoming.title,
          date: altWindow.date,
          time: altWindow.time,
          message: 'Conflict with "' + conflicts[0].title + '". Suggested alternative: ' + altWindow.date + ' at ' + altWindow.time
        };
      }
    } else if (altWindow) {
      // No API key — use fallback
      reschedulePayload = {
        type: 'RESCHEDULE_EVENT',
        title: incoming.title,
        date: altWindow.date,
        time: altWindow.time,
        message: 'Conflict with "' + conflicts[0].title + '". Suggested alternative: ' + altWindow.date + ' at ' + altWindow.time
      };
    }
    
    return res.json({
      conflict: true,
      conflicts: conflicts.map(function(c) { return { id: c.id, title: c.title, date: c.date, time: c.time }; }),
      incoming: incoming,
      reschedule: reschedulePayload
    });
  }
  
  // No conflict — write normally
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

// POST /api/v1/calendar/reschedule — atomic swap: remove conflicting event, add rescheduled event
app.post('/api/v1/calendar/reschedule', (req, res) => {
  const { conflictId, title, date, time } = req.body;
  if (!conflictId || !title || !date) {
    return res.status(400).json({ error: 'conflictId, title, and date are required' });
  }
  
  var events = loadDataFile('calendar_events');
  
  // Verify conflict event still exists
  var conflictIdx = -1;
  for (var i = 0; i < events.length; i++) {
    if (events[i].id === conflictId) { conflictIdx = i; break; }
  }
  
  if (conflictIdx === -1) {
    return res.status(404).json({ error: 'Conflict event no longer exists' });
  }
  
  // Snapshot for rollback
  var snapshot = events.slice();
  
  try {
    // Atomic: remove conflict + add new event in single write
    var removed = events.splice(conflictIdx, 1)[0];
    var newEv = {
      id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: String(title).trim(),
      date: date,
      time: time || null,
      createdAt: Date.now(),
      rescheduledFrom: removed.id
    };
    events.push(newEv);
    saveDataFile('calendar_events', events);
    
    res.json({ 
      ok: true, 
      removed: { id: removed.id, title: removed.title, date: removed.date, time: removed.time },
      created: newEv 
    });
  } catch (err) {
    // Rollback
    saveDataFile('calendar_events', snapshot);
    console.error('Reschedule error:', err.message);
    res.status(500).json({ error: 'Reschedule failed, rolled back' });
  }
});

/* ════════════ INSIGHTS ENGINE ════════════ */

// Cache freshness: 12 hours in ms
const INSIGHTS_TTL = 12 * 60 * 60 * 1000;

/* ─── CROSS-DATA HABIT CORRELATOR ─── */
// Reads health.json, workout.json, and deepwork.json simultaneously.
// Groups by date over the past 14 entries, calculates if high focus tracking
// scores mathematically align with positive hydration markers or active workout flags.
function calculateHabitCorrelations() {
  var tz = 'America/Los_Angeles';
  var todayStr = userDateStr(tz);
  var results = [];
  
  try {
    // ── Gather datasets ──
    var waterData = loadDataFile('water');
    var wkData = loadWorkoutData();
    var deepworkData = loadDataFile('deepwork');
    
    // Build date-keyed maps for the last 14 days
    var dateMap = {};
    var now = new Date();
    for (var d = 0; d < 14; d++) {
      var check = new Date(now);
      check.setDate(check.getDate() - d);
      var ds = check.getFullYear() + '-' + 
        String(check.getMonth() + 1).padStart(2, '0') + '-' + 
        String(check.getDate()).padStart(2, '0');
      dateMap[ds] = { water: 0, workouts: 0, workoutMin: 0, deepwork: 0, deepworkMin: 0 };
    }
    
    // ── Water: glasses per day ──
    if (waterData && waterData.length) {
      for (var i = 0; i < waterData.length; i++) {
        var w = waterData[i];
        if (dateMap[w.date] !== undefined) {
          dateMap[w.date].water = (w.glasses || 0) * 8; // convert glasses to oz
        }
      }
    }
    
    // ── Workouts: presence + minutes per day ──
    var allWorkouts = (wkData.history || []).slice();
    if (wkData.today_workouts && wkData.today_workouts.length) {
      allWorkouts.push({ date: todayStr, sessions: wkData.today_workouts });
    }
    for (var i = 0; i < allWorkouts.length; i++) {
      var entry = allWorkouts[i];
      if (dateMap[entry.date] !== undefined && entry.sessions) {
        dateMap[entry.date].workouts = entry.sessions.length;
        for (var j = 0; j < entry.sessions.length; j++) {
          dateMap[entry.date].workoutMin += Math.round((entry.sessions[j].duration || 0) / 60);
        }
      }
    }
    
    // ── Deep Work: sessions + minutes per day ──
    var dwArr = Array.isArray(deepworkData) ? deepworkData : [];
    for (var i = 0; i < dwArr.length; i++) {
      var dw = dwArr[i];
      if (dateMap[dw.date] !== undefined) {
        dateMap[dw.date].deepwork++;
        dateMap[dw.date].deepworkMin += (dw.duration || 0);
      }
    }
    
    // ── Compute correlations ──
    // Split days into: workout days vs non-workout days; high-water days (>64oz) vs low-water days
    var workoutDays = [];
    var noWorkoutDays = [];
    var highWaterDays = [];
    var lowWaterDays = [];
    var dates = Object.keys(dateMap).sort();
    
    for (var i = 0; i < dates.length; i++) {
      var day = dateMap[dates[i]];
      if (day.workouts > 0) {
        workoutDays.push(day);
      } else {
        noWorkoutDays.push(day);
      }
      if (day.water > 64) {
        highWaterDays.push(day);
      } else {
        lowWaterDays.push(day);
      }
    }
    
    function avg(arr, field) {
      if (!arr.length) return 0;
      var sum = 0;
      for (var i = 0; i < arr.length; i++) { sum += arr[i][field]; }
      return sum / arr.length;
    }
    
    // Build correlation strings
    if (workoutDays.length > 0 && noWorkoutDays.length > 0) {
      results.push('## Cross-Data Correlations (last 14 days)');
      results.push('- Workout days (' + workoutDays.length + '): avg water ' + avg(workoutDays, 'water').toFixed(0) + 'oz, deep work ' + avg(workoutDays, 'deepworkMin').toFixed(0) + 'min');
      results.push('- Rest days (' + noWorkoutDays.length + '): avg water ' + avg(noWorkoutDays, 'water').toFixed(0) + 'oz, deep work ' + avg(noWorkoutDays, 'deepworkMin').toFixed(0) + 'min');
    }
    
    if (highWaterDays.length > 0 && lowWaterDays.length > 0) {
      if (!results.length) results.push('## Cross-Data Correlations (last 14 days)');
      results.push('- High-hydration days (>64oz, ' + highWaterDays.length + '): avg deep work ' + avg(highWaterDays, 'deepworkMin').toFixed(0) + 'min, workout ' + avg(highWaterDays, 'workoutMin').toFixed(0) + 'min');
      results.push('- Low-hydration days (≤64oz, ' + lowWaterDays.length + '): avg deep work ' + avg(lowWaterDays, 'deepworkMin').toFixed(0) + 'min, workout ' + avg(lowWaterDays, 'workoutMin').toFixed(0) + 'min');
    }
    
    if (results.length === 0) {
      results.push('## Cross-Data Correlations (last 14 days)');
      results.push('- Insufficient data for trend analysis');
    }
  } catch (_) {
    results.push('## Cross-Data Correlations (last 14 days)');
    results.push('- (unavailable)');
  }
  
  return results.join('\n');
}

/* ─── AURA SYSTEM CONTEXT AGGREGATOR ─── */
// Bundles all tracking data into a compact markdown snapshot for LLM system prompts.
// Reads from: calendar_events, health, water, finance, workouts, deepwork data files.
async function getAuraSystemContext() {
  const tz = 'America/Los_Angeles';
  const todayStr = userDateStr(tz);
  const parts = [];

  // ── Calendar (upcoming events) ──
  try {
    const events = loadDataFile('calendar_events');
    if (events && events.length) {
      const nowMs = Date.now();
      const upcoming = events
        .filter(function(ev) {
          if (!ev.date) return false;
          var evTime = new Date(ev.date + 'T00:00:00').getTime();
          return evTime >= nowMs - 86400000; // from yesterday forward
        })
        .sort(function(a, b) { return a.date.localeCompare(b.date); })
        .slice(0, 12);

      parts.push('## Calendar');
      if (upcoming.length) {
        upcoming.forEach(function(ev) {
          parts.push('- ' + ev.date + ': ' + ev.title + (ev.time ? ' @ ' + ev.time : ''));
        });
      } else {
        parts.push('- No upcoming events');
      }
    } else {
      parts.push('## Calendar\n- No events');
    }
  } catch (_) { parts.push('## Calendar\n- (unavailable)'); }

  // ── Health (water, sleep, supplements) ──
  try {
    var waterData = loadDataFile('water');
    var todayWater = (waterData || []).find(function(e) { return e.date === todayStr; });
    var glasses = todayWater ? (todayWater.glasses || 0) : 0;

    var health = loadHealthData();
    var sleepRecords = health.sleep_records || [];
    var todaySleep = sleepRecords.filter(function(r) { return r.date === todayStr; });
    var totalSleepHours = todaySleep.reduce(function(s, r) { return s + (r.hours || 0); }, 0);

    // Active sleep session (currently sleeping)
    var activeSleepStart = null;
    try {
      var sessions = loadActiveSessions();
      if (sessions.sleep && sessions.sleep.session_start_time) {
        activeSleepStart = sessions.sleep.session_start_time;
      }
    } catch (_) {}

    // Supplements
    var supplByDate = health.checked_supplements_by_date || {};
    var todaySupps = supplByDate[todayStr] || {};
    var suppNames = Object.keys(todaySupps);
    var takenSupps = suppNames.filter(function(n) { return todaySupps[n]; }).length;

    parts.push('## Health');
    parts.push('- Water: ' + glasses + '/8 glasses');
    if (totalSleepHours > 0) {
      parts.push('- Sleep: ' + totalSleepHours.toFixed(1) + 'h logged tonight');
    } else if (activeSleepStart) {
      var sleepStartLocal = new Date(activeSleepStart).toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      parts.push('- Sleep: sleeping since ' + sleepStartLocal + ' (in progress)');
    } else {
      parts.push('- Sleep: not logged yet');
    }
    if (suppNames.length > 0) {
      parts.push('- Supplements: ' + takenSupps + '/' + suppNames.length + ' taken');
      // List unchecked ones as a nudge
      var unchecked = suppNames.filter(function(n) { return !todaySupps[n]; });
      if (unchecked.length > 0) {
        parts.push('  (remaining: ' + unchecked.join(', ') + ')');
      }
    }
  } catch (_) { parts.push('## Health\n- (unavailable)'); }

  // ── Finance (spending, income, flexible balance, savings) ──
  try {
    var finance = loadFinanceData();
    var income = finance.income || {};
    var monthlyIncome = getMonthlyAmount(income);

    var expenses = finance.expenses || [];
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    var monthExpenses = expenses.filter(function(e) { return (e.time || 0) >= monthStart; });
    var totalSpent = monthExpenses.reduce(function(s, e) { return s + (e.amount || 0); }, 0);

    // Flexible cash balance = income minus spent this month
    var flexibleBalance = monthlyIncome - totalSpent;

    // Savings
    var savings = finance.savings || {};
    var savingsCurrent = savings.current || 0;
    var savingsTarget = savings.target || 0;

    // Subscriptions
    var subs = finance.subscriptions || [];
    var activeSubs = subs.filter(function(s) { return s.active !== false; });

    parts.push('## Finance');
    if (monthlyIncome > 0) parts.push('- Income: $' + monthlyIncome.toFixed(0) + '/mo');
    if (totalSpent > 0) {
      parts.push('- Spent this month: $' + totalSpent.toFixed(2));
      if (monthlyIncome > 0) {
        parts.push('- Budget used: ' + ((totalSpent / monthlyIncome) * 100).toFixed(0) + '%');
      }
    }
    parts.push('- Flexible balance: $' + flexibleBalance.toFixed(2));
    if (savingsCurrent > 0 || savingsTarget > 0) {
      parts.push('- Savings: $' + savingsCurrent.toFixed(2) + ' / $' + savingsTarget.toFixed(2) + ' goal');
    }
    if (activeSubs.length > 0) {
      var subMonthly = activeSubs.reduce(function(s, sub) {
        var amt = sub.amount || 0;
        if (sub.cycle === 'yearly') return s + amt / 12;
        if (sub.cycle === 'weekly') return s + amt * 52 / 12;
        return s + amt;
      }, 0);
      parts.push('- Subscriptions: ' + activeSubs.length + ' active ($' + subMonthly.toFixed(0) + '/mo)');
    }
  } catch (_) { parts.push('## Finance\n- (unavailable)'); }

  // ── Workouts (today + streak) ──
  try {
    var wkData = loadWorkoutData();
    var todayWorkouts = wkData.today_workouts || [];
    var streak = wkData.streak_count || 0;

    parts.push('## Workouts');
    if (todayWorkouts.length > 0) {
      var totalMin = todayWorkouts.reduce(function(s, w) { return s + Math.round((w.duration || 0) / 60); }, 0);
      var types = todayWorkouts.map(function(w) { return w.type; }).join(', ');
      parts.push('- Today: ' + todayWorkouts.length + ' session(s) (' + types + ', ' + totalMin + ' min)');
    } else {
      parts.push('- Today: no workout logged');
    }
    parts.push('- Streak: ' + streak + ' day' + (streak !== 1 ? 's' : '') + (streak >= 3 ? ' \u{1F525}' : ''));
  } catch (_) { parts.push('## Workouts\n- (unavailable)'); }

  // ── Cross-Data Habit Correlations ──
  try {
    parts.push('');
    parts.push(calculateHabitCorrelations());
  } catch (_) { /* silently skip if correlator fails */ }

  return parts.join('\n');
}

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
  var todayStr = userDateStr('America/Los_Angeles');
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
  var supplByDate = healthData.checked_supplements_by_date || {};
  var checked = supplByDate[userDateStr('America/Los_Angeles')] || {};
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
cron.schedule('0 */12 * * *', function() { generateInsights(); }, { timezone: 'America/Los_Angeles' });

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
// Also preserve any active sleep session so it survives the date transition
cron.schedule('55 23 * * *', function() {
  try {
    const wkData = loadWorkoutData();
    const todayStr = userDateStr('America/Los_Angeles');
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
  // Note: active_sleep_start_time in active_sessions is preserved across midnight
  // because it uses an absolute epoch timestamp — no date-keyed storage involved.
}, { timezone: 'America/Los_Angeles' });

/* ════════════ HEALTH / SUPPLEMENT ENDPOINTS ════════════ */

function loadHealthData() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('health'), 'utf8'));
  } catch {
    return { checked_supplements_by_date: {} };
  }
}
function saveHealthData(data) {
  fs.writeFileSync(dataFilePath('health'), JSON.stringify(data, null, 2));
}

// GET /api/v1/health/supplements — returns today's checked supplement state from server
app.get('/api/v1/health/supplements', (req, res) => {
  const health = loadHealthData();
  const todayStr = userDateStr('America/Los_Angeles');
  // Migrate old flat checked_supplements to date-keyed format on read
  if (!health.checked_supplements_by_date) {
    health.checked_supplements_by_date = {};
    if (health.checked_supplements && typeof health.checked_supplements === 'object' && !Array.isArray(health.checked_supplements)) {
      // Only migrate if it looks like today's data (it has entries)
      health.checked_supplements_by_date[todayStr] = health.checked_supplements;
    }
    delete health.checked_supplements;
    saveHealthData(health);
  }
  // Return ONLY today's supplements — ensures daily reset
  res.json({ checked_supplements: health.checked_supplements_by_date[todayStr] || {} });
});

// POST /api/v1/health/supplements — updates checked supplements on server, date-keyed
app.post('/api/v1/health/supplements', express.json(), (req, res) => {
  const { checked_supplements } = req.body;
  if (!checked_supplements || typeof checked_supplements !== 'object') {
    return res.status(400).json({ error: 'checked_supplements must be an object' });
  }
  const health = loadHealthData();
  if (!health.checked_supplements_by_date) {
    health.checked_supplements_by_date = {};
    delete health.checked_supplements;
  }
  const todayStr = userDateStr('America/Los_Angeles');
  health.checked_supplements_by_date[todayStr] = checked_supplements;
  saveHealthData(health);
  res.json({ ok: true });
});

/* ════════════ PROACTIVE LOCK-SCREEN NOTIFICATION LOOPS ════════════ */

// Morning Rocket: 2-sentence breakdown analyzing calendar + workout profiles
const MORNING_ROCKET_PROMPT = `You are Aura's Morning Rocket briefing engine.

Using ONLY the live system state provided below, write exactly 2 concise sentences for a lock-screen push notification:
- Sentence 1: Today's calendar outlook — key events, appointments, schedule density from the Calendar section.
- Sentence 2: Morning workout setup — streak status and recommended action from the Workouts section.

CRITICAL RULES:
- No emojis. No greeting prefix like "Good morning" — jump straight into the briefing.
- Under 280 characters total.
- Only reference data explicitly present in the system state. If data is missing, state it honestly.
- Punchy, lock-screen-optimized style.`;

// Midday Audit: 2-sentence course-correction analyzing health + finance velocities
const MIDDAY_AUDIT_PROMPT = `You are Aura's Midday Audit briefing engine.

Using ONLY the live system state provided below, write exactly 2 concise sentences for a lock-screen push notification:
- Sentence 1: Health velocity check — water intake progress, supplements taken vs remaining, sleep status from the Health section.
- Sentence 2: Finance velocity check — spending pace this month, flexible balance, any concerning trends from the Finance section.

CRITICAL RULES:
- No emojis. No greeting prefix.
- Under 200 characters total.
- Only reference data explicitly present in the system state.
- Direct, actionable course-correction tone.`;

// Night Debrief: objective summary of completed items vs slips
const NIGHT_DEBRIEF_PROMPT = `You are Aura's Night Debrief briefing engine.

Using ONLY the live system state provided below, write exactly 2 concise sentences for a lock-screen push notification:
- Sentence 1: Completed today — workouts done, water goal met, supplements taken, from the Workouts and Health sections.
- Sentence 2: Slips and gaps — what was left undone, missed targets, carry-over items for tomorrow.

CRITICAL RULES:
- No emojis. No greeting prefix.
- Under 280 characters total.
- Only reference data explicitly present in the system state.
- Honest, objective, forward-looking tone.`;

const PULSE_PROMPTS = {
  morning: MORNING_ROCKET_PROMPT,
  midday:  MIDDAY_AUDIT_PROMPT,
  night:   NIGHT_DEBRIEF_PROMPT,
};

async function sendBriefing(timeOfDay, systemState) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('sendBriefing: GROQ_API_KEY not configured');
    return;
  }

  const subs = loadSubscriptions();
  if (!subs.length) {
    console.log('sendBriefing: no push subscriptions registered, skipping');
    return;
  }

  const contextPrompt = PULSE_PROMPTS[timeOfDay];
  if (!contextPrompt) {
    console.error('sendBriefing: unknown timeOfDay "' + timeOfDay + '"');
    return;
  }

  try {
    // Call Groq with the time-context prompt + live system state
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
          { role: 'system', content: contextPrompt },
          { role: 'user', content: 'Live system state snapshot:\n\n' + systemState }
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!groqResp.ok) {
      console.error('sendBriefing: Groq error ' + groqResp.status);
      return;
    }

    const groqData = await groqResp.json();
    const briefing = groqData.choices?.[0]?.message?.content?.trim();
    if (!briefing) {
      console.error('sendBriefing: empty response from Groq');
      return;
    }

    // Compile high-priority lock-screen breakout notification payload
    const payload = JSON.stringify({
      title: 'AURA | POCKET ASSISTANT',
      body: briefing,
      tag: 'aura-critical-pulse',
      renotify: true,
      requireInteraction: true,   // Holds the notification open until acknowledged
      priority: 'high',           // Breaches cell stacks for heads-up placement
      vibrate: [100, 50, 100],    // Physical tactile alert pulse
      data: { pulse: timeOfDay, timestamp: Date.now() }
    });

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
        console.error('sendBriefing: push error ' + (err.statusCode || err.message));
      }
    }

    if (alive.length !== subs.length) {
      saveSubscriptions(alive);
    }

    console.log('sendBriefing: ' + timeOfDay + ' pulse sent=' + sent + ' failed=' + failed);
  } catch (err) {
    console.error('sendBriefing: error — ' + err.message);
  }
}

/* ════════════ PULSE CLOCK (minute-matching background loop) ════════════ */
function clockToMins(t) {
  var p = t.split(':');
  return parseInt(p[0],10) * 60 + parseInt(p[1],10);
}

var lastFired = { morning: false, midday: false, night: false };

function resetFiredIfDayChanged() {
  var h = new Date().getHours();
  var m = new Date().getMinutes();
  // At midnight (00:00) reset all fired flags
  if (h === 0 && m === 0) {
    lastFired = { morning: false, midday: false, night: false };
  }
}

async function checkScheduledNotifications() {
  var now = new Date();
  var currentMins = now.getHours() * 60 + now.getMinutes();
  resetFiredIfDayChanged();

  var config = loadPulseConfig();
  var pulses = [
    { key: 'morning', time: config.morning },
    { key: 'midday', time: config.midday },
    { key: 'night', time: config.night }
  ];

  for (var i = 0; i < pulses.length; i++) {
    var p = pulses[i];
    var target = clockToMins(p.time);
    if (currentMins === target && !lastFired[p.key]) {
      lastFired[p.key] = true;
      console.log('Pulse trigger: ' + p.key + ' at ' + p.time);

      // Assemble live system state and delegate to AI briefing engine
      var systemState = await getAuraSystemContext();
      sendBriefing(p.key, systemState);
    }
  }
}

// Background minute-matching loop — ticks exactly once every 60 seconds
setInterval(function() {
  checkScheduledNotifications();
}, 60000);

/* ════════════ ACTIVE SESSION HELPERS ════════════ */

function loadActiveSessions() {
  try {
    return JSON.parse(fs.readFileSync(dataFilePath('active_sessions'), 'utf8'));
  } catch {
    return { workout: null, deepwork: null, sleep: null };
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
  if (!type || !['workout', 'deepwork', 'sleep'].includes(type)) {
    return res.status(400).json({ error: 'type must be workout, deepwork, or sleep' });
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
  if (!['workout', 'deepwork', 'sleep'].includes(type)) {
    return res.status(400).json({ error: 'type must be workout, deepwork, or sleep' });
  }
  const sessions = loadActiveSessions();
  sessions[type] = null;
  saveActiveSessions(sessions);
  res.json({ ok: true });
});

/* ════════════ SLEEP LIFECYCLE API ════════════ */

// POST /api/v1/health/sleep/start — record absolute sleep start timestamp
app.post('/api/v1/health/sleep/start', (req, res) => {
  const sessions = loadActiveSessions();
  // If sleep is already active, reject (don't double-start)
  if (sessions.sleep && sessions.sleep.session_start_time) {
    return res.status(409).json({ error: 'Sleep session already active', active_sleep_start_time: sessions.sleep.session_start_time });
  }
  sessions.sleep = {
    session_start_time: req.body.session_start_time || Date.now(),
  };
  saveActiveSessions(sessions);

  // Backup sleep start time in health.json so session survives any active_sessions.json issues
  const health = loadHealthData();
  health.pending_sleep_start_time = sessions.sleep.session_start_time;
  saveHealthData(health);

  res.json({ ok: true, active_sleep_start_time: sessions.sleep.session_start_time });
});

// POST /api/v1/health/sleep/end — finalize sleep session, return hours
app.post('/api/v1/health/sleep/end', (req, res) => {
  const sessions = loadActiveSessions();
  if (!sessions.sleep || !sessions.sleep.session_start_time) {
    return res.status(400).json({ error: 'No active sleep session to end' });
  }
  const startTs = sessions.sleep.session_start_time;
  const endTs = req.body.end_time || Date.now();
  const totalHours = (endTs - startTs) / (1000 * 60 * 60);

  // Persist the completed sleep record into health.json
  const health = loadHealthData();
  if (!Array.isArray(health.sleep_records)) health.sleep_records = [];
  const dateStr = userDateStr('America/Los_Angeles');
  health.sleep_records.push({
    date: dateStr,
    checkIn: startTs,
    checkOut: endTs,
    hours: parseFloat(totalHours.toFixed(2)),
    completedAt: Date.now(),
  });
  saveHealthData(health);

  // Clear the active sleep session AND the pending backup
  sessions.sleep = null;
  saveActiveSessions(sessions);

  // Clear the pending_sleep_start_time backup from health.json
  delete health.pending_sleep_start_time;
  saveHealthData(health);

  res.json({ ok: true, hours: parseFloat(totalHours.toFixed(2)), checkIn: startTs, checkOut: endTs });
});

// ── Micro-Logger Voice Orb: Intent Routing Endpoint ──
const VOICE_LOG_SYSTEM_PROMPT = `You are Aura's data routing engine. You receive a raw text logging intent statement. You must categorize it into one of four files: 'workout', 'health', 'finance', or 'calendar'.
Return EXCLUSIVELY a pure JSON object mapping the targeted file and the structural data changes required.
Example 1: 'drank 2 cups of water' -> {"file": "health", "action": "increment", "key": "water_oz", "value": 16}
Example 2: '30 min run' -> {"file": "workout", "action": "push", "data": {"type": "Run", "duration": 30}}
Do not output markdown code fences, introductions, or conversational text. Output pure JSON.`;

app.post('/api/v1/log/voice', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing transcription text' });
  }

  // Early check: ensure GROQ_API_KEY is configured
  if (!process.env.GROQ_API_KEY) {
    return res.json({ ok: false, error: 'Voice logging not configured — GROQ_API_KEY missing' });
  }

  try {
    // Route intent through Groq
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.GROQ_API_KEY || '')
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: VOICE_LOG_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        max_tokens: 256
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text().catch(() => 'unknown');
      console.error('Groq intent routing failed:', groqRes.status, errText);
      return res.json({ ok: false, error: 'Intent routing failed' });
    }

    const groqData = await groqRes.json();
    const rawContent = groqData.choices?.[0]?.message?.content || '';
    
    // Parse the intent JSON from Groq
    let intent;
    try {
      intent = JSON.parse(rawContent.trim());
    } catch (e) {
      // Try extracting JSON from markdown fences or surrounding text
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { intent = JSON.parse(jsonMatch[0]); } catch (e2) {
          return res.json({ ok: false, error: 'Could not parse routing intent' });
        }
      } else {
        return res.json({ ok: false, error: 'Could not parse routing intent' });
      }
    }

    // Execute the file operation
    let message = 'AURA | LOGGED \u2713';
    const dateStr = new Date().toISOString().split('T')[0];

    if (intent.file === 'health') {
      const health = loadHealthData();
      if (intent.action === 'increment' && intent.key && typeof intent.value === 'number') {
        if (!health[intent.key]) health[intent.key] = 0;
        health[intent.key] += intent.value;
        message = 'AURA | LOGGED \u2713 \u2014 ' + intent.value + ' ' + (intent.key === 'water_oz' ? 'oz water' : intent.key);
      } else if (intent.action === 'push' && intent.data) {
        if (!Array.isArray(health.records)) health.records = [];
        health.records.push({ ...intent.data, date: dateStr, loggedAt: Date.now() });
        message = 'AURA | LOGGED \u2713 \u2014 health record added';
      }
      saveHealthData(health);
    } else if (intent.file === 'workout') {
      const workouts = loadDataFile('workout');
      if (intent.action === 'push' && intent.data) {
        workouts.push({ ...intent.data, date: dateStr, loggedAt: Date.now() });
        message = 'AURA | LOGGED \u2713 \u2014 ' + (intent.data.type || 'Workout') + ' ' + (intent.data.duration ? intent.data.duration + 'min' : '');
      } else if (intent.action === 'increment' && intent.key) {
        const todayEntry = workouts.find(w => w.date === dateStr);
        if (todayEntry) {
          todayEntry[intent.key] = (todayEntry[intent.key] || 0) + (intent.value || 1);
        } else {
          workouts.push({ date: dateStr, [intent.key]: intent.value || 1, loggedAt: Date.now() });
        }
        message = 'AURA | LOGGED \u2713 \u2014 workout ' + intent.key;
      }
      saveDataFile('workout', workouts);
    } else if (intent.file === 'finance') {
      const finance = loadDataFile('finance');
      if (intent.action === 'push' && intent.data) {
        finance.push({ ...intent.data, date: dateStr, loggedAt: Date.now() });
        message = 'AURA | LOGGED \u2713 \u2014 $' + (intent.data.amount || '0') + ' ' + (intent.data.category || 'expense');
      }
      saveDataFile('finance', finance);
    } else if (intent.file === 'calendar') {
      const events = loadDataFile('calendar_events');
      if (intent.action === 'push' && intent.data) {
        events.push({ ...intent.data, loggedAt: Date.now() });
        message = 'AURA | LOGGED \u2713 \u2014 ' + (intent.data.title || 'Event') + ' on ' + (intent.data.date || dateStr);
      }
      saveDataFile('calendar_events', events);
    } else {
      return res.json({ ok: false, error: 'Unknown file target: ' + intent.file });
    }

    // Persist voice log entry for history panel
    const voiceLogs = loadDataFile('voice_log');
    voiceLogs.unshift({
      transcript: text,
      file: intent.file,
      action: intent.action,
      message: message,
      createdAt: Date.now()
    });
    // Keep last 50 entries
    if (voiceLogs.length > 50) voiceLogs.length = 50;
    saveDataFile('voice_log', voiceLogs);

    res.json({ ok: true, message, intent });
  } catch (err) {
    console.error('Voice log error:', err);
    res.json({ ok: false, error: 'Internal error processing voice log' });
  }
});
// ── Voice Log History ──
app.get('/api/v1/log/voice/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const logs = loadDataFile('voice_log');
  res.json({ ok: true, history: logs.slice(0, limit) });
});



/* ════════════ USER COCKPIT — Home Dashboard Metrics ════════════ */

app.get('/api/v1/user/cockpit', (req, res) => {
  const tz = 'America/Los_Angeles';
  const todayStr = userDateStr(tz);

  // ── Finance: discretionary cash velocity (income - spent this month) ──
  let finance = { discretionary: 0, spent: 0, income: 0 };
  try {
    const fin = loadFinanceData();
    const monthlyIncome = getMonthlyAmount(fin.income || {});
    const expenses = fin.expenses || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthExpenses = expenses.filter(e => (e.time || 0) >= monthStart);
    const totalSpent = monthExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    finance = {
      discretionary: Math.max(0, monthlyIncome - totalSpent),
      spent: totalSpent,
      income: monthlyIncome,
    };
  } catch (_) {}

  // ── Health: water intake in oz ──
  let health = { water_oz: 0, glasses: 0, goal: 64 };
  try {
    const waterData = loadDataFile('water');
    const todayEntry = (waterData || []).find(e => e.date === todayStr);
    const glasses = todayEntry ? (todayEntry.glasses || 0) : 0;
    health = { water_oz: glasses * 8, glasses, goal: 64 };
  } catch (_) {}

  // ── Workouts: weekly goal completion (e.g. 2/3 completed) ──
  let workouts = { completed: 0, goal: 3, streak: 0 };
  try {
    const wkData = loadWorkoutData();
    const weekDates = [];
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      weekDates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    }
    let weekSessions = 0;
    // Today's workouts
    if (wkData.today_workouts && wkData.today_workouts.length) {
      weekSessions += wkData.today_workouts.length;
    }
    // History
    for (const entry of (wkData.history || [])) {
      if (weekDates.includes(entry.date) && entry.sessions && entry.sessions.length) {
        weekSessions += entry.sessions.length;
      }
    }
    workouts = {
      completed: weekSessions,
      goal: 3,
      streak: wkData.streak_count || 0,
    };
  } catch (_) {}

  res.json({ finance, health, workouts });
});

/* ════════════ SERVER START ════════════ */

// Restore pending sleep session from health.json backup on startup
(function restorePendingSleep() {
  try {
    const health = loadHealthData();
    if (health.pending_sleep_start_time) {
      const sessions = loadActiveSessions();
      // Only restore if no active sleep session already exists
      if (!sessions.sleep || !sessions.sleep.session_start_time) {
        sessions.sleep = { session_start_time: health.pending_sleep_start_time };
        saveActiveSessions(sessions);
        console.log('Restored pending sleep session from health.json backup (start:', new Date(health.pending_sleep_start_time).toISOString(), ')');
      }
    }
  } catch (err) {
    console.error('Failed to restore pending sleep session:', err.message);
  }
})();

app.listen(PORT, () => {
  console.log(`Aura server running on port ${PORT} | TZ=${process.env.TZ || 'system'}`);
});
// redeploy trigger Mon, May 25, 2026  6:59:39 AM
