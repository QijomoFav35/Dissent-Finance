// The market agent's decisions, the agent loop against a stand-in vault, and the 20-agent simulation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shareValue, minBid, decideBid, MarketAgent } from "../src/market.js";
import { simulate, summary } from "../sim/market.js";

const USDC = 1_000_000n;
const offer = (o = {}) => ({ id: 0, seller: "alice.near", shares: String(50n * USDC), reserve: String(45n * USDC), ends_at: String(10n ** 30n), bids: 0, best_bid: "0", best_bidder: null, ...o });
const rules = (r = {}) => ({ enabled: true, max_price_bps: 9500, max_spend: null, ...r });

test("shares are worth their part of the free USDC, less their part of open spends", () => {
  assert.equal(shareValue(50n, { freeUsdc: 500n, totalShares: 500n }), 50n);
  assert.equal(shareValue(50n, { freeUsdc: 500n, totalShares: 500n, openSpendsUsdc: 300n }), 20n);
  assert.equal(shareValue(50n, { freeUsdc: 100n, totalShares: 500n, openSpendsUsdc: 300n }), 0n);
  assert.equal(shareValue(50n, { freeUsdc: 500n, totalShares: 0n }), 0n);
  // A tenth of a fund holding 2 NEAR, at 3.40 USDC per NEAR, adds 0.68 USDC.
  assert.equal(shareValue(50n, { freeUsdc: 0n, totalShares: 500n, freeNear: 2n * 10n ** 24n, nearPrice: 3_400_000n }), 680_000n);
});

test("the smallest bid mirrors the vault: the reserve, then 1% above the best, at least one unit", () => {
  assert.equal(minBid(offer()), 45n * USDC);
  assert.equal(minBid(offer({ bids: 1, best_bid: String(48n * USDC) })), 48n * USDC + 480_000n);
  assert.equal(minBid(offer({ bids: 1, best_bid: "50" })), 51n);
});

test("an agent bids the least that leads, never above its member's limit", () => {
  const value = 50n * USDC;
  const d = decideBid({ offer: offer(), me: "dan.near", rules: rules(), value, funds: 100n * USDC });
  assert.equal(d.bid, 45n * USDC);
  assert.equal(d.limit, 47_500_000n);
});

test("limits: price, a spend cap and the funds behind the bid each stop an agent", () => {
  const value = 50n * USDC;
  const at = offer({ bids: 1, best_bid: String(47n * USDC), best_bidder: "emma.near" });
  // 47 + 1% = 47.47, under the 47.50 price limit: bids.
  assert.equal(decideBid({ offer: at, me: "dan.near", rules: rules(), value, funds: 100n * USDC }).bid, 47_470_000n);
  // A spend cap of 47 stops it.
  assert.match(decideBid({ offer: at, me: "dan.near", rules: rules({ max_spend: String(47n * USDC) }), value, funds: 100n * USDC }).why, /needs/);
  // So do funds of 47.
  assert.match(decideBid({ offer: at, me: "dan.near", rules: rules(), value, funds: 47n * USDC }).why, /needs/);
  // A 90% limit is 45: it cannot beat 47.
  assert.match(decideBid({ offer: at, me: "dan.near", rules: rules({ max_price_bps: 9000 }), value, funds: 100n * USDC }).why, /needs/);
});

test("an agent never bids on its own offer, against itself, or with the market off", () => {
  const value = 50n * USDC;
  assert.equal(decideBid({ offer: offer(), me: "alice.near", rules: rules(), value, funds: 100n * USDC }).why, "own offer");
  assert.equal(decideBid({ offer: offer({ bids: 1, best_bid: "1", best_bidder: "dan.near" }), me: "dan.near", rules: rules(), value, funds: 100n * USDC }).why, "already leading");
  assert.equal(decideBid({ offer: offer(), me: "dan.near", rules: rules({ enabled: false }), value, funds: 100n * USDC }).why, "market off");
});

function standIn({ offers, now }) {
  const calls = [];
  return {
    calls,
    reader: {
      openOffers: async () => offers,
      balances: async () => ({ total_shares: String(500n * USDC) }),
      ledger: async (t) => (t === "Usdc" ? { balance: String(500n * USDC), held: "0" } : { balance: "0", held: "0" }),
      openSpends: async () => [],
      bidFunds: async () => 60n * USDC,
    },
    caller: {
      bid: async (id, amount) => (calls.push(["bid", id, String(amount)]), { ok: true, hash: `tx-bid-${id}` }),
      settleOffer: async (id) => (calls.push(["settle", id]), id === 9 ? { ok: false, failure: { ActionError: "ERR_OFFER_CLOSED" } } : { ok: true, hash: `tx-settle-${id}` }),
    },
    now: () => now,
  };
}

test("the agent bids on open offers and settles the ones that have ended", async () => {
  const nowMs = 1_000_000;
  const endedNs = String(BigInt(nowMs - 1) * 1_000_000n);
  const s = standIn({ offers: [offer({ id: 1 }), offer({ id: 2, ends_at: endedNs }), offer({ id: 3, seller: "dan.near" }), offer({ id: 9, ends_at: endedNs })], now: nowMs });
  const agent = new MarketAgent({ member: "dan.near", rules: rules(), reader: s.reader, caller: s.caller, now: s.now });
  const r = await agent.tick();
  assert.deepEqual(s.calls, [["bid", 1, String(45n * USDC)], ["settle", 2], ["settle", 9]]);
  assert.deepEqual(r.settled.map((x) => x.offer), [2, 9], "an offer someone else settled first counts as settled");
  assert.deepEqual(r.skipped, [{ offer: 3, why: "own offer" }]);
});

test("the agent stops bidding when its funds run out across offers", async () => {
  const s = standIn({ offers: [offer({ id: 1 }), offer({ id: 2 })], now: 0 });
  s.reader.bidFunds = async () => 50n * USDC; // enough for one 45 bid, not two
  const agent = new MarketAgent({ member: "dan.near", rules: rules(), reader: s.reader, caller: s.caller, now: s.now });
  const r = await agent.tick();
  assert.equal(r.bids.length, 1);
  assert.match(r.skipped[0].why, /needs/);
});

test("simulation: 20 agents trade, the fund and every unit of USDC and shares are conserved", () => {
  for (const seed of [1, 2, 3]) {
    const run = simulate({ seed });
    assert.equal(run.members, 20);
    assert.equal(run.fundsIn, run.fundsOut, "no USDC appears or disappears");
    assert.equal(run.totalShares, String(20n * 100n * USDC), "shares only change hands");
    for (const a of run.results.filter((r) => r.sold)) {
      assert.ok(BigInt(a.price) >= BigInt(a.reserve), "never below the reserve");
      assert.ok(BigInt(a.price) <= BigInt(a.value), "no agent pays more than the shares are worth (limits are at most 100%)");
      assert.equal(a.best_limit_won, true, "the agent willing to pay the most wins");
    }
  }
});

test("simulation: the same seed gives the same market, and the summary is stable", () => {
  assert.deepEqual(simulate({ seed: 1 }), simulate({ seed: 1 }));
  const s = summary(simulate({ seed: 1 }));
  assert.equal(s.auctions, 30);
  assert.equal(s.sold, 22);
  assert.equal(s.best_limit_won_pct, 100);
});
