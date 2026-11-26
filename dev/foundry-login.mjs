// Client side of the login gate (see dev/claude-login/README.md): log a Playwright page into Foundry as the
// Claude GM without any password or token in this code.
//
// In a Claude Code cloud session the token is a network secret: the environment's proxy adds
// "Authorization: Bearer <token>" to requests for the Foundry host, and nothing in the session can read it.
// Elsewhere, set FOUNDRY_GATE_TOKEN and it is sent only to the /claude-login request.
//
//   import { loginAsClaudeGM } from './dev/foundry-login.mjs';
//   const { browser, page } = await loginAsClaudeGM();   // reads FOUNDRY_URL
//
// Run directly for a smoke test:  node dev/foundry-login.mjs

import { createRequire } from 'node:module';

// require() rather than import: it also finds a globally installed Playwright (as in cloud sessions).
const { chromium } = createRequire(import.meta.url)('playwright');

export async function loginAsClaudeGM({ url = process.env.FOUNDRY_URL, headless = true } = {}) {
  if (!url) throw new Error('Set FOUNDRY_URL (e.g. https://foundry.example.com)');
  const base = url.replace(/\/$/, '');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const token = process.env.FOUNDRY_GATE_TOKEN;
  if (token) {
    // Only this one request carries the token; the Foundry traffic after it does not.
    await page.route(`${base}/claude-login`, (route) =>
      route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }));
  }

  const res = await page.goto(`${base}/claude-login`, { waitUntil: 'domcontentloaded' });
  if (!page.url().startsWith(`${base}/game`)) {
    const status = res ? res.status() : 'no response';
    await browser.close();
    throw new Error(`Gate login failed (${status} at ${page.url()}). 403: token missing or wrong; ` +
      `429: gate locked after bad tokens; 503: no world launched; 502: Foundry refused the password.`);
  }
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 });
  return { browser, context, page };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, page } = await loginAsClaudeGM();
  const who = await page.evaluate(() => ({ user: game.user.name, isGM: game.user.isGM, world: game.world.title, foundry: game.version, system: `${game.system.id} ${game.system.version}` }));
  console.log(who);
  await browser.close();
}
