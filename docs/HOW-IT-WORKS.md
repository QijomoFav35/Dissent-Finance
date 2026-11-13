# How it works

[Back to the README](../README.md)


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

The share market's rules are in [RULES.md](../RULES.md). Every limit we know of is in [README, Known limits](../README.md#known-limits).
