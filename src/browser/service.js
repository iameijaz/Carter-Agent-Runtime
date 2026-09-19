/**
 * Carter Persistent Browser Service
 *
 * Run once: node src/browser/service.js
 * Keeps a single browser context alive. Carter agent sends JSON commands over
 * a local WebSocket on port 3132. No restart lag, session/cookies persist.
 *
 * Commands (send as JSON):
 *   { id, action: "navigate",    url }
 *   { id, action: "click",       selector }
 *   { id, action: "fill",        selector, value }
 *   { id, action: "type",        selector, text }
 *   { id, action: "press",       key }
 *   { id, action: "screenshot" }
 *   { id, action: "get_text",    selector? }
 *   { id, action: "get_html",    selector? }
 *   { id, action: "eval",        code }
 *   { id, action: "wait",        selector, timeout? }
 *   { id, action: "scroll",      selector?, direction?, amount? }
 *   { id, action: "new_tab",     url? }
 *   { id, action: "close_tab" }
 *   { id, action: "list_tabs" }
 *   { id, action: "switch_tab",  index }
 *   { id, action: "search",      query, engine? }  // convenience: navigate + fill + enter
 *   { id, action: "status" }
 *   { id, action: "reload" }
 *   { id, action: "back" }
 *   { id, action: "forward" }
 *
 * Responses: { id, ok: true, result } or { id, ok: false, error }
 */

import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 3132;
const SCREENSHOT_DIR = path.join(__dirname, '../../workspace/browser-screenshots');
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing:   'https://www.bing.com/search?q=',
  ddg:    'https://duckduckgo.com/?q=',
  yt:     'https://www.youtube.com/results?search_query=',
};

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let browser, context;
const pages = [];   // tab pool
let activePage = 0; // index into pages

async function getPage() {
  if (!pages[activePage] || pages[activePage].isClosed()) {
    pages[activePage] = await context.newPage();
  }
  return pages[activePage];
}

async function start() {
  browser = await chromium.launch({
    channel: 'msedge',   // use installed Edge; falls back to chromium if missing
    headless: false,
    args: ['--start-maximized'],
  }).catch(() =>
    // msedge not found — fall back to bundled Chromium
    chromium.launch({ headless: false, args: ['--start-maximized'] })
  );

  context = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
  });

  pages[0] = await context.newPage();
  await pages[0].goto('about:blank');

  console.log(`[browser-service] ready — ws://127.0.0.1:${PORT}`);

  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

  wss.on('connection', (ws) => {
    console.log('[browser-service] agent connected');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      const { id, action } = msg;
      let result;

      try {
        const page = await getPage();

        switch (action) {
          case 'navigate':
            await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            result = { url: page.url(), title: await page.title() };
            break;

          case 'click':
            await page.click(msg.selector, { timeout: 10000 });
            result = { clicked: msg.selector };
            break;

          case 'fill': {
            // click to focus, clear existing content, type character by character
            const loc = page.locator(msg.selector).first();
            await loc.waitFor({ state: 'visible', timeout: 10000 });
            await loc.click();
            await page.waitForTimeout(150);
            await loc.selectText().catch(() => {});
            await page.keyboard.press('Control+a');
            await page.keyboard.press('Delete');
            await loc.pressSequentially(msg.value ?? '', { delay: 40 });
            result = { filled: msg.selector, value: msg.value };
            break;
          }

          case 'type': {
            // pressSequentially fires real keydown/keyup events — works on all inputs
            const loc = page.locator(msg.selector ?? 'textarea:visible,input:visible').first();
            await loc.waitFor({ timeout: 10000 });
            await loc.click();
            await loc.pressSequentially(msg.text ?? '', { delay: 40 });
            result = { typed: msg.text };
            break;
          }

          case 'press':
            await page.keyboard.press(msg.key);
            result = { pressed: msg.key };
            break;

          case 'screenshot': {
            const ts = Date.now();
            const file = path.join(SCREENSHOT_DIR, `shot-${ts}.png`);
            await page.screenshot({ path: file, fullPage: false });
            // Base64 for inline delivery
            const b64 = fs.readFileSync(file).toString('base64');
            result = { file, dataUrl: `data:image/png;base64,${b64}` };
            break;
          }

          case 'get_text': {
            const el = msg.selector ? await page.$(msg.selector) : null;
            result = { text: el ? await el.innerText() : await page.innerText('body') };
            break;
          }

          case 'get_html': {
            const el = msg.selector ? await page.$(msg.selector) : null;
            result = { html: el ? await el.innerHTML() : await page.content() };
            break;
          }

          case 'eval':
            result = { value: await page.evaluate(msg.code) };
            break;

          case 'wait':
            await page.waitForSelector(msg.selector, { timeout: msg.timeout ?? 15000 });
            result = { found: msg.selector };
            break;

          case 'scroll': {
            const dir = msg.direction ?? 'down';
            const amt = msg.amount ?? 600;
            await page.evaluate(({ dir, amt }) => {
              window.scrollBy(0, dir === 'down' ? amt : -amt);
            }, { dir, amt });
            result = { scrolled: dir, by: amt };
            break;
          }

          case 'search': {
            const engine = msg.engine ?? 'google';
            const base = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google;

            // Navigate to the search engine home page first
            const homeUrls = {
              google: 'https://www.google.com',
              bing:   'https://www.bing.com',
              ddg:    'https://www.duckduckgo.com',
              yt:     'https://www.youtube.com',
            };
            await page.goto(homeUrls[engine] ?? homeUrls.google, { waitUntil: 'domcontentloaded', timeout: 20000 });

            // Each engine's search input selector
            const inputSelectors = {
              google: 'textarea[name="q"], input[name="q"]',
              bing:   'input[name="q"], #sb_form_q',
              ddg:    'input[name="q"], #searchbox_input',
              yt:     'input[name="search_query"], #search-input input',
            };
            const selector = inputSelectors[engine] ?? inputSelectors.google;

            // Wait for the field, click to focus, then type character by character
            const loc = page.locator(selector).first();
            await loc.waitFor({ state: 'visible', timeout: 10000 });
            await loc.click();
            await page.waitForTimeout(200); // let focus settle
            await loc.pressSequentially(msg.query, { delay: 50 });
            await page.waitForTimeout(300); // let autocomplete settle
            await page.keyboard.press('Enter');
            await page.waitForLoadState('domcontentloaded');

            result = { url: page.url(), title: await page.title(), query: msg.query };
            break;
          }

          case 'new_tab': {
            const newPage = await context.newPage();
            pages.push(newPage);
            activePage = pages.length - 1;
            if (msg.url) await newPage.goto(msg.url, { waitUntil: 'domcontentloaded' });
            result = { tabIndex: activePage, url: newPage.url() };
            break;
          }

          case 'close_tab': {
            if (pages.length > 1) {
              await pages[activePage].close();
              pages.splice(activePage, 1);
              activePage = Math.max(0, activePage - 1);
            }
            result = { closed: true, activeTab: activePage };
            break;
          }

          case 'list_tabs': {
            const tabs = await Promise.all(pages.map(async (p, i) => ({
              index: i,
              active: i === activePage,
              url: p.isClosed() ? '[closed]' : p.url(),
              title: p.isClosed() ? '' : await p.title().catch(() => ''),
            })));
            result = { tabs };
            break;
          }

          case 'switch_tab':
            activePage = Math.min(msg.index, pages.length - 1);
            result = { activeTab: activePage, url: pages[activePage].url() };
            break;

          case 'status':
            result = {
              ready: true,
              activeTab: activePage,
              tabCount: pages.filter(p => !p.isClosed()).length,
              url: page.url(),
              title: await page.title(),
            };
            break;

          case 'reload':
            await page.reload({ waitUntil: 'domcontentloaded' });
            result = { url: page.url() };
            break;

          case 'back':
            await page.goBack({ waitUntil: 'domcontentloaded' });
            result = { url: page.url() };
            break;

          case 'forward':
            await page.goForward({ waitUntil: 'domcontentloaded' });
            result = { url: page.url() };
            break;

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        ws.send(JSON.stringify({ id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id, ok: false, error: err.message }));
      }
    });

    ws.on('close', () => console.log('[browser-service] agent disconnected'));
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('[browser-service] shutting down…');
    await browser.close();
    process.exit(0);
  });
}

start().catch(err => {
  console.error('[browser-service] fatal:', err.message);
  process.exit(1);
});
