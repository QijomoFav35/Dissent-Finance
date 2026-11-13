# Judging Dissent Finance in five minutes

**A vault next to an unchanged Sputnik DAO on NEAR mainnet. When the DAO approves a spend, members who did not vote for it can leave with their exact share before it pays. Each member's agent does this for them with a key that can call only `exit` and `cancel_spend`.**

Everything below runs against NEAR mainnet with real USDC. You need a browser for the page and Node 20+ for the check. No wallet, account or install.

## What it is, against the Social Money track

The track: "Build shared budgets, programmable rewards, collective ownership and reputation-based access on top of Sputnik DAO and Trezu. Leave the multisig alone and build what communities do with it." It names Sputnik DAO, Trezu and named accounts.

| The track asks for | How Dissent Finance meets it | Proof you can open |
|---|---|---|
| Build on the existing Sputnik DAO, no new multisig | A stock DAO from the public `sputnik-dao.near` factory. The vault is a separate contract that accepts a spend only after reading the DAO's own record of the approved proposal. | [dissentfinance.sputnik-dao.near](https://nearblocks.io/address/dissentfinance.sputnik-dao.near) |
| Trezu | Trezu lists the DAO like any treasury; both spends show as executed `queue_spend` requests on the two vaults, each with 2 approving votes (2 needed). | [Trezu, Requests, Executed](https://trezu.app/dissentfinance.sputnik-dao.near/requests?tab=Approved), [screenshot](docs/images/trezu-requests.jpg) |
| Shared budgets, collective ownership | Members own the fund by shares. Nobody can be made to fund a spend they did not approve: they can leave with their exact share while it waits. | [Members now, on the page](https://qijomofav35.github.io/Dissent-Finance/#run) |
| Named accounts | Members, agents and exits are named accounts (`alice.dissentfinance.near`...). Agent keys are function-call keys on each member's own account. | [The agents' notes and hashes](https://qijomofav35.github.io/Dissent-Finance/#run) |

## 1. The five-minute path

1. **Open https://qijomofav35.github.io/Dissent-Finance/.** Your browser reads mainnet directly. See four checks at the top: the code hash is the reproducible build, 3 of 3 exit notes match the chain, the spend was cancelled, and the access-key count.
2. **Read "The same vote, two outcomes".** Two of five members approve paying Ben 60% of the fund. Without the vault (a counterfactual, labelled as one), the DAO pays 0.60 USDC and everyone shares the loss. With the vault, on mainnet: three agents exit with their exact 0.20 USDC each within seconds, and the spend is cancelled because the vault can no longer pay it. 0 USDC paid out.
3. **Try it, no wallet.** Under "Be the sixth member", tap "Alice's rules", then change the rules yourself. You join with the same deposit as each of the five. Your browser loads `agent/src/rules.js` from this repo (the page shows its sha256), runs it against the real spend, and shows the decision, the note in the agents' format and its hash (a real note also carries the time it was written).
4. **Scroll to "The live run" and tap "Replay the spend".** The queue, the three exits and the cancel light up in order, read from the vault's own event record, each linked to its transaction.
5. **Read "The agents' notes".** Each card is a note an agent wrote before acting: the rule it checked, the numbers and its decision. The page fetches each note from this repo, hashes it in your browser and shows it matches the `reason_hash` that exit carried on chain.
6. **Switch v1 / v2 at the top right.** v1 (`vault.dissentfinance.near`) ran the first live story and has no access keys. v2 (`vault2.dissentfinance.near`) has the fixes found in review and ran the same story on 12 November 2026.
7. **Open Trezu** from the "Track" section and see the same two spends as executed requests in the DAO.
8. **Scroll to "Share market".** On 13 November three members' agents, each with a key that can only bid and settle, bid for part of Cara's shares on mainnet: 7 bids, sold to Dan at 0.085979 USDC (95.5% of value, NEAR priced from Ref Finance's pool). The same round, Cara approved a spend and left while it was open, with her part held back for it. Every transaction is in [README, Round 3](README.md#round-3-the-share-market-and-an-approver-who-leaves-13-november-2026).

## 2. One-command check (read-only, under a minute)

```sh
git clone https://github.com/QijomoFav35/Dissent-Finance && cd Dissent-Finance
node agent/mainnet/verify.mjs               # v2
node agent/mainnet/verify.mjs --vault vault # v1
```

It sends no transaction and reads one final block. It prints about 22 numbered checks: the vault's code hash and source commit; its access keys; that the DAO runs the code `sputnik-dao.near` publishes as its default, the same bytes the sandbox tests deploy; the DAO's policy; every member's agent key limited to `exit` and `cancel_spend` (and any market key to `bid` and `settle_offer`); whether the DAO's factory auto-update is off; spend 0 `Cancelled` with the DAO proposal's arguments equal to the spend and its votes equal to the approvers; the record's order; every exit's `reason_hash` equal to the hash of its published note, computed with the agent's own `hashNote`; leavers holding no shares; shares adding up; the USDC and NEAR books balancing; the USDC contract's own balance for the vault; what is held back for open spends; and every share sale at or above its reserve. Each line is `PASS`, `FAIL` or `INFO` (v2's remaining access key, the DAO's auto-update while it is on, and the market checks on code from before the market). It ends with `All checks passed` (exit code 0) or the number of failures. The same script runs every hour in the `Mainnet checks` workflow; its badge is at the top of the README.

To rebuild the deployed code from source (needs Docker and `cargo-near`):

```sh
near contract verify deployed-at vault2.dissentfinance.near network-config mainnet now
near contract verify deployed-at vault.dissentfinance.near network-config mainnet now
```

## 3. Tests

See [README, Run it yourself](README.md#run-it-yourself): `npm test` in `agent/` (51 tests, including `verify.mjs` against a stand-in for mainnet with four planted faults it must catch), `npm test` in `tests/page/` (9 tests of the demo page in headless Chromium), `cargo test --lib` in `contracts/vault/` (82 tests, two of them property tests), `cargo test --test sputnik_flow` and `cargo test --test swarm_scenario` (sandbox tests against the real Sputnik DAO contract), `node agent/sim/swarm.js` (a replay of real DAO spends with 30 rule profiles) and `node agent/sim/market.js` (20 market agents through 30 share auctions).

## 4. Agents on duty

`.github/workflows/guard.yml` keeps Ben's and Cara's agents watching v2 around the clock, each in its own process with only its own function-call key, which the guard checks on chain before starting. The page's Proof section shows whether a guard run is watching now. See [README, Agents on duty](README.md#agents-on-duty).

## Limits, stated plainly

- Not a veto: dissenters cannot stop a spend, only leave before it pays.
- Not audited. Small real amounts on mainnet.
- v2 still holds its full-access key while the last checks run; the page and `verify.mjs` say so. v1 is keyless.
- More in [README, Known limits](README.md#known-limits).
