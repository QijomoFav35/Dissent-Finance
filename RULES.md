# Share market rules

A member who wants out without taking money from the fund can sell shares to other members instead. Other members' agents bid for them. These are the rules the vault enforces (`contracts/vault/src/market.rs`) and the rules the market agents follow (`agent/src/market.js`). [Back to the README](README.md)

## What the vault enforces

**Who can take part**
- Only members who hold shares can deposit bid funds, bid, or offer shares.
- A member cannot bid on their own offer.

**Bid funds**
- A member sends USDC to the vault with `ft_transfer_call` and msg `bid_funds`, at least 0.01 USDC. Anything smaller, or from a non-member, is sent back.
- Bid funds are kept apart from the fund and stay the member's. They come back with `withdraw_bid_funds`, or in the same USDC transfer as the member's exit.
- A bid locks that amount until it is beaten or the auction ends.

**Offers**
- `offer_shares(shares, reserve)` is signed with the member's own key. `shares` must be more than 0 and at most what the member holds. `reserve` is the lowest price in USDC units the seller accepts, and must be more than 0.
- An auction lasts one spend window (600 s on the mainnet vaults).
- Each member can have one open offer, and the vault at most 8.
- No offer can be made while a spend is open.
- The seller can call `withdraw_offer` only before the first bid.

**Bids**
- `bid(offer_id, amount)` must be at least the reserve for the first bid. After that, each bid must beat the best one by at least 1% (and at least 1 unit).
- The bid is paid from the bidder's free bid funds, plus their own current best bid when they raise it.
- A beaten bid goes straight back to its bidder's funds.
- Bidding closes when the window ends.

**Settling**
- Once the window has ended, anyone can call `settle_offer`.
- If a spend was queued after the offer was made, the offer ends unsold, the best bid goes back to its bidder and the seller keeps the shares. The bids priced a fund with no spend pending, so they no longer hold.
- Otherwise the shares move to the best bidder, the bid goes to the seller in USDC, and a `share_sale` event goes into the vault's stored record.
- With no bids, the offer ends unsold.
- Offers that end unsold are removed. Offers and withdrawals go to the transaction log only, so nobody can grow the stored record by offering and withdrawing.

**What a sale never does**
- The fund's NEAR and USDC do not move, and the total number of shares stays the same. So a sale changes nobody else's share, and open spends stay exactly as payable as they were.

**Exits during an auction**
- A seller who exits has the open offer withdrawn, and its best bid goes back.
- A leading bidder who exits takes the bid back, and the auction carries on with no bids.

## What the market agents do

**What shares are worth**
- An agent values shares at their part of the fund's USDC, less their part of every open USDC spend, because a buyer inherits those spends.
- It adds their part of the fund's NEAR, less open NEAR spends, priced at the NEAR price read on chain from Ref Finance's NEAR/USDC pool 4512 (the ratio of its reserves).
- It reads that price again at every tick. It refuses a pool that is not a plain wrap.near / native USDC pool or holds under 100,000 USDC.

**How much it will pay**
- Each member sets their own limits: `max_price_bps` (the most the agent pays, as a share of value) and `max_spend` (a cap on one bid).
- The agent's limit is the smallest of those two and the bid funds it holds.

**How it bids**
- At each tick it bids the least that leads: the reserve, or the best bid plus 1%. It never goes above its limit.
- It never bids on its member's own offer or against itself, and it stops when its funds run out.
- With these rules the agent willing to pay the most wins, at about the second-highest limit.

**Settling**
- It settles any offer whose window has ended. If another agent settled first, it counts the offer as settled.
- If it cannot read the price, it skips bidding that tick but still settles.

**Its key**
- A market agent signs with its own function-call key on the member's account, limited to `bid` and `settle_offer`, with no deposit allowed.
- That key cannot exit, offer shares or withdraw bid funds. A leaked market key can at most win an auction with the bid funds the member chose to put in.

## Why the agents use keys on the members' own accounts, not sub-accounts

The member stays the owner of their shares, bid funds and exit at all times. Each agent's key can do one narrow job, and the NEAR runtime refuses anything else signed with it. An agent sub-account would hold the member's money itself, which is the custody the vault is built to avoid. Every on-chain action still traces to one agent key on one named account.

## Checked

- **Unit and property tests.** Random runs of deposits, offers, bids, settles, withdrawals, spends and exits check after every step that bid funds add up, sellers hold what they offered, best bidders hold their shares, and the fund does not move in a sale (`contracts/vault/src/tests.rs`, `prop_tests.rs`).
- **Sandbox.** A sale with market agents' keys against the real Sputnik DAO code, in which a market key is refused both an exit and an offer (`contracts/vault/tests/sputnik_flow.rs`).
- **Simulation.** `node agent/sim/market.js` runs the agent's own decision code for 20 members through 30 auctions. Seed 1 sells 22 of 30, at a median of 94.78% of value; in every sale of seeds 1 to 3 the highest limit won.
- **Mainnet, 13 November 2026.**
  - Three agents placed 7 bids for part of Cara's shares, and Dan bought them at 0.085979 USDC, 95.5% of value ([offer](https://nearblocks.io/txns/6DxKZ99sg7t84ieVKXA7z9hmvcoPrzpSjjPKrAJvFwFN)).
  - Every bid is in [`agent/mainnet/evidence.jsonl`](agent/mainnet/evidence.jsonl) with the NEAR price that agent read, and [docs/MAINNET.md](docs/MAINNET.md#round-3-the-share-market-and-an-approver-who-leaves-13-november-2026) has the full round.
  - `verify.mjs` checks every sale against its reserve and the vault's record.
