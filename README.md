# Dissent Finance

[![CI](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/ci.yml/badge.svg)](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/ci.yml) [![Mainnet checks](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/watch.yml/badge.svg)](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/watch.yml) [![Guard](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/guard.yml/badge.svg)](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/guard.yml)

Live page, read from mainnet in your browser: https://qijomofav35.github.io/Dissent-Finance/ (v2; v1 at `?v=vault`) · [JUDGE.md](JUDGE.md): a five-minute path and a one-command check · Social Money track · NEAR mainnet, real USDC

A vault for a group's money that sits next to an unchanged Sputnik DAO on NEAR. When the DAO approves a spend from the vault, the spend waits for a fixed window, and any member who did not vote for it can take their share out first. Each member can run an agent that does this for them, using a key that can only call `exit` and `cancel_spend`.

If enough members leave that the vault can no longer pay the spend, anyone can cancel it.

The exit itself is an old idea: Moloch DAO's "ragequit" (2019) lets members who did not vote for a proposal leave with their share during a grace period before it runs. Sputnik DAO, the DAO contract deployed by the `sputnik-dao.near` factory, has nothing like it, and moving a group's treasury to a new DAO is a big ask. Dissent Finance adds ragequit next to an unchanged Sputnik DAO: the DAO keeps its members, roles and votes, and only the money moves into the vault. The other new part is that members don't have to be watching: each one's agent applies their rules and leaves for them within seconds, on a key that can do nothing else.

## The story the tests check

Five friends put 10 NEAR and 100 USDC each into a vault. At 3am Ben and Cara, two of the five, approve 300 of the 500 USDC to Ben. Alice's rule says leave if one spend takes more than 20% of the fund. Dan's says leave if the receiver has never been paid before. Emma has blocked Ben as a receiver.

Their three agents see the spend, write a note saying which rule broke, and exit with exactly 100 USDC each. That leaves 200 USDC, so the spend can't be paid and gets cancelled. Ben receives nothing. Nobody had to be awake for it.

In the sandbox run below, five separate agent processes, each holding only its own member's key, finished this about one second after the vote.

## How it works

The DAO stays as it is. It gets one new kind of proposal, a `FunctionCall` to the vault's `queue_spend` with the payment's details. When that proposal passes, Sputnik calls the vault in the same transaction. The vault then reads the proposal back from the DAO with `get_proposal`, checks the arguments match byte for byte, and records who voted Approve and who voted against. A spend nobody passed through the DAO can't be queued, and a proposal can't be queued twice.

While the window is open:

- members who did not approve can `exit` and receive their exact pro-rata share of NEAR and USDC (rounded down in the vault's favour)
- a member can always leave, including one who approved a spend. For each open spend a member approved, their pro-rata part of its cost (with the fee, rounded up) is held back from what they take and kept for that spend alone: if it pays, the held part pays its share of it; if it is cancelled, the held part becomes claimable by the member who left (`claim`). So approving a payment and leaving before it lands saves nothing, the members who stay are left as well off as if the leaver had stayed (as long as the spends a leaver approved add up to no more than their whole share; past that, the hold stops at everything they had), and approving one spend never locks a member into another. `get_exit_quote` shows what an exit would pay now and `get_holds` what is held for a spend. (v1, which is keyless, still has the earlier rule: an approver could not exit while any spend they approved was open.)
- nobody can join, so a late deposit can't dilute anyone's share
- the vault records approvals only from accounts that hold shares, so a council member who has left the vault can't block a spend by approving it, and a spend no holder approved is refused. Their vote still counts toward the DAO's own threshold, because the DAO's rules are unchanged
- at most 8 spends can be open at once, and memos are capped at 256 bytes, so agents can always read every open spend and an exit's work stays small (the sandbox tests run every exit at the 80 Tgas the agents attach on mainnet)

After the window, `execute_spend` pays the receiver plus a 0.1% fee, if the vault can still afford it. If it can't, `cancel_spend` marks it cancelled. The fee goes to the fee account set when the vault was created (for the mainnet vault, `dissentfinance.near`) and can't be changed afterwards.

The vault pays for its own storage from the same NEAR balance that holds members' money. The calls that can add stored data without limit (a deposit toward a join, a join, a rule change, a new spend) are refused if the vault's storage would then eat into what it owes members, joiners or claimants, or into a reserve kept for the calls that must always work. Those calls (exit, cancel, execute, claim) add at most a few hundred bytes each, bounded by the number of members and spends, and exit reasons are capped at 64 characters, the length of a hash. Only joins, spends, executes, exits and cancels are kept in the stored record; deposits, refused joins, rule changes, claims and failed transfers go to the transaction log only, so nobody can grow the record in a loop. USDC deposits toward a join must be at least 0.1 USDC, and a pending deposit can be taken back with `cancel_join`.

The agent (`agent/`) reads only public views. It checks each open spend against its owner's rules, which are three numbers and lists stored in the vault: the largest share of the fund one spend may take, whether the receiver must have been paid before, and blocked receivers. It never reads the proposal's description, so the text of a proposal can't talk it out of leaving. Before exiting it writes a note with every check it ran and sends the note's SHA-256 hash on chain with the `exit` call, so anyone can match the note to the exit later. The note is written once; if the exit fails (a busy RPC endpoint, say) the agent retries with the same hash while the spend is still open, backing off from 2 seconds up to a minute, for at most 20 attempts so it can't use up the key's gas allowance.

The agent signs with a NEAR function-call key that the member adds to their own account, limited to the vault and to `exit` and `cancel_spend`, with no deposit allowed. The NEAR runtime refuses anything else signed with it. A stolen key can make its owner leave with their own money, attach a misleading 64-character reason to that exit, and spend up to its 0.25 NEAR gas allowance. It can't send anyone's funds anywhere else.

The rules are deterministic on purpose: the same spend, rules and fund always give the same decision, and anyone can replay it from the note. There is no model in the exit path.

## Share market: selling instead of leaving

A member who wants out does not have to take money from the fund. They can offer their shares, and the other members' market agents bid for them.

- Bid funds: a member who holds shares sends USDC to the vault with `ft_transfer_call` and msg `bid_funds` (at least 0.01 USDC). It is kept apart from the fund, stays the member's, and can be taken back with `withdraw_bid_funds` or comes back in the same transfer as their exit.
- No shares change hands around a spend: `offer_shares` is refused while one is open, and an offer during which a spend was queued ends unsold when settled, its best bid returned. Otherwise a member who approved a spend could sell to one who did not, and the buyer could leave with those shares without the approver's part being held back; or a seller could collect bids and then queue a spend the buyer never priced.
- `offer_shares(shares, reserve)`, signed with the member's own key, opens a timed auction that lasts one spend window. Each member can have one open offer, and the vault at most eight. Offers and withdrawals go to the transaction log only; sales are kept in the stored record.
- `bid(offer_id, amount)` must meet the reserve, or beat the best bid by at least 1%, from the bidder's free bid funds. A beaten bid goes straight back to its bidder's funds.
- After the window anyone calls `settle_offer`: the shares move to the best bidder, the USDC goes to the seller, and a `share_sale` goes into the vault's record. An offer with no bids ends unsold, and the seller can withdraw an offer that has none.
- The fund itself never moves in a sale, so a sale changes nobody else's share. A member who exits with an open offer or a leading bid has the offer withdrawn and the bid returned first.

Market agents (`agent/src/market.js`) bid by their member's own limits: the most they pay as a share of what the shares are worth, a cap on one bid, and what the member counts 1 NEAR as. Shares are valued at their part of the fund's USDC less their part of every open USDC spend (a buyer inherits the spends), plus the same for NEAR at the member's NEAR price. An agent bids the least that leads and never above its limit, so the agent willing to pay the most wins at about the second-highest limit. A market agent signs with its own function-call key, limited to `bid` and `settle_offer`. It cannot exit, offer its member's shares or take bid funds out, so a leaked market key can at most win an auction with the bid funds the member chose to put in. Selling shares takes the member's own key.

`node agent/sim/market.js` runs that decision code for 20 members with random limits and funds through 30 auctions under the vault's rules. Seed 1 sells 22 of 30 offers at a median of 94.78% of value; in every sale of seeds 1 to 3 the agent with the highest limit won, and every unit of USDC and every share is accounted for.

## Known limits

- The vault is a separate contract next to the DAO, so the DAO's own rules still decide what passes. The vault decides only whether a passed spend can be paid, and when.
- Members' exits are protected, but the vault's spare storage is not. Outsiders with 0.1 USDC each can fill it with pending deposits: each takes roughly 150 bytes, so about a hundred of them fill the mainnet vault's spare room. The USDC stays theirs and comes back with `cancel_join`. Exits, cancels and claims keep working; new joins, rule changes and spends are refused until someone sends the vault a little NEAR, which anyone can do.
- The reserve grows with the number of members, about 1 KB each. The mainnet vault was funded with 0.25 NEAR above its code's storage, enough for a small group; a larger group needs someone to send it more NEAR first.
- At most 8 spends can be open at once. A majority that keeps 8 slots full can stop new spends and joins; if they leave, they still pay their part of each of those spends they approved.
- If a spend's payment bounces and the receiver later claims it, the receiver is still counted as never paid, which only matters for the "new receiver" rule.
- The spend window is set when a vault is created and can't change once its key is deleted. The mainnet vaults use 10 minutes so a full cycle can be watched; a real group would choose hours or days.
- NEAR or USDC sent to the vault in any way other than `ft_transfer_call` with msg "join" plus `join` is not credited to anyone and can't be recovered.
- The vault reads the DAO's `get_policy` and `get_proposal`. A future Sputnik upgrade that changed their shape would stop new joins and spends; exits don't read the DAO and would keep working.
- Money held back from an approver who left comes back only through `claim`, which needs a key that can call it (the member's full key; agent keys call only `exit` and `cancel_spend`).
- A share sale has no price oracle. Each market agent values the NEAR side of the fund at a NEAR price its member sets, and the reserve protects the seller from a low bid, not from a reserve they set too low.
- Any spend queued while an auction runs ends that auction unsold, even a spend that settles before the auction ends. This protects bidders, and it means a council that queues spends often leaves little room for sales.
- A bidder who exits while leading an auction takes their bid back, and the auction carries on with no bids; earlier, outbid bids are not restored, so a late exit by the leader can leave an offer unsold.
- The agent runs on the member's own machine or server. If it is offline for the whole window, the member can still exit by hand.

## Run it yourself

You need Rust 1.95 (pinned in `rust-toolchain.toml`) with the `wasm32-unknown-unknown` target, `cargo-near` 0.23 and Node 24. The mainnet contract was built reproducibly in the `sourcescan/cargo-near:0.22.0-rust-1.99.1` image named in `Cargo.toml`. The sandbox tests download the NEAR sandbox binary on their first run.

1. Get the DAO code that mainnet uses today.

   ```
   node scripts/fetch-sputnik.mjs
   ```

   This reads the default code hash from `sputnik-dao.near`, downloads that code from the factory, checks that its SHA-256 matches the hash, and writes `contracts/vault/res/sputnikdao2.wasm`. You should see `factory default code hash:` followed by the hash, and no `hash mismatch` error.

2. Agent tests, no chain needed.

   ```
   cd agent && npm install && npm test
   ```

   You should see 48 pass, 0 fail. They include the story above, retries that reuse the same note with a backoff and a cap, a prompt injection in the spend's memo, five separate agents each with only its own key, the simulation below, the guard refusing any key broader than an agent key, the market agent's bids, limits and settling, the 20-agent market simulation, and `verify.mjs` run against a stand-in for mainnet: every check passes on the real state and on the state the third run leaves, and four planted faults (a widened agent key, a wrong note hash, unbalanced books, a share sale under its reserve) each fail their check.

   The demo page has its own tests, in headless Chromium against a stand-in for mainnet RPC:

   ```
   cd tests/page && npm install && npx playwright install chromium && npm test
   ```

   You should see 9 pass: v1's checks and two outcomes read from its record, later exits kept out of the spend, a note whose hash does not match failing the page's check, the proof panel, v2 with the guard run on duty, the guard row when GitHub's API refuses, the share market panel before and after the market code, the "Try it" panel running the agent's own `rules.js` for presets and custom rules, and no sideways scroll on a phone.

3. Contract unit and property tests.

   ```
   cd contracts/vault && cargo test --lib
   ```

   You should see 82 passed. The two property tests run random sequences of joins, spends, votes, exits, claims, bid deposits, offers, bids, settles and withdrawals and check after every step that shares add up, the books balance per token, exits pay the exact pro-rata amount less what is held back for spends the leaver approved, what is held back adds up, a spend stays payable after its approvers leave (unless the spends a leaver approved add up to more than their whole share), bid funds add up, and nothing executes early or twice. They take several minutes at 256 cases. `PROPTEST_CASES=32 cargo test --lib` runs a shorter pass.

4. End to end against the real Sputnik code.

   ```
   cargo test --test sputnik_flow
   ```

   You should see 10 passed. This deploys the mainnet DAO code, a test USDC and the vault in a local sandbox and runs the story with real proposals and votes, plus a normal spend paid after the window in USDC and in NEAR, a proposal whose arguments don't match being refused, a queue call from anyone other than the DAO being refused, a non-member's join being refunded, an exit to an account with no USDC storage becoming claimable, an agent key being refused on every call outside `exit` and `cancel_spend`, the members voting the DAO's factory auto-update off, and a share sale with market agents' keys, in which a market key is refused both an exit and an offer of its member's shares, and the fund does not move.

5. Five agent processes, no human after the vote.

   ```
   cargo test --test swarm_scenario -- --nocapture
   ```

   You should see `spend 0 settled as Cancelled after` about one second, then `exited:` with two or three of Alice, Dan and Emma, and `1 passed`. The test checks each leaver got exactly 100 USDC, Ben got nothing, both approvers' notes say stay, and every exit on chain carries the hash of the note its agent wrote. The agent logs and notes are kept in the folder it prints.

6. The simulation on real DAO history.

   ```
   node agent/sim/swarm.js replay3.json
   ```

   You should see the table in the next section.

7. The mainnet run, checked against the chain. Needs only Node, no keys and no installs.

   ```
   node agent/mainnet/verify.mjs
   node agent/mainnet/verify.mjs --vault vault
   ```

   For v2 and then v1, it reads one final block and prints about 22 numbered checks, each PASS, FAIL or INFO:

   - the vault's code hash and the commit its NEP-330 metadata names; its access keys (INFO on v2, which still has its key; FAIL if v1 ever had one); the DAO and token it answers to;
   - the DAO's code is the code `sputnik-dao.near` publishes as its default, and the same bytes as `contracts/vault/res/sputnikdao2.wasm`, which the sandbox tests deploy; the DAO's policy (one council of the five named members, no Everyone role, two votes); whether the DAO's factory auto-update is off (INFO while it is on);
   - every member's agent key, read from their own account: a function-call key for `exit` and `cancel_spend` on the vault, and at most a market key for `bid` and `settle_offer`, nothing more;
   - spend 0 is `Cancelled`; the DAO proposal is Approved and its `queue_spend` arguments are the spend; the Approve votes are the spend's approvers; the vault's record shows the queue, the exits and the cancel in that order, inside the window;
   - for each exit, the `reason_hash` in the vault's record equals the hash of the published note, computed on your machine, and so does the one in the exit transaction while the RPC endpoints still serve it (older transactions need an archival node; the line says which was compared); leavers hold no shares unless the record shows them joining again after the cancel;
   - the remaining shares add up; the USDC and NEAR books balance (held = deposited - spent - fees - exited - refunded); the USDC contract's own balance for the vault covers what the vault owes members, bid funds included; what is held back for open spends equals the sum of their holds; every share sale was at or above its reserve and is in the vault's record (both INFO on code from before the market).

   It should end with `All checks passed`. The exit code is the number of failed checks. `--json` prints the same checks as JSON. The `Mainnet checks` workflow runs it every hour.

## What agents with varied rules would have done to real contested spends

`scripts/replay3.mjs` reads public mainnet data from 16 Sputnik DAOs and finds every approved transfer that had at least one Reject vote: 473 of them. The list of 16 DAOs is written into the script; it came from an earlier scan of the 49 Sputnik DAOs with the most proposals, which is not in this repo. For each transfer it records the amount, who voted which way, whether the DAO had paid that receiver before and the DAO's median earlier transfer in the same token. The output is committed as `replay3.json`.

`agent/sim/swarm.js` gives every member who did not approve, and every council member who did not vote, an agent. Each account gets one of 30 distinct rule profiles, fixed per account, and the simulation runs the same `evaluate()` the live agent uses. Past treasury balances can't be read from a view call, so the fund is modelled as F times the DAO's median earlier transfer, and shares are equal.

| F | Routine nearweek payouts where at least one agent left (of 427) | Routine payouts killed | Other spends where at least one agent left (of 45) | Other spends killed (of 45) |
|---|---|---|---|---|
| 10 | 98.1% | 0 | 84.4% | 5 |
| 25 | 0.2% | 0 | 66.7% | 3 |
| 50 | 0.2% | 0 | 53.3% | 2 |
| 100 | 0.2% | 0 | 42.2% | 1 |

427 of the 473 come from one DAO, nearweek-news-contribution, and all of them are the same 0.5 NEAR payment to one of 10 regular contributors. In a small fund (F of 10) each of those payouts is 10% of the fund, and almost every one makes some member's agent leave: strict rules in a small fund produce a lot of exits. None of those payouts is ever killed, because one or two members leaving doesn't make a 10% payment unaffordable. At F of 25, the three spends killed were a payment 100 times that DAO's usual size (in `testing-astradao`, which looks like a test DAO), one 20 times the usual size where the receiver voted for their own payment, and one 6.7 times the usual size.

Limits of this replay: the fund size is assumed, shares are assumed equal, one DAO dominates the data, and one transfer with no earlier history in its token is skipped. It shows how the rules behave on the sizes and voting patterns of real spends, and nothing about what those DAOs' members would have chosen.

## On mainnet: the first run (v1)

This first vault, `vault.dissentfinance.near`, runs the code at commit `54ccf1b`, which predates the storage guard, the holder-only approvals, the caps and the other changes described above. It is keyless, so it can't be upgraded; it stays as the record of the first live run. Its funds have since all been withdrawn by its members. The fixed version runs as v2 (below).

The story ran live on NEAR mainnet on 11 November 2026, scaled down: each member put in 0.1 NEAR and 0.2 USDC (native USDC, `17208628...133a1`), so the vault held 0.5 NEAR and 1 USDC.

| What | Where |
|---|---|
| The DAO, created through the official `sputnik-dao.near` factory, council of the five members, 2 approvals needed | [dissentfinance.sputnik-dao.near](https://nearblocks.io/address/dissentfinance.sputnik-dao.near) |
| The vault, verified and with no access keys | [vault.dissentfinance.near](https://nearblocks.io/address/vault.dissentfinance.near) |
| Members | `alice`, `ben`, `cara`, `dan` and `emma`, each `.dissentfinance.near` |

What happened (the three exits landed before the cancel; the contract refuses a cancel while the spend is still affordable):

| Step | Transaction |
|---|---|
| Ben files proposal 0: 0.6 USDC of the vault's 1 USDC to himself | [4uSodkrW](https://nearblocks.io/txns/4uSodkrWsqQtq1Kpm15X11NQzj7k9h5ESJGXLHEegzSz) |
| Ben approves | [73sYDMhV](https://nearblocks.io/txns/73sYDMhVWQo765hznkCdQzpubSVMgNUDbc98bH7855mj) |
| Cara approves; the DAO calls the vault, which reads the proposal back and queues spend 0 | [HkBStJJA](https://nearblocks.io/txns/HkBStJJAqLwADecEu5qnr5F8waPRXPSVzFamXHmJvzL7) |
| Emma's agent exits (Ben is on her blocked list) | [E44VWZe5](https://nearblocks.io/txns/E44VWZe5r6wozitagvX9tauLKw6JzmFgUBwGCgTJ7Yii) |
| Dan's agent exits (Ben had never been paid by the vault) | [6uKtFnYV](https://nearblocks.io/txns/6uKtFnYVcH9T3UNGZQm45rnHQGZ1SbXxBJb2jXzjTsmP) |
| Alice's agent exits (the spend was 60% of the fund, her limit is 20%) | [7GZAggTS](https://nearblocks.io/txns/7GZAggTS73tcV3ygJT3hzmzWWBrFwgFnVBGXd9GY1RRF) |
| Cara's agent cancels spend 0, now unaffordable | [EdWntKHf](https://nearblocks.io/txns/EdWntKHfbXwLudqv9ZNMbyEnquCPvpCMVNTVz9knPXvh) |

Nobody acted by hand after Cara's vote. By the vault's own timestamps the spend was queued at 21:11:12 UTC, the three exits landed at 21:11:50 and 21:11:51, and the cancel at 21:12:03, 51 seconds after the queue. Most of that time went on the public RPC endpoints rate-limiting the five agents. Afterwards Alice, Dan and Emma each held exactly 0.2 USDC, Ben held none, and the vault held 0.4 USDC and 0.2 NEAR for Ben and Cara. Ben and Cara's agents wrote notes saying stay, since they approved. All five notes are in `agent/mainnet/notes/`, and each exit carries its note's hash on chain.

Ben's agent key was then used to try a USDC `ft_transfer`. The NEAR runtime rejected the transaction before it ran, with `Deposit is not allowed with function call`: a token transfer needs 1 yoctoNEAR attached, and these keys can't attach any, so they can't move tokens at all.

The vault code was then redeployed from a reproducible build of commit `54ccf1b` ([GMcCtwT8](https://nearblocks.io/txns/GMcCtwT8VLZxbKqs2zhDA3m8BX5N7NSNtLEh25oZcz7a)), and its only access key was deleted ([61N8fiHX](https://nearblocks.io/txns/61N8fiHXookvRa6jv7Meo1MUPKSAdLjzX39YjPWE9n5W)). From then on nobody can change its code or move its funds outside the contract's rules. About 2.7 NEAR stays locked in it for its own storage.

Every transaction from setup, including the joins, the rules and the five agent keys, is in `agent/mainnet/evidence.jsonl`.

### Check it yourself

With `near` CLI installed, none of these need an account:

```
near contract verify deployed-at vault.dissentfinance.near network-config mainnet now
```

This rebuilds the vault from the commit it names, in the Docker image it names, and should end with `The code obtained from the contract account ID and the code calculated from the repository are the same.` (needs Docker, about 5 minutes).

```
near account view-account-summary vault.dissentfinance.near network-config mainnet now
```

Should show `Account is locked (no access keys)`.

```
near contract call-function as-read-only vault.dissentfinance.near get_spend json-args '{"spend_id":0}' network-config mainnet now
near contract call-function as-read-only vault.dissentfinance.near get_balances json-args '{}' network-config mainnet now
```

Should show spend 0 as `Cancelled`, and (since Ben and Cara later left too) a vault holding 0 USDC with 0 members.

## On mainnet: v2

`vault2.dissentfinance.near` runs the code described above, built reproducibly from commit `3f14192` (code hash `AJBeJNNHfRTP2SXV1q7yzsYVTxHaaV8roipVjJN2G3Zx`; `near contract verify deployed-at vault2.dissentfinance.near network-config mainnet now` rebuilds it). It uses the same DAO, [dissentfinance.sputnik-dao.near](https://nearblocks.io/address/dissentfinance.sputnik-dao.near), and the same five members, who each joined with 0.1 NEAR and 0.2 USDC (Ben and Cara first took their 0.2 USDC out of v1 with their v1 agent keys: [A3N4hcUd](https://nearblocks.io/txns/A3N4hcUdexfttBQVedJvZ4ijMwwDiVzwMVJUVGNB3UVQ), [2tYQmA9P](https://nearblocks.io/txns/2tYQmA9PnBD9feRLbCxJy1QpbsNhrGCBmocNcUHSFCtt)).

Before going live, v2 was reviewed three times by an independent reviewer that had not seen it being built. Each review found something (a storage loop through bouncing claims, a transfer check that could count a delivered payment as failed, agent retries that could drain a key's gas allowance, joins with no USDC behind them), and each was fixed and tested before the next step. The vault was deployed while it still had its key, so the last fix went in as a code-only redeploy ([GtacaTNB](https://nearblocks.io/txns/GtacaTNBVg2eD6Go7m8JPmTnuA4KM9CU7p2JjEpzf9Cx)) that kept every member's balance. After the live run below, a fourth review found two more: an exit reason with no length cap, and join share maths that could overflow. Both were fixed and tested in `3f14192` and went in the same way, as a code-only redeploy ([6SKeWDGM](https://nearblocks.io/txns/6SKeWDGMMYGRFvT1Cs5nKJfJ39mQb5m2U3WCkvSuS6fd)) that touched no balance. v2 still has its full-access key while the last checks run; v1 shows the keyless end state.

The DAO is a stock mainnet Sputnik DAO, so [Trezu](https://trezu.app/dissentfinance.sputnik-dao.near/requests?tab=Approved) lists it like any treasury: both spends appear under Requests, Executed, as `queue_spend` calls on the two vaults, each with 2 approving votes (2 needed) ([screenshot](docs/images/trezu-requests.jpg)).

The same story, live on 12 November 2026:

| Step | Transaction |
|---|---|
| Ben files DAO proposal 1: 0.6 USDC of the vault's 1 USDC to himself | [7eE7dBmf](https://nearblocks.io/txns/7eE7dBmfC5piPPbAoSznGFA5x1hhr97e49k4WcH13v39) |
| Ben approves | [5mdWtmMT](https://nearblocks.io/txns/5mdWtmMTFNvrfaciVcQSdpuNcS2xfBUWnnpAgNsrM9GS) |
| Cara approves; the vault reads the proposal back and queues spend 0 | [DpKwEZ8L](https://nearblocks.io/txns/DpKwEZ8L419yKGqnxDrqrv5hQK4UJM7pYCVtEMbAYxwu) |
| Alice's agent exits (60% of the fund, her limit is 20%) | [CGpp5bJe](https://nearblocks.io/txns/CGpp5bJe2ZB87QZTsnmvN4f28cQsjqS6yoPzzKsQKfKN) |
| Dan's agent exits (Ben had never been paid by v2) | [Msq3yLLH](https://nearblocks.io/txns/Msq3yLLHyQQjYehLowCZJDhQB3u48gAPvhsZrtTkmdg) |
| Emma's agent exits (Ben is on her blocked list) | [GqsAoKSZ](https://nearblocks.io/txns/GqsAoKSZsysmtKKA37Vq5vX3pbsFWgrRMgWkjVWfeTUa) |
| Emma's agent cancels spend 0, now unaffordable | [4cA4kFtv](https://nearblocks.io/txns/4cA4kFtvvuz6bVb5FRjP35Q76sHQKq3hWsabd59xLAAT) |

By the vault's own timestamps the spend was queued at 13:31:09 UTC, the three exits landed at 13:31:17 and 13:31:18, and the cancel at 13:31:21, 12 seconds after the queue. Alice, Dan and Emma each got exactly 0.2 USDC back, Ben got nothing, and 0.4 USDC stayed in the vault for Ben and Cara. The exit and cancel transactions above were written to `agent/mainnet/evidence.jsonl` by the story script from the agents' own state files, and the five notes are in `agent/mainnet/notes/vault2/`.

Ben's v2 agent key was then used three ways it should never work, with `agent/mainnet/key-check.mjs`, which records only the runtime's own answer and retries busy RPC endpoints:

| Attempt | NEAR runtime's answer |
|---|---|
| Move USDC (`ft_transfer` on the USDC contract) | `AccessKeyDepositWithFunctionCallActionError: Deposit is not allowed with function call` |
| Call another vault method (`set_rules`) | `AccessKeyMethodNameMismatchActionError: Access key does not allow method set_rules` |
| Attach a deposit to `exit` | `AccessKeyDepositWithFunctionCallActionError: Deposit is not allowed with function call` |

(The story script's own attempt at the first check hit a rate-limited endpoint and recorded that error as a refusal. The evidence file keeps that line and marks it with a correction; the table above comes from `key-check.mjs`.)

The same checks work for v2 without this repo's page:

```
near contract verify deployed-at vault2.dissentfinance.near network-config mainnet now
near contract call-function as-read-only vault2.dissentfinance.near get_spend json-args '{"spend_id":0}' network-config mainnet now
near contract call-function as-read-only vault2.dissentfinance.near get_balances json-args '{}' network-config mainnet now
```

v2 still has its full-access key while it is reviewed once more. Deleting it is the last step.

## Agents on duty

`.github/workflows/guard.yml` keeps Ben's and Cara's agents, the members still in v2, watching `vault2.dissentfinance.near` around the clock. Each run watches for just under six hours; the next run is scheduled before the current one ends and waits in the queue, so a new shift starts about a minute after the last one ends (GitHub can delay scheduled runs, and a delay longer than the 10-minute spend window would leave a gap). A watcher that stops is restarted, and one that keeps stopping fails the run. Each agent runs in its own process with only its own member's key, read from the repository secrets `BEN_AGENT_KEY` and `CARA_AGENT_KEY`. Before starting, `agent/mainnet/guard.mjs` reads each key from the chain and refuses it unless it is a function-call key that can call only `exit` and `cancel_spend` on the vault. Such a key cannot move funds anywhere but the member's own account, so it is safe to keep in CI: if it leaked, the worst a holder could do is take that member out of the vault into their own wallet, cancel a spend the vault can no longer pay anyway, or burn the key's gas allowance (about 0.25 NEAR). Nothing is sent while the vault is quiet. The page's Proof section shows whether a guard run is watching now.

To run it yourself with your own agent keys, from `agent/`: `BEN_AGENT_KEY=... CARA_AGENT_KEY=... MINUTES=5 node mainnet/guard.mjs`.

## Layout

```
contracts/vault       the vault contract, unit tests, property tests, sandbox tests
contracts/test-usdc   a NEP-141 token with open mint, for tests only
agent/src             the exit agent: rules, notes, reader, limited-key signer, watcher
agent/sim             the swarm replay and the share market simulation
agent/mainnet         the mainnet scripts, evidence.jsonl, published notes, verify.mjs, guard.mjs
tests/page            headless tests of the demo page
docs                  the live page (GitHub Pages), its Trezu screenshot, llms.txt
.github/workflows     ci.yml (every test), watch.yml (hourly mainnet checks), guard.yml (agents on duty)
scripts               fetch-sputnik.mjs, replay3.mjs
replay3.json          the replay data used by the simulation
```

To run a watcher for one member: copy `agent/agent.config.example.json`, set the vault and RPC, put the member's function-call key in the environment variable named in the config, and run `node agent/src/watch.js agent.config.json --member <account>`. One process holds one member's key.
