# Dissent Finance

Live page, read from mainnet in your browser: https://qijomofav35.github.io/Dissent-Finance/

A vault for a group's money that sits next to an unchanged Sputnik DAO on NEAR. When the DAO approves a spend from the vault, the spend waits for a fixed window, and any member who did not vote for it can take their share out first. Each member can run an agent that does this for them, using a key that can only call `exit` and `cancel_spend`.

If enough members leave that the vault can no longer pay the spend, anyone can cancel it.

## The story the tests check

Five friends put 10 NEAR and 100 USDC each into a vault. At 3am Ben and Cara, two of the five, approve 300 of the 500 USDC to Ben. Alice's rule says leave if one spend takes more than 20% of the fund. Dan's says leave if the receiver has never been paid before. Emma has blocked Ben as a receiver.

Their three agents see the spend, write a note saying which rule broke, and exit with exactly 100 USDC each. That leaves 200 USDC, so the spend can't be paid and gets cancelled. Ben receives nothing. Nobody had to be awake for it.

In the sandbox run below, five separate agent processes, each holding only its own member's key, finished this about one second after the vote.

## How it works

The DAO stays as it is. It gets one new kind of proposal, a `FunctionCall` to the vault's `queue_spend` with the payment's details. When that proposal passes, Sputnik calls the vault in the same transaction. The vault then reads the proposal back from the DAO with `get_proposal`, checks the arguments match byte for byte, and records who voted Approve and who voted against. A spend nobody passed through the DAO can't be queued, and a proposal can't be queued twice.

While the window is open:

- members who did not approve can `exit` and receive their exact pro-rata share of NEAR and USDC (rounded down in the vault's favour)
- members who approved can't exit until the spend is settled, so they can't approve a payment and then leave before it lands
- nobody can join, so a late deposit can't dilute anyone's share
- a spend approved by an account that holds no shares is refused at queue time

After the window, `execute_spend` pays the receiver plus a 0.1% fee, if the vault can still afford it. If it can't, `cancel_spend` marks it cancelled.

The agent (`agent/`) reads only public views. It checks each open spend against its owner's rules, which are three numbers and lists stored in the vault: the largest share of the fund one spend may take, whether the receiver must have been paid before, and blocked receivers. It never reads the proposal's description, so the text of a proposal can't talk it out of leaving. Before exiting it writes a note with every check it ran and sends the note's SHA-256 hash on chain with the `exit` call, so anyone can match the note to the exit later.

The agent signs with a NEAR function-call key that the member adds to their own account, limited to the vault and to `exit` and `cancel_spend`, with no deposit allowed. The NEAR runtime refuses anything else signed with it. The worst a stolen key can do is make its owner leave with their own money.

## Run it yourself

You need Rust 1.95 with the `wasm32-unknown-unknown` target, `cargo-near` 0.23.0 and Node 24. The sandbox tests download the NEAR sandbox binary on their first run.

1. Get the DAO code that mainnet uses today.

   ```
   node scripts/fetch-sputnik.mjs
   ```

   This reads the default code hash from `sputnik-dao.near`, downloads that code from the factory, checks that its SHA-256 matches the hash, and writes `contracts/vault/res/sputnikdao2.wasm`. You should see `factory default code hash:` followed by the hash, and no `hash mismatch` error.

2. Agent tests, no chain needed.

   ```
   cd agent && npm install && npm test
   ```

   You should see 29 pass, 0 fail. They include the story above, retries, a prompt injection in the spend's memo, five separate agents each with only its own key, and the simulation below.

3. Contract unit and property tests.

   ```
   cd contracts/vault && cargo test --lib
   ```

   You should see 50 passed. The two property tests run random sequences of joins, spends, votes, exits and claims and check after every step that shares add up, the books balance per token, exits pay the exact pro-rata amount and nothing executes early or twice. They take several minutes at 256 cases. `PROPTEST_CASES=32 cargo test --lib` runs a shorter pass.

4. End to end against the real Sputnik code.

   ```
   cargo test --test sputnik_flow
   ```

   You should see 8 passed. This deploys the mainnet DAO code, a test USDC and the vault in a local sandbox and runs the story with real proposals and votes, plus a normal spend paid after the window in USDC and in NEAR, a proposal whose arguments don't match being refused, a queue call from anyone other than the DAO being refused, a non-member's join being refunded, an exit to an account with no USDC storage becoming claimable, and an agent key being refused on every call outside `exit` and `cancel_spend`.

5. Five agent processes, no human after the vote.

   ```
   cargo test --test swarm_scenario -- --nocapture
   ```

   You should see `spend 0 settled as Cancelled after` about one second, then `exited:` with two or three of Alice, Dan and Emma, and `1 passed`. The test checks each leaver got exactly 100 USDC, Ben got nothing, both approvers' notes say stay, and every exit on chain carries the hash of the note its agent wrote. The agent logs and notes are kept in the folder it prints.

6. The swarm replay on real DAO history.

   ```
   node agent/sim/swarm.js replay3.json
   ```

   You should see the table in the next section.

## What 40 agents would have done to real contested spends

`scripts/replay3.mjs` reads public mainnet data from the 16 Sputnik DAOs where an earlier scan of the 49 largest DAOs found approved transfers with Reject votes. It found 473 such transfers. For each one it records the amount, who voted which way, whether the DAO had paid that receiver before and the DAO's median earlier transfer in the same token. The output is committed as `replay3.json`.

`agent/sim/swarm.js` gives every member who did not approve an agent, with rules drawn from 40 profiles and fixed per account, and runs the same `evaluate()` the live agent uses. Past treasury balances can't be read from a view call, so the fund is modelled as F times the DAO's median earlier transfer.

| F | Routine nearweek payouts killed (of 427) | Other spends where at least one agent left (of 45) | Other spends killed (of 45) |
|---|---|---|---|
| 10 | 0 | 82% | 4 |
| 25 | 0 | 51% | 2 |
| 50 | 0 | 47% | 1 |
| 100 | 0 | 38% | 1 |

427 of the 473 come from one DAO, nearweek-news-contribution, and all of them are the same 0.5 NEAR payment to one of 10 regular contributors. At F of 25 and above, only one of those 427 made any agent leave. The two spends killed at F of 25 were a payment 100 times that DAO's usual size and one 20 times the usual size where the receiver had voted for their own payment.

Limits of this replay: the fund size is assumed, shares are assumed equal, one DAO dominates the data, and one transfer with no earlier history in its token is skipped. It shows how the rules behave on the sizes and voting patterns of real spends.

## On mainnet

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

Should show spend 0 as `Cancelled`, and a vault of 400000 USDC units (0.4 USDC) with 2 members.

## Layout

```
contracts/vault       the vault contract, unit tests, property tests, sandbox tests
contracts/test-usdc   a NEP-141 token with open mint, for tests only
agent/src             the exit agent: rules, notes, reader, limited-key signer, watcher
agent/sim             the swarm replay
scripts               fetch-sputnik.mjs, replay3.mjs
replay3.json          the replay data used by the simulation
```

To run a watcher for one member: copy `agent/agent.config.example.json`, set the vault and RPC, put the member's function-call key in the environment variable named in the config, and run `node agent/src/watch.js agent.config.json --member <account>`. One process holds one member's key.
