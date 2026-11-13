# What agents with varied rules would have done to real contested spends

[Back to the README](../README.md)


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
