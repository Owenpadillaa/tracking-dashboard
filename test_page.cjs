const puppeteer = require('C:\\Users\\Owen\\AppData\\Roaming\\npm\\node_modules\\@hisma\\server-puppeteer\\node_modules\\puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  page.on('console', msg => {
    console.log(`[${msg.type()}] ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.log(`[PAGE ERROR] ${err.message}`);
    console.log(`[STACK] ${err.stack}`);
  });

  await page.goto('https://aura-production-ea81.up.railway.app', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const result = await page.evaluate(() => {
    const views = {
      weekly: document.getElementById('calendar-view-weekly')?.classList.contains('hidden'),
      monthly: document.getElementById('calendar-view-monthly')?.classList.contains('hidden'),
      yearly: document.getElementById('calendar-view-yearly')?.classList.contains('hidden'),
    };
    const ribbon = document.getElementById('calendar-date-ribbon');
    const monthlyGrid = document.getElementById('monthlyGrid');
    const yearlyGrid = document.getElementById('yearlyGrid');
    const switcher = document.querySelectorAll('.calendar-view-btn').length;
    const activeBtn = document.querySelector('.calendar-view-btn.active')?.dataset.view;
    const chips = ribbon?.children.length || 0;
    return { views, switcher, activeBtn, chips, monthlyCells: monthlyGrid?.children.length, yearlyBlocks: yearlyGrid?.children.length };
  });

  console.log('Default state:', JSON.stringify(result, null, 2));

  // Test switching to monthly view
  await page.evaluate(() => switchCalendarView('monthly'));
  await new Promise(r => setTimeout(r, 500));
  const monthlyState = await page.evaluate(() => ({
    weekly: document.getElementById('calendar-view-weekly')?.classList.contains('hidden'),
    monthly: document.getElementById('calendar-view-monthly')?.classList.contains('hidden'),
    activeBtn: document.querySelector('.calendar-view-btn.active')?.dataset.view,
    cellCount: document.querySelectorAll('.monthly-cell').length,
    dotCount: document.querySelectorAll('.monthly-dot').length,
  }));
  console.log('Monthly state:', JSON.stringify(monthlyState, null, 2));

  // Test switching to yearly view
  await page.evaluate(() => switchCalendarView('yearly'));
  await new Promise(r => setTimeout(r, 500));
  const yearlyState = await page.evaluate(() => ({
    weekly: document.getElementById('calendar-view-weekly')?.classList.contains('hidden'),
    yearly: document.getElementById('calendar-view-yearly')?.classList.contains('hidden'),
    activeBtn: document.querySelector('.calendar-view-btn.active')?.dataset.view,
    blocks: document.querySelectorAll('.yearly-month-block').length,
    days: document.querySelectorAll('.yearly-day').length,
  }));
  console.log('Yearly state:', JSON.stringify(yearlyState, null, 2));

  await browser.close();
})();
