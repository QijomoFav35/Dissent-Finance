#!/usr/bin/env node
// The third live run on vault2, after the vault is redeployed with the share market and the
// held-back exit. Every step reads the chain first, so the script is safe to run again, and without
// --go it only prints what it would send.
//
//   node mainnet/round3.mjs deploy-check <wasm> # after the build: is there NEAR for the bigger code?
//   node mainnet/round3.mjs prep               # plan only
//   node mainnet/round3.mjs prep --go          # DAO lock, Alice/Dan/Emma rejoin, bid funds, market keys
//   node mainnet/round3.mjs auction --go       # Cara offers shares worth 0.09 USDC; three agents bid
//   node mainnet/round3.mjs approver --go      # a spend Cara approves; she leaves; her part stays for it
//
// Keys: full-access keys in ~/.near-credentials/mainnet (near-cli's), new market keys written to
// ~/.near-credentials/dissent-agents/vault2-market. Nothing here prints a private key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { ROOT, USDC, DAO, VAULT, member, milli, NEAR, PROPOSAL_BOND, RPCS, log, near, usdc, signerFor, view, call, record, explorer, rpc, balance } from "./lib.mjs";
import { KeyCaller, MARKET_METHODS } from "../src/chain.js";
import { MarketAgent, REF, NEAR_USDC_POOL, nearPriceFromPool } from "../src/market.js";
import { VaultReader } from "../src/vault.js";
import { Rpc } from "../src/rpc.js";

const stage = process.argv[2];
const GO = process.argv.includes("--go");
const MARKET_KEYS = path.join(os.homedir(), ".near-credentials", "dissent-agents", "vault2-market");
const REJOIN = ["alice", "dan", "emma"];
const JOIN_USDC = 100_000n; // 0.1 USDC each, the vault's minimum join
const BID_FUNDS = 100_000n; // 0.1 USDC each for bidding
const OFFER_VALUE = 90_000n; // what Cara's offer is worth: under every agent's 0.1 USDC cap
// The NEAR price comes from the chain: Ref Finance's NEAR/USDC pool, read when Cara prices her offer
// and again by each agent at every tick (near_price "pool"). Nobody types it in.
const MARKET_RULES = {
  alice: { enabled: true, max_price_bps: 9500, max_spend: "100000", near_price: "pool" },
  dan: { enabled: true, max_price_bps: 9800, max_spend: "100000", near_price: "pool" },
  emma: { enabled: true, max_price_bps: 9200, max_spend: "100000", near_price: "pool" },
};
// Exit rules set again after the rejoin. Alice's is the README story's; Dan's and Emma's are loosened
// so the spend in the approver story breaks nobody's rules.
const EXIT_RULES = {
  alice: { max_spend_share_bps: 2000, new_recipient: false, blocked_recipients: [] },
  // Dan no longer leaves on a new receiver: Ben was never paid by v2, and round 3's own story is the
  // approver who leaves, not another rule exit.
  dan: { max_spend_share_bps: 5000, new_recipient: false, blocked_recipients: [] },
  // Emma no longer blocks Ben, so the approver story's spend to Ben trips nobody's rules.
  emma: { max_spend_share_bps: 3000, new_recipient: false, blocked_recipients: [] },
};

const plan = [];
async function step(what, cost, run) {
  plan.push(`${what}${cost ? ` (${cost})` : ""}`);
  if (!GO) return null;
  const hash = await run();
  log(`${what} ${hash ? explorer(hash) : ""}`);
  return hash;
}

async function newCode() {
  try {
    await view(VAULT, "get_bid_funds_totals");
    return true;
  } catch (e) {
    if (/MethodNotFound|METHOD_NOT_FOUND/.test(String(e?.message ?? e))) return false;
    throw e;
  }
}

// What this script has already done, from its own evidence lines, so a second run never repeats a
// proposal, a bond or a spend.
function done(step) {
  const file = new URL("./evidence.jsonl", import.meta.url);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.vault === VAULT && e.step === step);
}

// The id add_proposal returned, read from the transaction's result.
async function addProposal(who, description, kind) {
  const out = await signerFor(member(who)).callFunctionRaw({ contractId: DAO, methodName: "add_proposal", args: { proposal: { description, kind } }, deposit: PROPOSAL_BOND, gas: 50_000_000_000_000n });
  const st = out?.status;
  if (st && typeof st === "object" && "Failure" in st) throw new Error(`add_proposal failed: ${JSON.stringify(st.Failure).slice(0, 300)}`);
  const id = Number(JSON.parse(Buffer.from(st.SuccessValue, "base64").toString()));
  return { id, tx: out?.transaction?.hash ?? out?.transaction_outcome?.id };
}

async function prep() {
  // 1. Nobody outside the council can replace the DAO's code.
  if (!(await newCode())) throw new Error(`${VAULT} does not run the market code yet: redeploy it first (deploy-check, then near-cli)`);
  const info = await view(DAO, "get_factory_info");
  if (info.auto_update) {
    const kind = { FactoryInfoUpdate: { factory_info: { factory_id: info.factory_id, auto_update: false } } };
    // A proposal from an earlier run that is still open is voted on, never filed twice.
    const earlier = done("dao_lock_proposal").at(-1);
    let pid = earlier ? earlier.proposal_id : null;
    if (pid != null) {
      const p = await view(DAO, "get_proposal", { id: pid });
      if (p.status !== "InProgress") throw new Error(`DAO proposal ${pid} is ${p.status} but auto-update is still on: look before filing another`);
      log(`DAO proposal ${pid} from an earlier run is still open`);
    } else {
      await step("ben files a DAO proposal: turn off factory auto-update", "0.01 NEAR bond, returned when it passes, plus gas", async () => {
        const r = await addProposal("ben", "turn off factory auto-update", kind);
        pid = r.id;
        record("dao_lock_proposal", { proposal_id: pid, tx: r.tx });
        return r.tx;
      });
    }
    for (const v of ["ben", "cara"]) {
      if (GO) {
        const p = await view(DAO, "get_proposal", { id: pid });
        if (p.votes?.[member(v)] || p.status !== "InProgress") continue;
      }
      await step(`${v} approves the auto-update proposal`, "gas", async () => {
        const h = await call(signerFor(member(v)), DAO, "act_proposal", { id: pid, action: "VoteApprove", proposal: kind }, { tgas: 120 });
        record("dao_lock_vote", { voter: member(v), proposal_id: pid, tx: h });
        return h;
      });
    }
    if (GO && (await view(DAO, "get_factory_info")).auto_update) throw new Error("the DAO's auto-update is still on after the votes");
  } else {
    log("the DAO's factory auto-update is already off");
  }

  // 2. Alice, Dan and Emma rejoin with 0.1 USDC each and set their exit rules again.
  for (const m of REJOIN) {
    const id = member(m);
    const shares = BigInt(await view(VAULT, "get_shares", { account_id: id }));
    if (shares > 0n) {
      log(`${m} is already a member`);
      const have = await view(VAULT, "get_rules", { account_id: id });
      const want = EXIT_RULES[m];
      const same = have && have.max_spend_share_bps === want.max_spend_share_bps && have.new_recipient === want.new_recipient && JSON.stringify(have.blocked_recipients ?? []) === JSON.stringify(want.blocked_recipients);
      if (!same) await step(`${m} sets round 3's exit rules`, "gas", () => call(signerFor(id), VAULT, "set_rules", { rules: want }, { tgas: 30 }));
      continue;
    }
    const { amount: nearHave } = await balance(id);
    const wallet = BigInt(await view(USDC, "ft_balance_of", { account_id: id }));
    if (wallet < JOIN_USDC + BID_FUNDS) throw new Error(`${m} holds ${usdc(wallet)} USDC; needs ${usdc(JOIN_USDC + BID_FUNDS)} to rejoin and fund bids`);
    const b = await view(VAULT, "get_balances");
    // NEAR to match the fund's ratio for 0.1 USDC, plus a thousandth for rounding (the rest is refunded).
    const nearIn = (JOIN_USDC * BigInt(b.near) + BigInt(b.usdc) - 1n) / BigInt(b.usdc) + milli(1);
    // The account keeps its own storage (about 0.002 NEAR for a bare sub-account) and pays gas.
    if (nearHave < nearIn + milli(10)) throw new Error(`${m} holds ${near(nearHave)} NEAR; needs about ${near(nearIn + milli(10))} to rejoin and pay gas`);
    log(`${m}: ${near(nearHave)} NEAR, ${usdc(wallet)} USDC in the wallet`);
    const pending = BigInt(await view(VAULT, "get_pending", { account_id: id }));
    if (pending < JOIN_USDC) {
      await step(`${m} sends 0.1 USDC to the vault to join`, "gas", () => call(signerFor(id), USDC, "ft_transfer_call", { receiver_id: VAULT, amount: String(JOIN_USDC - pending), msg: "join" }, { deposit: 1n, tgas: 60 }));
    }
    await step(`${m} joins with ${near(nearIn)} NEAR`, `${near(nearIn)} NEAR of their own, back when they exit`, async () => {
      const h = await call(signerFor(id), VAULT, "join", {}, { deposit: nearIn, tgas: 100 });
      record("join", { account: id, tx: h, round: 3 });
      return h;
    });
    await step(`${m} sets exit rules again`, "gas", () => call(signerFor(id), VAULT, "set_rules", { rules: EXIT_RULES[m] }, { tgas: 30 }));
  }

  // 3. Bid funds: 0.1 USDC each, kept inside the vault for their market agents.
  for (const m of REJOIN) {
    const id = member(m);
    if (GO && BigInt(await view(VAULT, "get_shares", { account_id: id })) === 0n) throw new Error(`${m} holds no shares, so the vault would send bid funds back`);
    const funds = GO ? BigInt(await view(VAULT, "get_bid_funds", { account_id: id })) : 0n;
    if (funds >= BID_FUNDS) {
      log(`${m} already has ${usdc(funds)} USDC of bid funds`);
      continue;
    }
    await step(`${m} puts 0.1 USDC of bid funds in the vault`, "gas", async () => {
      const h = await call(signerFor(id), USDC, "ft_transfer_call", { receiver_id: VAULT, amount: String(BID_FUNDS), msg: "bid_funds" }, { deposit: 1n, tgas: 60 });
      // ft_transfer_call succeeds even when the vault sends the USDC back, so read what it kept.
      const now = BigInt(await view(VAULT, "get_bid_funds", { account_id: id }));
      if (now < funds + BID_FUNDS) throw new Error(`${m}'s bid funds are ${usdc(now)} USDC after the deposit: the vault sent it back (${explorer(h)})`);
      record("bid_funds", { account: id, usdc: String(BID_FUNDS), tx: h });
      return h;
    });
  }

  // 4. A market key for each market agent: bid and settle, nothing else.
  fs.mkdirSync(MARKET_KEYS, { recursive: true, mode: 0o700 });
  for (const m of REJOIN) {
    const id = member(m);
    const file = path.join(MARKET_KEYS, `${id}.json`);
    let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (!saved && GO) {
      const kp = KeyPair.fromRandom("ed25519");
      saved = { account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString(), added: false };
      fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    }
    if (saved?.added) {
      log(`${m}'s market key is on chain`);
      continue;
    }
    await step(`${m} adds a market key (${MARKET_METHODS.join(", ")} on ${VAULT}, 0.1 NEAR gas allowance)`, "key storage, under 0.001 NEAR", async () => {
      const out = await signerFor(id).addFunctionCallAccessKey({ publicKey: saved.public_key, contractId: VAULT, methodNames: MARKET_METHODS, allowance: milli(100) });
      saved.added = true;
      fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      record("market_key", { account: id, public_key: saved.public_key, methods: MARKET_METHODS, tx: out?.transaction?.hash });
      return out?.transaction?.hash;
    });
  }
}

function marketCaller(m) {
  const id = member(m);
  const { private_key } = JSON.parse(fs.readFileSync(path.join(MARKET_KEYS, `${id}.json`), "utf8"));
  return new KeyCaller({ accountId: id, secretKey: private_key, rpcUrls: RPCS, vaultId: VAULT, methods: MARKET_METHODS });
}

async function auction() {
  if (!(await newCode())) throw new Error("vault2 does not have the share market yet: redeploy first");
  const cara = member("cara");
  let open = await view(VAULT, "get_open_offers");
  let offer = open.find((o) => o.seller === cara);
  if (!offer) {
    const shares = BigInt(await view(VAULT, "get_shares", { account_id: cara }));
    const b = await view(VAULT, "get_balances");
    const lu = await view(VAULT, "get_ledger", { token: "Usdc" });
    const ln = await view(VAULT, "get_ledger", { token: "Near" });
    const total = BigInt(b.total_shares);
    const pool = await view(REF, "get_pool", { pool_id: NEAR_USDC_POOL });
    const NEAR_PRICE = nearPriceFromPool(pool);
    log(`NEAR price from ${REF} pool ${NEAR_USDC_POOL}: ${usdc(NEAR_PRICE)} USDC (reserves ${JSON.stringify(pool.amounts)})`);
    const worth = (n) => ((BigInt(lu.balance) - BigInt(lu.held)) * n) / total + ((((BigInt(ln.balance) - BigInt(ln.held)) * n) / total) * NEAR_PRICE) / NEAR;
    // Each agent can lock at most 0.1 USDC, so Cara offers shares worth about 0.09 USDC.
    const all = worth(shares);
    if (all === 0n) throw new Error("Cara's shares are worth nothing at this NEAR price");
    const half = all > OFFER_VALUE ? (shares * OFFER_VALUE) / all : shares / 2n;
    const value = worth(half);
    const reserve = (value * 9000n) / 10_000n;
    log(`Cara offers ${half} of her ${shares} shares, worth ${usdc(value)} USDC at ${usdc(NEAR_PRICE)} USDC per NEAR; reserve ${usdc(reserve)} (90%)`);
    if ((await view(VAULT, "get_open_spends")).length) throw new Error("a spend is open: no offers until it settles");
    // Offering shares takes Cara's own key; agent keys can only bid and settle.
    await step("cara offers part of her shares, with her own key", "gas", async () => {
      const h = await call(signerFor(cara), VAULT, "offer_shares", { shares: String(half), reserve: String(reserve) }, { tgas: 30 });
      record("offer", { seller: cara, shares: String(half), reserve: String(reserve), value: String(value), near_price: String(NEAR_PRICE), price_source: `${REF} pool ${NEAR_USDC_POOL}`, pool_amounts: pool.amounts, tx: h });
      return h;
    });
    if (!GO) return;
    open = await view(VAULT, "get_open_offers");
    offer = open.find((o) => o.seller === cara);
  }
  if (!GO) return;
  log(`offer ${offer.id} ends at ${new Date(Number(BigInt(offer.ends_at) / 1_000_000n)).toISOString()}. Three agents bid by their own rules; nobody acts by hand.`);
  const reader = new VaultReader(new Rpc(RPCS, { finality: "optimistic" }), VAULT);
  const agents = REJOIN.map((m) => new MarketAgent({ member: member(m), rules: MARKET_RULES[m], reader, caller: marketCaller(m), log: (l) => log(`[${m}] ${l}`) }));
  // Stop if nothing has settled well after the end (a stuck RPC, a spend opened meanwhile).
  const deadline = Number(BigInt(offer.ends_at) / 1_000_000n) + 15 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`offer ${offer.id} not settled 15 minutes after it ended; anyone can still call settle_offer`);
    for (const [i, a] of agents.entries()) {
      try {
        const r = await a.tick();
        for (const b of r.bids) record("market_bid", { offer_id: b.offer, bidder: member(REJOIN[i]), usdc: b.amount, value: b.value, limit: b.limit, near_price: String(a.lastNearPrice), tx: b.tx, source: "market agent" });
        for (const s of r.settled) if (s.tx) record("market_settle", { offer_id: s.offer, by: member(REJOIN[i]), tx: s.tx, source: "market agent" });
      } catch (e) {
        log(`[${REJOIN[i]}] tick failed: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
    const o = await view(VAULT, "get_offer", { offer_id: offer.id });
    if (!o || o.status !== "Open") {
      log(o ? `offer ${o.id} ${o.status}: ${o.shares} shares to ${o.best_bidder} for ${usdc(o.best_bid)} USDC after ${o.bids} bids` : `offer ${offer.id} ended unsold`);
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function approver() {
  if (!(await newCode())) throw new Error("vault2 does not have the held-back exit yet: redeploy first");
  const ben = member("ben");
  const cara = member("cara");
  const earlier = done("propose").filter((e) => e.round === 3);
  if (earlier.length) throw new Error(`the approver story already ran (proposal ${earlier[0].proposal_id}); run execute after its window`);
  if (BigInt(await view(VAULT, "get_shares", { account_id: cara })) === 0n) throw new Error("Cara holds no shares");
  if ((await view(VAULT, "get_open_spends")).length) throw new Error("a spend is already open");
  if ((await view(VAULT, "get_open_offers")).length) throw new Error("an offer is open: settle it first (auction stage)");
  const b = await view(VAULT, "get_balances");
  const amount = BigInt(b.usdc) / 10n; // a tenth of the fund to Ben: under every member's rules
  const pid = await view(DAO, "get_last_proposal_id");
  const args = Buffer.from(JSON.stringify({ proposal_id: pid, recipient: ben, token_id: USDC, amount: String(amount), memo: "approver story" }));
  const kind = { FunctionCall: { receiver_id: VAULT, actions: [{ method_name: "queue_spend", args: args.toString("base64"), deposit: "0", gas: "60000000000000" }] } };
  await step(`ben proposes ${usdc(amount)} USDC to himself (proposal ${pid})`, "0.01 NEAR bond, returned, plus gas", async () => {
    const r = await addProposal("ben", "approver story", kind);
    // The spend's arguments name the id read before filing; another proposal in between breaks that.
    if (r.id !== pid) {
      record("propose_mismatch", { proposal_id: r.id, expected: pid, tx: r.tx, round: 3 });
      throw new Error(`the DAO gave id ${r.id}, not ${pid}: someone filed a proposal at the same moment. Not voting; run approver again to file a fresh one`);
    }
    record("propose", { proposal_id: r.id, amount: String(amount), tx: r.tx, round: 3 });
    return r.tx;
  });
  for (const v of ["ben", "cara"]) {
    await step(`${v} approves`, "gas", async () => {
      const h = await call(signerFor(member(v)), DAO, "act_proposal", { id: pid, action: "VoteApprove", proposal: kind }, { tgas: 120 });
      record("vote", { voter: member(v), proposal_id: pid, tx: h, round: 3 });
      return h;
    });
  }
  if (!GO) return;
  const spend = await view(VAULT, "get_spend_by_proposal", { proposal_id: pid });
  const quote = await view(VAULT, "get_exit_quote", { account_id: cara });
  log(`spend ${spend.id} queued. Cara approved it; leaving now pays her ${usdc(quote[1])} USDC and holds her part back for it.`);
  const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".near-credentials", "dissent-agents", "vault2", `${cara}.json`), "utf8")).private_key;
  const r = await new KeyCaller({ accountId: cara, secretKey: key, rpcUrls: RPCS, vaultId: VAULT }).exit(null);
  if (!r.ok) throw new Error(`Cara's exit refused: ${JSON.stringify(r.failure).slice(0, 200)}`);
  const holds = await view(VAULT, "get_holds", { spend_id: spend.id });
  log(`Cara left ${explorer(r.hash)}; held for spend ${spend.id}: ${JSON.stringify(holds)}`);
  record("approver_exit", { account: cara, spend_id: spend.id, usdc_out: quote[1], holds, tx: r.hash, round: 3 });
  log(`after the window (${new Date(Number(BigInt(spend.window_ends) / 1_000_000n)).toISOString()}), run: node mainnet/round3.mjs execute --go`);
}

async function execute() {
  const open = await view(VAULT, "get_open_spends");
  for (const s of open) {
    if (Date.now() * 1e6 < Number(s.window_ends)) {
      log(`spend ${s.id} window still open`);
      continue;
    }
    await step(`anyone executes spend ${s.id}`, "gas", async () => {
      const h = await call(signerFor(member("ben")), VAULT, "execute_spend", { spend_id: s.id }, { tgas: 100 });
      record("execute_spend", { spend_id: s.id, tx: h, round: 3 });
      return h;
    });
  }
}

// The new code is bigger, and the vault pays for its own code storage (1 NEAR per 100 kB).
async function deployCheck() {
  const wasm = process.argv[3];
  if (!wasm || !fs.existsSync(wasm)) throw new Error("usage: node mainnet/round3.mjs deploy-check <path to the reproducible build's .wasm>");
  const newSize = BigInt(fs.statSync(wasm).size);
  const acct = await rpc.query({ request_type: "view_account", account_id: VAULT });
  const code = await rpc.query({ request_type: "view_code", account_id: VAULT });
  const oldSize = BigInt(Buffer.from(code.code_base64, "base64").length);
  const ln = await view(VAULT, "get_ledger", { token: "Near" });
  const amount = BigInt(acct.amount);
  const PER_BYTE = 10n ** 19n;
  const storageNow = BigInt(acct.storage_usage) * PER_BYTE;
  // Room for the market's records (offers, bid funds) on top of the code.
  const storageAfter = (BigInt(acct.storage_usage) - oldSize + newSize + 20_000n) * PER_BYTE;
  // The fund's NEAR, NEAR on its way out and NEAR members can claim are not the vault's to spend on storage.
  const owed = BigInt(ln.balance) + BigInt(ln.in_flight) + BigInt(ln.claimable);
  const spare = amount - owed;
  log(`code ${oldSize} -> ${newSize} bytes; storage now ${near(storageNow)} NEAR, after about ${near(storageAfter)} NEAR (20 kB room for market records)`);
  log(`vault holds ${near(amount)} NEAR, of which ${near(owed)} is the fund's; ${near(spare)} NEAR pays for storage`);
  const need = storageAfter > spare ? storageAfter - spare + milli(10) : 0n;
  if (need === 0n) return log("no top-up needed");
  await step(`${ROOT} sends ${near(need)} NEAR to ${VAULT} for storage`, `${near(need)} NEAR, stays in the vault account`, async () => {
    const h = await call(signerFor(ROOT), VAULT, "__transfer__", null, { deposit: need });
    record("storage_top_up", { near: String(need), new_code_bytes: String(newSize), tx: h });
    return h;
  });
}

const stages = { "deploy-check": deployCheck, prep, auction, approver, execute };
if (!stages[stage]) {
  console.error("usage: node mainnet/round3.mjs <deploy-check|prep|auction|approver|execute> [--go]");
  process.exit(2);
}
stages[stage]()
  .then(() => {
    if (!GO) {
      log("plan (nothing sent; add --go to do it):");
      for (const p of plan) console.log(`  - ${p}`);
    }
  })
  .catch((e) => {
    console.error(`stopped: ${e?.message ?? e}`);
    process.exit(1);
  });
