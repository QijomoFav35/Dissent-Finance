# Every test, with what you should see

[Back to the README](../README.md)


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

   You should see 53 pass, 0 fail. They include the story in the [README](../README.md#the-story-the-tests-check), retries that reuse the same note with a backoff and a cap, a prompt injection in the spend's memo, five separate agents each with only its own key, the simulation below, the guard refusing any key broader than an agent key, the market agent's bids, limits and settling, the 20-agent market simulation, and `verify.mjs` run against a stand-in for mainnet: every check passes on the real state and on the state the third run leaves, and six planted faults (a widened agent key, a wrong note hash, unbalanced books, a share sale under its reserve, the DAO's auto-update switched back on, an access key on a vault that should have none) each fail their check.

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

   You should see the table in [REPLAY.md](REPLAY.md).

7. The mainnet run, checked against the chain. Needs only Node, no keys and no installs.

   ```
   node agent/mainnet/verify.mjs
   node agent/mainnet/verify.mjs --vault vault
   ```

   For v2 and then v1, it reads one final block and prints about 23 numbered checks, each PASS, FAIL or INFO:

   - the vault's code hash and the commit its NEP-330 metadata names; its access keys (INFO on v2, which still has its key; FAIL if v1 ever had one); the DAO and token it answers to;
   - the DAO's code is the code `sputnik-dao.near` publishes as its default, and the same bytes as `contracts/vault/res/sputnikdao2.wasm`, which the sandbox tests deploy; the DAO's policy (one council of the five named members, no Everyone role, two votes); that the DAO's factory auto-update is off (FAIL if it is ever switched back on);
   - every member's agent key, read from their own account: a function-call key for `exit` and `cancel_spend` on the vault, and at most a market key for `bid` and `settle_offer`, nothing more;
   - spend 0 is `Cancelled`; the DAO proposal is Approved and its `queue_spend` arguments are the spend; the Approve votes are the spend's approvers; the vault's record shows the queue, the exits and the cancel in that order, inside the window;
   - for each exit, the `reason_hash` in the vault's record equals the hash of the published note, computed on your machine, and so does the one in the exit transaction while the RPC endpoints still serve it (older transactions need an archival node; the line says which was compared); leavers hold no shares unless the record shows them joining again after the cancel;
   - the remaining shares add up; the USDC and NEAR books balance (held = deposited - spent - fees - exited - refunded); the USDC contract's own balance for the vault covers what the vault owes members, bid funds included; what is held back for open spends equals the sum of their holds; any approver who left while a spend they approved was open, and what became of that spend; every share sale was at or above its reserve and is in the vault's record (both INFO on code from before the market).

   It should end with `All checks passed`. The exit code is the number of failed checks. `--json` prints the same checks as JSON. The `Mainnet verify` workflow runs it on every push and on an hourly schedule, which GitHub honours when it has capacity.
