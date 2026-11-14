// Loads docs/preview/index.html, the site, in headless Chromium with mainnet RPC, GitHub's API and the
// repo's raw files answered from this checkout (the vault's record as the chain holds it after round 3,
// agent/src/rules.js as committed). Checks what a visitor sees: the live card, the guard row, the
// labelled replay, the simulation running the agents' own rules, the feed, and the phone layout. Also
// checks that docs/index.html, the main address, sends visitors to ./preview/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..", "..");
const N = (m) => `${m}.dissentfinance.near`;
const PINNED = "422431347cc9811af2f2471795ba403137617c44";

// vault2 after round 3, as the chain holds it: the record exactly as get_record returns it
// (fixtures/v2-record-r3.json), the balances and shares from get_balances and get_shares.
function chainV3() {
  const record = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v2-record-r3.json"), "utf8"));
  const shares = { [N("emma")]: "50000000000000000000000", [N("ben")]: "100000000000000000000000", [N("alice")]: "50000000000000000000000", [N("dan")]: "66327359938463994543033" };
  return {
    code: "2CkdfmNBiPGukvkBpRm1AygHERiGDdPXf23eXPL58uVM",
    vaultKeys: [{ access_key: { permission: "FullAccess" } }],
    get_balances: { near: "266327359938463994543033", usdc: "479337", total_shares: "266327359938463994543033", members: 4, open_spends: 0 },
    get_shares: (a) => shares[a.account_id] ?? "0",
    get_record_len: record.length,
    get_record: (a) => record.slice(a.from_index, a.from_index + a.limit),
    get_spend: { id: 0, proposal_id: 1, recipient: N("ben"), token: "Usdc", amount: "600000", approvers: [N("ben"), N("cara")], objectors: [], queued_at: "1794490269844300751", window_ends: "1794490869844300751", status: "Cancelled" },
    get_factory_info: { factory_id: "sputnik-dao.near", auto_update: false },
  };
}

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const ON_DUTY = [
  { status: "completed", run_number: 14, run_started_at: ago(12), updated_at: ago(12), html_url: "https://github.com/QijomoFav35/Dissent-Finance/actions/runs/14" },
  { status: "in_progress", run_number: 13, run_started_at: ago(42), updated_at: ago(42), html_url: "https://github.com/QijomoFav35/Dissent-Finance/actions/runs/13" },
];

/**
 * Opens a page of the site. `rpc: false` makes every mainnet read fail; `guard: null` makes GitHub's API
 * refuse; `rules` replaces the bytes served for agent/src/rules.js.
 */
async function open({ file = "docs/preview/index.html", width = 1280, rpc = true, guard = ON_DUTY, rules = null, reducedMotion = "reduce" } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
  const errors = [], requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => requests.push(r.url()));
  const views = chainV3();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route(/fastnear|near\.org/, async (route) => {
    if (!rpc) return route.abort();
    const body = JSON.parse(route.request().postData());
    const p = body.params;
    let result;
    if (p.request_type === "view_account") result = { code_hash: views.code, amount: "1" };
    else if (p.request_type === "view_access_key_list") result = { keys: views.vaultKeys };
    else {
      let v = views[p.method_name];
      if (typeof v === "function") v = v(JSON.parse(Buffer.from(p.args_base64, "base64").toString()));
      result = v === undefined ? { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } : { result: [...Buffer.from(JSON.stringify(v))] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
  });
  await page.route(/raw\.githubusercontent\.com/, async (route) => {
    const rel = route.request().url().split("/Dissent-Finance/")[1].replace(/^[^/]+\//, "");
    const f = path.join(repo, rel);
    if (rules !== null && rel === "agent/src/rules.js") return route.fulfill({ status: 200, body: rules, headers: { "access-control-allow-origin": "*" } });
    if (fs.existsSync(f)) await route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "access-control-allow-origin": "*" } });
    else await route.fulfill({ status: 404, body: "" });
  });
  await page.route(/api\.github\.com/, async (route) => {
    if (guard === null) return route.fulfill({ status: 403, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ message: "API rate limit exceeded" }) });
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ workflow_runs: guard }) });
  });
  await page.goto(`file://${path.join(repo, file)}`);
  const text = async (sel) => (await page.textContent(sel)).replace(/\s+/g, " ").trim();
  return { page, errors, requests, text, close: () => browser.close() };
}

const live = (p) => p.page.waitForFunction(() => document.getElementById("v-when").textContent.startsWith("Read from mainnet"), null, { timeout: 20000 });
const hm = (iso) => new Date(iso).toISOString().slice(11, 16);

test("the main address sends visitors to ./preview/", async () => {
  const html = fs.readFileSync(path.join(repo, "docs/index.html"), "utf8");
  assert.match(html, /<meta http-equiv="refresh" content="0; url=\.\/preview\/">/);
  assert.match(html, /<a href="\.\/preview\/">/);
  const p = await open({ file: "docs/index.html" });
  try {
    await p.page.waitForURL(/\/docs\/preview\/$/, { timeout: 10000 });
  } finally {
    await p.close();
  }
});

test("the live card reads the vault from mainnet", async () => {
  const p = await open();
  try {
    await live(p);
    assert.match(await p.text("#v-when"), /^Read from mainnet just now, \d\d:\d\d UTC$/);
    assert.equal(await p.text("#v-usdc"), "0.479337 USDC");
    assert.equal(await p.text("#v-near"), "0.27 NEAR");
    assert.equal(await p.text("#nav-bal"), "0.48 USDC");
    assert.equal(await p.text("#v-sub"), "4 members in. 0 payments waiting. 17 events on record.");
    const seats = await p.page.$$eval("#v-seats .seat", (els) => els.map((e) => `${e.querySelector(".nm").textContent} ${e.querySelector(".pc").textContent}`));
    assert.deepEqual(seats, ["Alice 18.8%", "Ben 37.5%", "Cara Left", "Dan 24.9%", "Emma 18.8%"]);
    assert.equal(await p.text("#v-seats-note"), "Shares of the four members still in. Cara left in round 3.");
    assert.equal(await p.text("#c-code"), "Code on chain is the build of commit 6ae0259");
    assert.equal(await p.text("#c-dao"), "The DAO’s automatic code updates are off");
    assert.equal(await p.text("#c-key"), "1 full-access key is still on this vault");
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("when mainnet can't be read, every live part says it shows the last read", async () => {
  const p = await open({ rpc: false });
  try {
    await p.page.waitForTimeout(1500);
    assert.equal(await p.text("#v-when"), "Last read 14 Nov, 13:08 UTC");
    assert.equal(await p.text("#tick-when"), "Last read 14 Nov, 13:08 UTC");
    assert.equal(await p.text("#feed-when"), "Last read 14 Nov, 13:08 UTC");
    assert.equal(await p.text("#v-usdc"), "0.479337 USDC");
    assert.equal(await p.text("#v-sub"), "4 members in. 0 payments waiting. 17 events on record.");
  } finally {
    await p.close();
  }
});

test("the guard row: on duty until the shift's planned end, and the last check", async () => {
  const p = await open();
  try {
    await p.page.waitForFunction(() => !document.getElementById("duty-line").textContent.includes("Reading"), null, { timeout: 20000 });
    const until = new Date(Date.parse(ON_DUTY[1].run_started_at) + 340 * 60000).toISOString();
    assert.match(await p.text("#duty-line"), new RegExp(`^On duty until (\\d{1,2} \\w{3}, )?${hm(until)} UTC\\. Last check ${hm(ON_DUTY[0].updated_at)} UTC\\.$`));
    assert.ok(await p.page.$eval("#duty", (e) => e.classList.contains("on")));
  } finally {
    await p.close();
  }
});

test("the guard row says so when GitHub's API refuses", async () => {
  const p = await open({ guard: null });
  try {
    await p.page.waitForFunction(() => document.getElementById("duty-line").textContent.startsWith("Status unavailable"), null, { timeout: 20000 });
    assert.equal(await p.text("#duty-line"), "Status unavailable, see the Actions page.");
    assert.equal(await p.page.getAttribute("#duty-line a", "href"), "https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/guard.yml");
    assert.ok(!(await p.page.$eval("#duty", (e) => e.classList.contains("on"))));
  } finally {
    await p.close();
  }
});

test("the replay is labelled as a replay, the simulation as not live", async () => {
  const p = await open();
  try {
    assert.equal(await p.text(".replay-tag span"), "Replay");
    assert.equal(await p.text(".replay-tag"), "ReplayRebuilt from the vault’s record of 12 Nov. It is not the live feed: live numbers are in the card at the top of the page.");
    assert.deepEqual(await p.page.$$eval('a[href="#problem"]', (els) => els.map((e) => e.textContent.trim())), ["Replay", "Replay", "Watch the replay", "the replay"]);
    assert.equal(await p.text("#play"), "Replay at real speed");
    assert.equal(await p.text("#sim .sim-tag"), "Not live");
    assert.equal(await p.text("#sim-h"), "Simulation, same rules as the agents");
  } finally {
    await p.close();
  }
});

test("the feed and the ticker: events from the record, newest first, each linked to its transaction", async () => {
  const p = await open();
  try {
    await p.page.waitForFunction(() => document.getElementById("feed-when").textContent.startsWith("Read from mainnet"), null, { timeout: 20000 });
    const feed = await p.page.$$eval("#feed-list li:not([aria-hidden])", (els) => els.map((e) => `${e.querySelector(".x").textContent} | ${e.querySelector("a").getAttribute("href").split("/").pop()}`));
    assert.deepEqual(feed, [
      "Spend 1 paid 0.07 USDC to Ben | 9osUXBVnfdFhMyzKT4xKVKkzFJ56pnwAqoVdRj5kteKX",
      "Cara left with 0.150593 USDC | 53qLDWKV7hAij7P9MeJFRjshBJfeKR8GRaTpsd4ikd6u",
      "Spend 1 queued: 0.07 USDC to Ben, after 2 yes votes in the DAO | 9MgxBmfvUvwe5rHET3YPYf9uZTLXJhDYJbG24BxTS61w",
      "Dan bought part of Cara’s shares for 0.085979 USDC after 7 bids | A1cR7MQVKxysm1AxbwUU8xAnePaCT3bmCrNBhArXZrmp",
      "Emma’s agent cancelled spend 0 · 11.2 s after it was queued | 4cA4kFtvvuz6bVb5FRjP35Q76sHQKq3hWsabd59xLAAT",
      "Dan’s agent withdrew 0.20 USDC · 8.7 s after spend 0 was queued | Msq3yLLHyQQjYehLowCZJDhQB3u48gAPvhsZrtTkmdg",
      "Alice’s agent withdrew 0.20 USDC · 8.0 s after spend 0 was queued | CGpp5bJe2ZB87QZTsnmvN4f28cQsjqS6yoPzzKsQKfKN",
      "Emma’s agent withdrew 0.20 USDC · 8.0 s after spend 0 was queued | GqsAoKSZsysmtKKA37Vq5vX3pbsFWgrRMgWkjVWfeTUa",
      "Spend 0 queued: 0.60 USDC to Ben, after 2 yes votes in the DAO | DpKwEZ8L419yKGqnxDrqrv5hQK4UJM7pYCVtEMbAYxwu",
    ]);
    const tick = await p.page.$$eval(".tick-g:first-child a", (els) => els.map((e) => e.textContent));
    assert.equal(tick.length, 18);
    assert.equal(tick[0], "4 members in · 17 events on recordvault");
    assert.equal(tick[17], "Alice joined with 0.20 USDCGSN4tG2B");
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("the simulation runs agent/src/rules.js, pinned and hash-checked, and matches mainnet", async () => {
  const p = await open();
  try {
    await live(p);
    await p.page.locator("#sim").scrollIntoViewIfNeeded();
    await p.page.waitForFunction(() => document.querySelectorAll("#sim-list li").length === 5 && !document.getElementById("sim-end").classList.contains("wait"), null, { timeout: 20000 });
    assert.ok(p.requests.includes(`https://raw.githubusercontent.com/QijomoFav35/Dissent-Finance/${PINNED}/agent/src/rules.js`));
    const rows = await p.page.$$eval("#sim-list li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    assert.deepEqual(rows, [
      "Alice’s agent. No payment over 20% of the fund. This one takes 60%.Withdraws 0.20 USDCSame on mainnet: withdrew 0.20 USDC CGpp5bJe",
      "Ben’s agent. Voted yes in the DAO, so the agent stays.StaysSame on mainnet: no withdrawal on record",
      "Cara’s agent. Voted yes in the DAO, so the agent stays.StaysSame on mainnet: no withdrawal on record",
      "Dan’s agent. Only pay accounts this vault has paid before. Ben was never paid.Withdraws 0.20 USDCSame on mainnet: withdrew 0.20 USDC Msq3yLLH",
      "Emma’s agent. Never pay Ben. Ben is on the list.Withdraws 0.20 USDCSame on mainnet: withdrew 0.20 USDC GqsAoKSZ",
    ]);
    assert.equal(await p.text("#sim-end"), "Left in the vault: 0.40 USDC. 0.60 USDC plus the 0.1% fee can’t be paid, so any agent can cancel it. On mainnet Emma’s agent did: 4cA4kFtv.");
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("write your rules: agent/src/rules.js decides, for your own rules", async () => {
  const p = await open();
  try {
    await p.page.waitForFunction(() => document.getElementById("dec").textContent !== "", null, { timeout: 20000 });
    assert.equal(await p.text("#dec"), "Withdraws your 0.20 USDC before Ben is paid");
    assert.equal(await p.text("#why"), "Rule brokenTakes 60% of the fund. Your limit is 20%.");
    await p.page.fill("#r-cap-v", "70");
    await p.page.waitForFunction(() => document.getElementById("dec").textContent === "Stays");
    assert.equal(await p.text("#why"), "Rule keptTakes 60% of the fund. Your limit is 70%.");
    await p.page.uncheck("#r-cap");
    await p.page.waitForFunction(() => document.getElementById("why").textContent.includes("No rules"));
    await p.page.check("#r-new");
    await p.page.waitForFunction(() => document.getElementById("dec").textContent.startsWith("Withdraws"));
    assert.equal(await p.text("#why"), "Rule brokenThe vault has never paid Ben before.");
    await p.page.check("#r-voted");
    await p.page.waitForFunction(() => document.getElementById("dec").textContent === "Stays");
    assert.match(await p.text("#why"), /^StaysYou voted for this payment\./);
    assert.match(await p.text("#h"), /^[0-9a-f]{64}$/);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("the simulation refuses a rules.js that doesn't match its pinned hash", async () => {
  const real = fs.readFileSync(path.join(repo, "agent/src/rules.js"), "utf8");
  const p = await open({ rules: real.replace("share > BigInt(r.max_spend_share_bps)", "false") });
  try {
    await p.page.locator("#sim").scrollIntoViewIfNeeded();
    await p.page.waitForFunction(() => document.getElementById("sim-list").textContent.includes("Couldn’t load"), null, { timeout: 20000 });
    assert.match(await p.text("#sim-list"), /^Couldn’t load agent\/src\/rules\.js from GitHub, so the simulation can’t run here\./);
    assert.doesNotMatch(await p.text("#sim-list"), /Withdraws|Stays/);
    assert.match(await p.text("#why"), /Couldn’t load agent\/src\/rules\.js from GitHub/);
    assert.equal(await p.text("#dec"), "");
  } finally {
    await p.close();
  }
});

test("on a phone the page does not scroll sideways and keeps a 16px margin", async () => {
  const p = await open({ width: 390 });
  try {
    await live(p);
    assert.equal(await p.page.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.equal(await p.page.$eval("h1", (e) => Math.round(e.getBoundingClientRect().left)), 16);
    assert.equal(await p.page.$eval("#vault", (e) => Math.round(e.getBoundingClientRect().left)), 16);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

// SHOT=<folder> node --test page.test.js also saves full-page screenshots there, for review.
if (process.env.SHOT) {
  test("screenshots", async () => {
    for (const [name, width] of [["desktop", 1366], ["phone", 390]]) {
      const p = await open({ width });
      await live(p);
      await p.page.screenshot({ path: path.join(process.env.SHOT, `${name}.png`), fullPage: true });
      await p.close();
    }
  });
}
