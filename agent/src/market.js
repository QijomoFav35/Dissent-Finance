// The market agent: bids for other members' shares by its own member's rules, and settles auctions
// that have ended. Pure decisions first, so the simulation and the live agent run the same code.
//
// Market rules, set by each member (agent config, not on chain):
//   max_price_bps   the most it pays, as basis points of what the shares are worth (9500 = 95%)
//   max_spend       the most USDC (6-decimal units) it locks in one bid
//   enabled         false to never bid
//   near_price      what the member counts 1 NEAR as, in USDC units (bids are in USDC; shares also
//                   carry part of the fund's NEAR). 0 or missing counts the NEAR side as nothing.
//
// What shares are worth: their pro-rata part of the fund's USDC, less their part of every open USDC
// spend as if those spends paid (buyers inherit the spends), plus the same for NEAR at the member's
// own NEAR price. Money held back from leavers is part of the balance and pays part of its spend,
// so it is counted once: in the balance, against the full spend.

const YOCTO = 10n ** 24n;

/** USDC value of `shares`, in units. */
export function shareValue(shares, { freeUsdc, totalShares, openSpendsUsdc = 0n, freeNear = 0n, nearPrice = 0n }) {
  if (totalShares === 0n) return 0n;
  const base = freeUsdc > openSpendsUsdc ? freeUsdc - openSpendsUsdc : 0n;
  const usdcPart = (base * shares) / totalShares;
  const nearPart = (((freeNear * shares) / totalShares) * BigInt(nearPrice)) / YOCTO;
  return usdcPart + nearPart;
}

/** The smallest bid the vault accepts on an offer (mirrors the contract: reserve, then +1%). */
export function minBid(offer) {
  const best = BigInt(offer.best_bid);
  if (Number(offer.bids) === 0) return BigInt(offer.reserve);
  const raise = best / 100n;
  return best + (raise > 0n ? raise : 1n);
}

/**
 * Whether and how much to bid. English-auction behaviour: bid the minimum that leads, never above
 * the member's limit, so the winner pays about the second-highest limit.
 * @returns {{ bid: bigint, value: bigint, limit: bigint } | { bid: null, value: bigint, limit: bigint, why: string }}
 */
export function decideBid({ offer, me, rules, value, funds }) {
  const limitByPrice = (value * BigInt(rules?.max_price_bps ?? 0)) / 10_000n;
  const cap = rules?.max_spend != null ? BigInt(rules.max_spend) : limitByPrice;
  // Funds already locked in this offer by me count towards a raise.
  const mine = offer.best_bidder === me ? BigInt(offer.best_bid) : 0n;
  const limit = [limitByPrice, cap, funds + mine].reduce((a, b) => (b < a ? b : a));
  const out = (why) => ({ bid: null, value, limit, why });
  if (!rules?.enabled) return out("market off");
  if (offer.seller === me) return out("own offer");
  if (offer.best_bidder === me) return out("already leading");
  const need = minBid(offer);
  if (need > limit) return out(`needs ${need}, limit ${limit}`);
  return { bid: need, value, limit };
}

export class MarketAgent {
  /**
   * @param {{ member: string, rules: object, reader: object, caller: object, now?: () => number, log?: (s: string) => void }} cfg
   */
  constructor({ member, rules, reader, caller, now, log }) {
    this.member = member;
    this.rules = rules;
    this.reader = reader;
    this.caller = caller;
    this.now = now ?? (() => Date.now());
    this.log = log ?? (() => {});
  }

  async tick() {
    const [offers, balances, ledger, ledgerNear, spends, funds] = await Promise.all([
      this.reader.openOffers(),
      this.reader.balances(),
      this.reader.ledger("Usdc"),
      this.reader.ledger("Near"),
      this.reader.openSpends(),
      this.reader.bidFunds(this.member),
    ]);
    const freeUsdc = BigInt(ledger.balance);
    const openSpendsUsdc = spends.filter((s) => s.token === "Usdc").reduce((a, s) => a + BigInt(s.amount), 0n);
    const nearSpends = spends.filter((s) => s.token === "Near").reduce((a, s) => a + BigInt(s.amount), 0n);
    const nearBal = BigInt(ledgerNear.balance);
    const freeNear = nearBal > nearSpends ? nearBal - nearSpends : 0n;
    const nearPrice = BigInt(this.rules?.near_price ?? 0);
    const totalShares = BigInt(balances.total_shares);
    const nowNs = BigInt(this.now()) * 1_000_000n;
    const out = { bids: [], settled: [], skipped: [] };
    let free = BigInt(funds);
    for (const offer of offers) {
      if (nowNs >= BigInt(offer.ends_at)) {
        const r = await this.caller.settleOffer(offer.id);
        if (r.ok || /ERR_OFFER_CLOSED/.test(JSON.stringify(r.failure ?? ""))) out.settled.push({ offer: offer.id, tx: r.hash });
        continue;
      }
      const value = shareValue(BigInt(offer.shares), { freeUsdc, totalShares, openSpendsUsdc, freeNear, nearPrice });
      const d = decideBid({ offer, me: this.member, rules: this.rules, value, funds: free });
      if (d.bid == null) {
        out.skipped.push({ offer: offer.id, why: d.why });
        continue;
      }
      const r = await this.caller.bid(offer.id, d.bid);
      if (r.ok) {
        free -= d.bid - (offer.best_bidder === this.member ? BigInt(offer.best_bid) : 0n);
        out.bids.push({ offer: offer.id, amount: String(d.bid), value: String(d.value), limit: String(d.limit), tx: r.hash });
        this.log(`bid ${d.bid} on offer ${offer.id} (worth ${d.value}, my limit ${d.limit})`);
      } else {
        out.skipped.push({ offer: offer.id, why: `refused: ${JSON.stringify(r.failure).slice(0, 120)}` });
      }
    }
    return out;
  }
}
