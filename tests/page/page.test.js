// Loads docs/index.html in headless Chromium with mainnet RPC and the repo's raw files answered
// from this checkout (v1's real notes, the vault's record as the chain holds it). Checks what a
// visitor sees: the checks strip, the two outcomes, the notes matching their hashes, no errors and
// no sideways scroll on a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..", "..");
const N = (m) => `${m}.dissentfinance.near`;
const note = (m, dir = "notes") => JSON.parse(fs.readFileSync(path.join(repo, "agent/mainnet", dir, `0-${N(m)}.json`), "utf8"));
const ts = (s) => String(BigInt(Date.parse(s)) * 1_000_000n);
const ev = (event, data, at) => JSON.stringify({ standard: "dissent", version: "1.0.0", event, data: [data], ts: ts(at) });

// v1's run on 11 November, as its record holds it; `later` adds Ben's and Cara's exits from the next day.
function chain({ later = false, wrongHash = false } = {}) {
  const record = [];
  for (const [m, t] of [["alice", "20:56"], ["ben", "20:58"], ["cara", "21:00"], ["dan", "21:02"], ["emma", "21:03"]]) {
    record.push(ev("join", { account_id: N(m), shares: "100", near: "100000000000000000000000", usdc: "200000" }, `2026-11-11T${t}:01Z`));
  }
  record.push(ev("queue_spend", { spend_id: 0, proposal_id: 0, recipient: N("ben"), amount: "600000", approve: 2, not_approve: 0 }, "2026-11-11T21:11:06Z"));
  for (const [m, t] of [["emma", "21:11:20"], ["dan", "21:11:30"], ["alice", "21:11:40"]]) {
    record.push(ev("exit", { account_id: N(m), shares: "100", near: "100000000000000000000000", usdc: "200000", reason_hash: wrongHash && m === "dan" ? "0".repeat(64) : note(m).hash }, `2026-11-11T${t}Z`));
  }
  record.push(ev("cancel_spend", { spend_id: 0, by: N("cara") }, "2026-11-11T21:11:52Z"));
  if (later) for (const [m, t] of [["ben", "09:00"], ["cara", "09:01"]]) record.push(ev("exit", { account_id: N(m), shares: "100", near: "100000000000000000000000", usdc: "200000", reason_hash: null }, `2026-11-12T${t}:00Z`));
  const stayed = later ? [] : [N("ben"), N("cara")];
  return {
    vault: "vault.dissentfinance.near",
    code: "3jWHECjP5BCezXDBPR1XuQzb62KpBYaKZzhMXbmoHtWN",
    get_balances: { near: later ? "0" : "200000000000000000000000", usdc: later ? "0" : "400000", total_shares: later ? "0" : "200", members: stayed.length, open_spends: 0 },
    get_spend: { id: 0, proposal_id: 0, recipient: N("ben"), token: "Usdc", amount: "600000", approvers: [N("ben"), N("cara")], objectors: [], window_ends: "1794432072099800003", status: "Cancelled" },
    get_proposal: { id: 0, status: "Approved", votes: { [N("ben")]: "Approve", [N("cara")]: "Approve" } },
    get_record_len: record.length,
    get_record: record,
    contract_source_metadata: { link: "https://github.com/QijomoFav35/Dissent-Finance/tree/54ccf1b24c629e86ba1cb5d87b9ac80f3eb64f39" },
    get_shares: (a) => (stayed.includes(a.account_id) ? "100" : "0"),
    ft_balance_of: (a) => (["alice", "dan", "emma"].some((m) => a.account_id === N(m)) ? "200000" : a.account_id === "vault.dissentfinance.near" ? (later ? "0" : "400000") : "0"),
    get_ledger: () => ({ balance: later ? "0" : "400000", in_flight: "0", claimable: "0", pending_joins: "0", deposited: "1000000", spent: "0", fees: "0", exited: later ? "1000000" : "600000", refunded: "0" }),
    get_default_code_hash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF",
    get_default_version: [3, 2],
    get_factory_info: { factory_id: "sputnik-dao.near", auto_update: false },
    get_policy: { roles: [{ name: "council", kind: { Group: ["ben", "emma", "dan", "alice", "cara"].map(N) }, permissions: ["*:*"], vote_policy: {} }], default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" } },
  };
}

// v2's run on 12 November: the vault's record exactly as mainnet returns it (fixtures/v2-record.json,
// read with get_record on 2026-11-12), with the balances and shares the chain holds now.
function chainV2() {
  const record = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v2-record.json"), "utf8"));
  const base = chain();
  const stayed = [N("ben"), N("cara")];
  return {
    ...base,
    vault: "vault2.dissentfinance.near",
    code: "2CkdfmNBiPGukvkBpRm1AygHERiGDdPXf23eXPL58uVM",
    get_balances: { near: "200000000000000000000000", usdc: "400000", total_shares: "200000000000000000000000", members: 2, open_spends: 0 },
    get_spend: { ...base.get_spend, proposal_id: 1, queued_at: "1794490269844300751", window_ends: "1794490869844300751" },
    get_proposal: { ...base.get_proposal, id: 1 },
    get_record_len: record.length,
    get_record: record,
    get_shares: (a) => (stayed.includes(a.account_id) ? "100000000000000000000000" : "0"),
    contract_source_metadata: { link: "https://github.com/QijomoFav35/Dissent-Finance/tree/6ae02598ff28e45046523b940a6bcf061705fe50" },
    ft_balance_of: (a) => (["alice", "dan", "emma"].some((m) => a.account_id === N(m)) ? "200000" : a.account_id === "vault2.dissentfinance.near" ? "400000" : "0"),
  };
}

// v2 after round 3, as the chain holds it on 13 November: Alice, Dan and Emma back in, the share sale,
// spend 1 approved by Ben and Cara, Cara leaving while it was open, and spend 1 paid.
function chainV3() {
  const record = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v2-record-r3.json"), "utf8"));
  const v2 = chainV2();
  const spend1 = { id: 1, proposal_id: 3, recipient: N("ben"), token: "Usdc", amount: "70000", memo: "approver story", approvers: [N("ben"), N("cara")], objectors: [], queued_at: "1794563704159595345", window_ends: "1794564304159595345", status: "Executed" };
  const offer = { id: 0, seller: N("cara"), shares: "16327359938463994543033", reserve: "80999", ends_at: "1794563263529550665", best_bidder: N("dan"), best_bid: "85979", bids: 7, status: "Sold" };
  const shares = { [N("emma")]: "50000000000000000000000", [N("ben")]: "100000000000000000000000", [N("alice")]: "50000000000000000000000", [N("dan")]: "66327359938463994543033" };
  return {
    ...v2,
    get_record_len: record.length,
    get_record: record,
    get_spend: (a) => (a.spend_id === 1 ? spend1 : v2.get_spend),
    get_balances: { near: "266327359938463994543033", usdc: "479337", total_shares: "266327359938463994543033", members: 4, open_spends: 0 },
    get_members: Object.entries(shares),
    get_shares: (a) => shares[a.account_id] ?? "0",
    get_ledger: (a) => (a.token === "Usdc" ? { balance: "479337", in_flight: "0", claimable: "0", pending_joins: "0", deposited: "1300000", spent: "70000", fees: "70", exited: "750593", refunded: "0", held: "0" } : { balance: "266327359938463994543033", in_flight: "0", claimable: "0", pending_joins: "0", deposited: "653000000000000000000000", spent: "0", fees: "0", exited: "383672640061536005456967", refunded: "3000000000000000000000", held: "0" }),
    ft_balance_of: (a) => (a.account_id === "vault2.dissentfinance.near" ? "693358" : "0"),
    get_bid_funds_totals: ["214021", "300000"],
    get_open_offers: [],
    get_offers: (a) => (a.from_index === 0 ? [offer] : []),
    get_offer_count: 1,
    vaultKeys: [{ access_key: { permission: "FullAccess" } }],
  };
}

async function open(views, { width = 1200, query = "?v=vault", guard = { status: "in_progress", run_number: 7 } } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(/fastnear|near\.org|drpc|intea/, async (route) => {
    const body = JSON.parse(route.request().postData());
    const p = body.params;
    let result;
    if (p.request_type === "view_account") result = p.account_id === "dissentfinance.sputnik-dao.near" ? { code_hash: "11111111111111111111111111111111", global_contract_hash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF" } : { code_hash: views.code, amount: "1" };
    else if (p.request_type === "view_access_key_list") result = { keys: p.account_id.startsWith("vault") ? (views.vaultKeys ?? []) : [{ access_key: { permission: "FullAccess" } }, { access_key: { permission: { FunctionCall: { allowance: "248800000000000000000000", receiver_id: views.vault, method_names: ["exit", "cancel_spend"] } } } }] };
    else {
      let v = views[p.method_name];
      if (typeof v === "function") v = v(JSON.parse(Buffer.from(p.args_base64, "base64").toString()));
      // A method the code does not have answers the way NEAR RPC does.
      result = v === undefined ? { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } : { result: [...Buffer.from(JSON.stringify(v))] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
  });
  await page.route(/raw\.githubusercontent\.com/, async (route) => {
    const f = path.join(repo, route.request().url().split("/Dissent-Finance/")[1].replace(/^[^/]+\//, ""));
    if (fs.existsSync(f)) await route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "access-control-allow-origin": "*" } });
    else await route.fulfill({ status: 404, body: "" });
  });
  await page.route(/api\.github\.com/, async (route) => {
    if (guard === null) return route.fulfill({ status: 403, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ message: "API rate limit exceeded" }) });
    const run = { ...guard, html_url: "https://github.com/QijomoFav35/Dissent-Finance/actions/runs/1", run_started_at: new Date(Date.now() - 42 * 60000).toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ workflow_runs: [run] }) });
  });
  await page.goto(`file://${path.join(repo, "docs/index.html")}${query}`);
  await page.waitForFunction(() => !document.getElementById("status").textContent.includes("Reading"), null, { timeout: 20000 });
  const text = async (sel) => (await page.textContent(sel)).replace(/\s+/g, " ").trim();
  return { page, errors, text, close: () => browser.close() };
}

test("the v1 run: every check passes and the two outcomes read from the record", async () => {
  const p = await open(chain());
  try {
    assert.match(await p.text("#status"), /^All checks pass/);
    assert.match(await p.text("#checks"), /3 of 3 exit notes match the chain/);
    assert.match(await p.text("#vs-title"), /2 of 5 members approve paying Ben 60% of the fund/);
    assert.match(await p.text("#vs-left"), /0\.40 USDC left for all 5.*0\.08 instead of 0\.20/);
    const right = await p.text("#vs-right");
    assert.match(right, /Emma's agent exits, \+14 s.*Dan's agent exits, \+24 s.*Alice's agent exits, \+34 s.*Spend cancelled, \+46 s/);
    assert.match(await p.text("#vs-right-foot"), /0 USDC paid out/);
    assert.equal(await p.page.locator("#notes .ok").count(), 3);
    assert.equal(await p.page.locator("#timeline tr[data-live]").count(), 5);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("exits after the spend settled are history, not part of the spend", async () => {
  const p = await open(chain({ later: true }));
  try {
    const right = await p.text("#vs-right");
    assert.doesNotMatch(right, /Ben's agent exits|Cara's agent exits/);
    assert.equal(await p.page.locator("#timeline tr[data-live]").count(), 5);
    assert.equal(await p.page.locator("#timeline tr").count(), 12);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("a note whose hash does not match the chain fails the page's check", async () => {
  const p = await open(chain({ wrongHash: true }));
  try {
    assert.match(await p.text("#status"), /^A check failed/);
    assert.match(await p.text("#checks"), /2 of 3 exit notes match the chain/);
    assert.match(await p.text("#notes"), /Does not match the hash on chain/);
  } finally {
    await p.close();
  }
});

test("the proof panel reads the DAO, the agent keys and the books from the chain", async () => {
  const p = await open(chain());
  try {
    await p.page.waitForFunction(() => !document.getElementById("proofrows").textContent.includes("Reading"), null, { timeout: 20000 });
    const rows = await p.text("#proofrows");
    assert.match(rows, /PASS\s*The DAO runs unmodified Sputnik code\s*.*Sputnik 3\.2/);
    assert.match(rows, /PASS\s*The DAO.s policy\s*One council of 5 named members/);
    assert.match(rows, /PASS\s*Every agent key is limited to its job\s*5 of 5/);
    assert.match(rows, /PASS\s*Only the council can change the DAO.s code\s*Factory auto-update is off/);
    assert.match(rows, /PASS\s*The books balance\s*USDC: 1\.00 in, 0\.60 out to leavers/);
    assert.doesNotMatch(rows, /FAIL/);
    assert.equal(await p.page.locator("#keyrows tr").count(), 5);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("v2: its own record and notes, and the guard run on duty in the proof panel", async () => {
  const p = await open(chainV2(), { query: "" });
  try {
    await p.page.waitForFunction(() => !document.getElementById("proofrows").textContent.includes("Reading"), null, { timeout: 20000 });
    assert.match(await p.text("#status"), /^All checks pass/);
    assert.match(await p.text("#vs-right"), /Emma's agent exits, \+8\.027 s.*Alice's agent exits, \+8\.027 s.*Dan's agent exits, \+8\.687 s.*Spend cancelled, \+11\.209 s/);
    assert.match(await p.text("#proofrows"), /PASS\s*Agents on duty\s*A guard run is in progress: run #7, started 42 min ago/);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("share market: code from before it says so; after the redeploy, offers and bid funds read from the vault", async () => {
  let p = await open(chainV2(), { query: "" });
  try {
    await p.page.waitForFunction(() => !document.getElementById("mkt-state").classList.contains("pending"), null, { timeout: 20000 });
    assert.match(await p.text("#mkt-state"), /runs code from before the share market/);
  } finally {
    await p.close();
  }
  const offers = [
    { id: 0, seller: N("cara"), shares: "16327359938463994543033", reserve: "80999", ends_at: "1794563263529550665", best_bidder: N("dan"), best_bid: "85979", bids: 7, status: "Sold" },
    { id: 1, seller: N("ben"), shares: "20", reserve: "40000", ends_at: ts("2026-11-13T16:10:00Z"), best_bidder: null, best_bid: "0", bids: 0, status: "Open" },
  ];
  p = await open({ ...chainV2(), get_bid_funds_totals: ["203000", "300000"], get_open_offers: [offers[1]], get_offers: (a) => (a.from_index === 0 ? offers : []), get_offer_count: 2, get_factory_info: { factory_id: "sputnik-dao.near", auto_update: false } }, { query: "" });
  try {
    await p.page.waitForFunction(() => !document.getElementById("mkt-state").classList.contains("pending") && !document.getElementById("proofrows").textContent.includes("Reading"), null, { timeout: 20000 });
    assert.match(await p.text("#mkt-state"), /1 open offer\(s\), 1 sale\(s\) settled/);
    assert.match(await p.text("#mkt-funds"), /0\.203 USDC held for bids, 0\.3 USDC put in/);
    assert.match(await p.text("#mkt-offers"), /0\s*Cara\s*0\.080999 USDC\s*0\.085979 USDC by Dan \(7 bids\)\s*Sold/);
    // The bids from evidence.jsonl, matched against what the vault stored.
    await p.page.waitForFunction(() => !document.getElementById("mkt-bids-wrap").hidden, null, { timeout: 20000 });
    assert.equal(await p.page.locator("#mkt-bids tr").count(), 7);
    assert.match(await p.text("#mkt-bids-sub"), /^PASS\s*7 bids by the agents' own keys.*They match what the vault stored: 7 bids, the last 0\.085979 USDC by Dan\. Settled by Dan's agent/);
    assert.match(await p.text("#mkt-offers"), /1\s*Ben\s*0\.04 USDC\s*none yet\s*Open, ends 2026-11-13 16:10:00/);
    assert.match(await p.text("#proofrows"), /PASS\s*Only the council can change the DAO.s code\s*Factory auto-update is off/);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("after round 3: every row links its own transaction, and the approver's exit and spend 1 read from the chain", async () => {
  const p = await open(chainV3(), { query: "" });
  try {
    await p.page.waitForFunction(() => !document.getElementById("approver-wrap").hidden, null, { timeout: 20000 });
    const tl = await p.text("#timeline");
    // Spend 0 was queued by Cara's vote on proposal 1, spend 1 by her vote on proposal 3: never the other one.
    assert.match(tl, /spend 0: 0\.60 USDC to ben.*proposal 1: DpKwEZ8L/);
    assert.match(tl, /spend 1: 0\.07 USDC to ben.*proposal 3: 9MgxBmfv/);
    // The first joins and the rejoins each carry their own transaction.
    assert.match(tl, /alice joined again with 0\.05 NEAR and 0\.10 USDC CjTqZ3ij/);
    assert.equal((tl.match(/CjTqZ3ij/g) || []).length, 1, "Alice's rejoin transaction appears once, on the rejoin");
    assert.match(tl, /share sale\s*cara sold shares to dan for 0\.085979 USDC after 7 agent bids; the fund did not move A1cR7MQV/);
    assert.match(tl, /cara left with 0\.150593 USDC and 0\.08 NEAR, no rule broken: an approver leaving by choice; 0\.016752 USDC of her part held back for spend 1 53qLDWKV/);
    assert.match(tl, /paid\s*spend 1 paid 0\.07 USDC to ben plus a 0\.00007 USDC fee 9osUXBVn/);
    assert.doesNotMatch(tl, /\{"/, "no event is shown as raw JSON");
    const ap = await p.text("#approver");
    assert.match(ap, /approved by Ben and Cara\. Cara left 100\.137 s after it was queued, while it was still open/);
    assert.match(ap, /0\.016752 USDC, her part of the spend, stayed behind for it/);
    assert.match(ap, /Executed.*the members who stayed paid the other 0\.053318 USDC of its 0\.07007 USDC cost/);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("v2: when GitHub's API refuses, the guard row says so instead of failing", async () => {
  const p = await open(chainV2(), { query: "", guard: null });
  try {
    await p.page.waitForFunction(() => !document.getElementById("proofrows").textContent.includes("Reading"), null, { timeout: 20000 });
    assert.match(await p.text("#proofrows"), /INFO\s*Agents on duty\s*GitHub's API did not answer \(403, rate limit\)/);
  } finally {
    await p.close();
  }
});

test("try it: the agent's own rules.js decides, for presets and for your own rules", async () => {
  const p = await open(chainV2(), { query: "" });
  try {
    await p.page.waitForFunction(() => /Exit|Stay/.test(document.getElementById("try-verdict").textContent), null, { timeout: 20000 });
    assert.match(await p.text("#try-src"), /agent\/src\/rules\.js, \d+ lines, sha256 [0-9a-f]{16}/);
    await p.page.getByRole("button", { name: "Alice's rules" }).click();
    await p.page.waitForFunction(() => document.getElementById("try-verdict").textContent === "Exit before it pays");
    assert.match(await p.text("#try-checks"), /more than 20% of the fund\. This one takes 50%\. Broken\./);
    assert.match(await p.text("#try-share"), /joined with 0\.20 USDC like each of the five\. Your agent would take your 0\.20 USDC out before ben is paid/);
    await p.page.getByRole("button", { name: "Ben's rules" }).click();
    await p.page.waitForFunction(() => document.getElementById("try-verdict").textContent === "Stay");
    assert.match(await p.text("#try-checks"), /Voted Approve/);
    await p.page.uncheck("#try-appr");
    await p.page.uncheck("#try-max");
    await p.page.waitForFunction(() => document.getElementById("try-checks").textContent.includes("No rules set"));
    await p.page.check("#try-new");
    await p.page.waitForFunction(() => document.getElementById("try-verdict").textContent === "Exit before it pays");
    assert.match(await p.text("#try-hash"), /^sha256 of this note: [0-9a-f]{64}\. A real agent's note also carries the time/);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test("on a phone the page does not scroll sideways", async () => {
  const p = await open(chain(), { width: 390 });
  try {
    assert.equal(await p.page.evaluate(() => document.documentElement.scrollWidth), 390);
  } finally {
    await p.close();
  }
});

// SHOT=<folder> node --test page.test.js also saves full-page screenshots of v2 there, for review.
// README_SHOTS=docs/images node --test page.test.js saves the README's three screenshots: the checks at
// the top, the two outcomes, and the share market with its bids. v2 as the chain holds it after round 3.
if (process.env.README_SHOTS) {
  test("README screenshots", async () => {
    const offer = { id: 0, seller: N("cara"), shares: "16327359938463994543033", reserve: "80999", ends_at: "1794563263529550665", best_bidder: N("dan"), best_bid: "85979", bids: 7, status: "Sold" };
    const views = chainV3();
    const p = await open(views, { query: "", width: 1200 });
    try {
      await p.page.waitForFunction(() => !document.getElementById("proofrows").textContent.includes("Reading") && !document.getElementById("mkt-bids-wrap").hidden, null, { timeout: 20000 });
      await p.page.waitForTimeout(500);
      const shot = async (sel, name) => (await p.page.$(sel)).screenshot({ path: path.join(process.env.README_SHOTS, name), type: "jpeg", quality: 85 });
      await p.page.addStyleTag({ content: "header{position:static!important}" });
      await shot("main > section:first-of-type", "readme-checks.jpg");
      await shot("#outcomes", "readme-outcomes.jpg");
      await shot("#market", "readme-market.jpg");
    } finally {
      await p.close();
    }
  });
}

if (process.env.SHOT) {
  test("screenshots", async () => {
    for (const [name, width] of [["desktop", 1280], ["phone", 390]]) {
      const p = await open(chainV2(), { query: "", width });
      await p.page.waitForFunction(() => /Exit|Stay/.test(document.getElementById("try-verdict").textContent) && !document.getElementById("proofrows").textContent.includes("Reading"), null, { timeout: 20000 });
      await p.page.getByRole("button", { name: "Alice's rules" }).click();
      await p.page.waitForTimeout(400);
      await p.page.screenshot({ path: path.join(process.env.SHOT, `${name}.png`), fullPage: true });
      await p.close();
    }
  });
}
