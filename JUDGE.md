# Judging Dissent Finance in five minutes

**When a Sputnik DAO votes to spend the group's money, members who did not approve can take their share out before it pays, and their agents do it for them.** Live on NEAR mainnet with real USDC, next to an unchanged Sputnik DAO whose factory auto-update is off. Most Social Money tools pay people out; Dissent Finance protects the people who are outvoted.

Every claim below links to the chain or to the code at commit `6ae0259`, the exact source of the deployed vault (code hash `2CkdfmNBiPGukvkBpRm1AygHERiGDdPXf23eXPL58uVM`). You need a browser for the page and Node 20+ for the check. No wallet, account or install.

## Against the judging criteria

| Criterion | What to look at | Proof |
|---|---|---|
| **Technical** | A vault of about 1,500 lines that reads each approved proposal back from the DAO and checks it byte for byte before queueing; pro-rata exits rounded in the vault's favour; held-back parts for approvers who leave; a share-sale auction that never moves the fund. 82 contract tests including two property tests, 10 sandbox tests against the real mainnet Sputnik code, 53 agent tests, 9 page tests, all in CI | [queue_spend](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/src/lib.rs#L391), [check_proposal](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/src/checks.rs#L23), [exit_amounts (holds)](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/src/lib.rs#L763), [settle_offer](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/src/market.rs#L178), [property test](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/src/prop_tests.rs#L689), [sandbox story](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/tests/sputnik_flow.rs#L11) |
| **Works on mainnet, checkably** | Three live runs with native USDC; a reproducible build; one read-only command checks 23 things against one final block, and CI runs it on every push and on a schedule | [docs/MAINNET.md](docs/MAINNET.md), `node agent/mainnet/verify.mjs`, [Mainnet verify runs](https://github.com/QijomoFav35/Dissent-Finance/actions/workflows/watch.yml) |
| **Originality** | Ragequit next to an unchanged Sputnik DAO, which has none; agents that leave on the member's own rules with a hashed note; an approver who leaves pays their part instead of being locked in as in Moloch; a market price for leaving | [README, Why this](README.md#why-this-and-what-is-new), [RULES.md](RULES.md) |
| **Track fit (Social Money)** | Collective ownership by shares; shared budgets where every spend waits out a window; built on the existing DAO and visible in Trezu; named accounts for every member, agent key and exit. The "never paid before" rule is a trust tier earned by being paid | [Trezu requests](https://trezu.app/dissentfinance.sputnik-dao.near/requests?tab=Approved), [screenshot](docs/images/trezu-requests.jpg) |
| **Safety of agents** | Agent keys are function-call keys on each member's own account, limited to `exit` and `cancel_spend` (market keys to `bid` and `settle_offer`), no deposit. The runtime's own refusals are recorded | [evaluate](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/agent/src/rules.js#L27), [key refusals](docs/MAINNET.md#runs-2-and-3-v2), [sandbox key test](https://github.com/QijomoFav35/Dissent-Finance/blob/6ae02598ff28e45046523b940a6bcf061705fe50/contracts/vault/tests/sputnik_flow.rs#L213) |
| **Impact** | 473 approved transfers in 16 Sputnik DAOs went through over a Reject vote; 30 rule profiles replayed over them show which agents would have left and which spends would have died | [docs/REPLAY.md](docs/REPLAY.md) |
| **Sustainability** | Any existing Sputnik DAO can add it without moving its members or votes; a 0.1% fee on paid spends is the only revenue, visible on chain | [docs/ADOPT.md](docs/ADOPT.md) |
| **Design** | The page reads mainnet in your browser, replays the spend from the vault's record, hashes each note itself, and lets you run the agent's own rules with no wallet | [Live page](https://qijomofav35.github.io/Dissent-Finance/) |

## 1. The five-minute path

1. **Open https://qijomofav35.github.io/Dissent-Finance/.** Your browser reads mainnet directly: the code hash is the reproducible build, 3 of 3 exit notes match the chain, the spend was cancelled, and the access-key count.
2. **"The same vote, two outcomes".** Two of five members approve paying Ben 60% of the fund. Without the vault (a counterfactual, labelled as one) the DAO pays. On mainnet with the vault, three agents leave with their exact 0.20 USDC each and the spend is cancelled 11.2 seconds after it was queued, by the vault's own timestamps. 0 USDC paid out.
3. **"Try it, no wallet".** Tap "Alice's rules", then change them. Your browser loads `agent/src/rules.js` from this repo and runs it against the real spend.
4. **"The live run", then "Replay the spend".** The queue, the three exits and the cancel, read from the vault's own record, each linked to its transaction. Each note card is hashed in your browser and matched to the hash the exit carried on chain.
5. **"Share market".** On 13 November three agents, each with a key that can only bid and settle, bid 7 times for part of Cara's shares; Dan bought at 0.085979 USDC, 95.5% of value ([offer](https://nearblocks.io/txns/6DxKZ99sg7t84ieVKXA7z9hmvcoPrzpSjjPKrAJvFwFN)). The same day Cara approved a spend and left while it was open, with her part held back for it ([exit](https://nearblocks.io/txns/53qLDWKV7hAij7P9MeJFRjshBJfeKR8GRaTpsd4ikd6u)).
6. **Switch v1 / v2** at the top right. v1 (`vault.dissentfinance.near`) ran the first live story and has no access keys. v2 has the fixes found in review and ran the other two.

## 2. One-command check (read-only, under a minute)

```sh
git clone https://github.com/QijomoFav35/Dissent-Finance && cd Dissent-Finance
node agent/mainnet/verify.mjs               # v2
node agent/mainnet/verify.mjs --vault vault # v1
```

It sends nothing and reads one final block. It checks:
- the vault's code hash and source commit, and its access keys;
- that the DAO runs the code `sputnik-dao.near` publishes as its default (the same bytes the sandbox tests deploy), its policy, and that its factory auto-update is off;
- that every agent key and market key is limited to its methods;
- the first spend `Cancelled` with the DAO proposal's arguments equal to the spend and its votes equal to the approvers, and the record's order;
- every exit's `reason_hash` against the hash of its published note, computed with the agent's own code;
- shares adding up, the USDC and NEAR books balancing, and the USDC contract's own balance for the vault;
- what is held back for open spends, every approver who left while a spend they approved was open (and that the spend still settled), and every share sale at or above its reserve and in the record.

Each line is `PASS`, `FAIL` or `INFO`; it ends with `All checks passed` (exit code 0) or the number of failures. To rebuild the deployed code from source (Docker and `cargo-near`): `near contract verify deployed-at vault2.dissentfinance.near network-config mainnet now`.

## 3. Tests

`cargo test --lib`, `cargo test --test sputnik_flow` and `cargo test --test swarm_scenario` in `contracts/vault/`; `npm test` in `agent/` and in `tests/page/`. What each should print: [docs/TESTING.md](docs/TESTING.md).

## Limits, stated plainly

- Not a veto: members who disagree cannot stop a spend, only leave before it pays (or make it unpayable by leaving).
- Not audited. Small real amounts on mainnet; every member account in the demo is run by the team.
- v2 still holds its full-access key until the final check before submission; the page and `verify.mjs` say so. v1 is keyless.
- More in [README, Known limits](README.md#known-limits).
