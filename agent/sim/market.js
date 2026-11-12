#!/usr/bin/env node
// Market simulation: 20 member agents, each with its own pricing rules and bid funds, trade shares in
// 30 auctions. Every bid decision is the decideBid() the live market agent runs; the auction follows
// the contract's rules (reserve, then each bid at least 1% above the best, highest bid wins).
//
//   node sim/market.js            # summary table
//   node sim/market.js --json     # every auction
//   node sim/market.js --seed 7   # another population
//
// Modelled: the members, their rules and funds, which member sells, how much and at what reserve,
// and the order agents look at an offer (random each round). Real: the decision code and the rules.

import { decideBid, shareValue, minBid } from "../src/market.js";

const USDC = 1_000_000n;

/** A small seeded generator, so a run can be repeated exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function population(n, rand) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `m${String(i + 1).padStart(2, "0")}`,
      shares: 100n * USDC, // equal shares: one share unit per USDC unit put in
      funds: BigInt(20 + Math.floor(rand() * 131)) * USDC,
      rules: {
        enabled: rand() < 0.85,
        max_price_bps: 8000 + Math.floor(rand() * 21) * 100, // 80% to 100% of value
        max_spend: String(BigInt(20 + Math.floor(rand() * 131)) * USDC),
      },
    });
  }
  return out;
}

/** Runs one auction to the end the way the vault would, with agents acting in random order. */
export function runAuction({ members, fund, offer, rand }) {
  const totalShares = members.reduce((a, m) => a + m.shares, 0n);
  const value = shareValue(offer.shares, { freeUsdc: fund, totalShares });
  const state = { ...offer, bids: 0, best_bid: "0", best_bidder: null };
  const log = [];
  for (let round = 0; round < 500; round++) {
    let moved = false;
    const order = [...members].sort(() => rand() - 0.5);
    for (const m of order) {
      if (m.shares === 0n) continue;
      const d = decideBid({ offer: state, me: m.id, rules: m.rules, value, funds: m.funds });
      if (d.bid == null) continue;
      // The vault's checks: reserve or +1%, and funds behind the bid.
      if (d.bid < minBid(state) || d.bid > m.funds) throw new Error("decideBid broke the vault's rules");
      if (state.best_bidder) members.find((x) => x.id === state.best_bidder).funds += BigInt(state.best_bid);
      m.funds -= d.bid;
      state.best_bid = String(d.bid);
      state.best_bidder = m.id;
      state.bids += 1;
      log.push({ bidder: m.id, bid: String(d.bid) });
      moved = true;
    }
    if (!moved) break;
  }
  const limits = members
    .filter((m) => m.id !== offer.seller && m.shares > 0n && m.rules.enabled)
    .map((m) => ({ id: m.id, limit: decideBid({ offer: { ...state, bids: 0, best_bid: "0", best_bidder: null, reserve: "1" }, me: m.id, rules: m.rules, value, funds: m.funds + (state.best_bidder === m.id ? BigInt(state.best_bid) : 0n) }).limit }))
    .sort((a, b) => (a.limit === b.limit ? 0 : a.limit > b.limit ? -1 : 1));
  const sold = state.best_bidder != null;
  if (sold) {
    const seller = members.find((m) => m.id === offer.seller);
    const buyer = members.find((m) => m.id === state.best_bidder);
    seller.shares -= offer.shares;
    buyer.shares += offer.shares;
    seller.funds += BigInt(state.best_bid); // the seller is paid in USDC; here it lands in their funds
  }
  return {
    seller: offer.seller,
    shares: String(offer.shares),
    value: String(value),
    reserve: offer.reserve,
    sold,
    price: sold ? state.best_bid : null,
    price_bps: sold && value > 0n ? Number((BigInt(state.best_bid) * 10_000n) / value) : null,
    buyer: state.best_bidder,
    bids: state.bids,
    // Did the agent willing to pay the most win? With ascending bids and a 1% step it should.
    best_limit_won: sold ? limits[0]?.id === state.best_bidder || limits[0]?.limit === limits.find((l) => l.id === state.best_bidder)?.limit : null,
    log,
  };
}

export function simulate({ seed = 1, members = 20, auctions = 30 } = {}) {
  const rand = rng(seed);
  const pop = population(members, rand);
  const fund = pop.reduce((a, m) => a + m.shares, 0n); // 1 USDC of fund per share unit put in
  const fundsIn = pop.reduce((a, m) => a + m.funds, 0n);
  const results = [];
  for (let i = 0; i < auctions; i++) {
    const holders = pop.filter((m) => m.shares > 0n);
    const seller = holders[Math.floor(rand() * holders.length)];
    const fraction = BigInt(10 + Math.floor(rand() * 91)); // 10% to 100% of their shares
    const shares = (seller.shares * fraction) / 100n;
    if (shares === 0n) continue;
    const totalShares = pop.reduce((a, m) => a + m.shares, 0n);
    const value = shareValue(shares, { freeUsdc: fund, totalShares });
    const reserve = (value * BigInt(8500 + Math.floor(rand() * 14) * 100)) / 10_000n;
    results.push({ id: i, ...runAuction({ members: pop, fund, offer: { id: i, seller: seller.id, shares, reserve: String(reserve) }, rand }) });
  }
  const totalShares = pop.reduce((a, m) => a + m.shares, 0n);
  const fundsOut = pop.reduce((a, m) => a + m.funds, 0n);
  return { seed, members: pop.length, fund: String(fund), totalShares: String(totalShares), fundsIn: String(fundsIn), fundsOut: String(fundsOut), results };
}

export function summary(run) {
  const sold = run.results.filter((r) => r.sold);
  const bps = sold.map((r) => r.price_bps).sort((a, b) => a - b);
  const median = bps.length ? bps[Math.floor(bps.length / 2)] : null;
  return {
    auctions: run.results.length,
    sold: sold.length,
    median_price_pct_of_value: median == null ? null : median / 100,
    lowest_price_pct: bps.length ? bps[0] / 100 : null,
    highest_price_pct: bps.length ? bps[bps.length - 1] / 100 : null,
    mean_bids: sold.length ? +(sold.reduce((a, r) => a + r.bids, 0) / sold.length).toFixed(1) : 0,
    best_limit_won_pct: sold.length ? Math.round((100 * sold.filter((r) => r.best_limit_won).length) / sold.length) : null,
    fund_unchanged: true,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seedArg = process.argv.includes("--seed") ? Number(process.argv[process.argv.indexOf("--seed") + 1]) : 1;
  const run = simulate({ seed: seedArg });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    const s = summary(run);
    console.log(`20 agents, 30 auctions, seed ${seedArg}. The fund (${Number(BigInt(run.fund) / USDC)} USDC) never moves; shares and USDC move between members.\n`);
    console.log("| auctions | sold | median price, % of value | range | bids per sale | highest limit won |");
    console.log("|---|---|---|---|---|---|");
    console.log(`| ${s.auctions} | ${s.sold} | ${s.median_price_pct_of_value}% | ${s.lowest_price_pct}% to ${s.highest_price_pct}% | ${s.mean_bids} | ${s.best_limit_won_pct}% |`);
  }
}
