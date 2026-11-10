//! Property tests: random sequences of joins, spends, votes, exits, cancels, bounced transfers and
//! claims, with every invariant from the spec checked after every single step.

use super::*;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use proptest::prelude::*;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

const WINDOW: u64 = 600 * 1_000_000_000;
const NAMES: [&str; 7] = ["ada.near", "bayo.near", "chi.near", "dayo.near", "efe.near", "frank.near", "stranger.near"];
const MEMBERS: usize = 6; // the first six are in the DAO's council group; "stranger" is not
const OTHERS: [&str; 2] = ["shop.near", "fee.near"];

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn policy() -> Value {
    json!({ "roles": [{ "name": "council", "kind": { "Group": &NAMES[..MEMBERS] }, "permissions": ["*:*"], "vote_policy": {} }] })
}

#[derive(Debug, Clone)]
enum Op {
    Deposit { who: usize, usdc: u128 },
    Join { who: usize, near: u128, usdc: u128 },
    CancelJoin { who: usize },
    Queue { usdc: bool, share_bps: u32, approve: u8, reject: u8, to_shop: bool },
    Exit { who: usize },
    Advance { secs: u64 },
    Execute { pick: usize },
    Cancel { pick: usize },
    Settle { ok: bool },
    Claim { who: usize, usdc: bool },
    SetRules { who: usize, bps: u16 },
}

fn op() -> impl Strategy<Value = Op> {
    let who = 0..NAMES.len();
    prop_oneof![
        2 => (who.clone(), 1u128..500_000_000).prop_map(|(who, usdc)| Op::Deposit { who, usdc }),
        5 => (who.clone(), 0u128..50_000_000_000_000_000_000_000_000, 0u128..500_000_000)
            .prop_map(|(who, near, usdc)| Op::Join { who, near, usdc }),
        1 => who.clone().prop_map(|who| Op::CancelJoin { who }),
        3 => (any::<bool>(), 1u32..15_000, any::<u8>(), any::<u8>(), any::<bool>())
            .prop_map(|(usdc, share_bps, approve, reject, to_shop)| Op::Queue { usdc, share_bps, approve, reject, to_shop }),
        4 => who.clone().prop_map(|who| Op::Exit { who }),
        2 => (0u64..1_200).prop_map(|secs| Op::Advance { secs }),
        2 => (0usize..8).prop_map(|pick| Op::Execute { pick }),
        2 => (0usize..8).prop_map(|pick| Op::Cancel { pick }),
        4 => any::<bool>().prop_map(|ok| Op::Settle { ok }),
        1 => (0..NAMES.len() + OTHERS.len(), any::<bool>()).prop_map(|(who, usdc)| Op::Claim { who, usdc }),
        1 => (who, 0u16..12_000).prop_map(|(who, bps)| Op::SetRules { who, bps }),
    ]
}

struct Harness {
    v: Vault,
    now: u64,
    next_proposal: u64,
    /// Amounts actually delivered out of the vault (transfers settled as successful), per token.
    delivered: [u128; 2],
    /// When each spend was executed.
    executed_at: BTreeMap<u64, u64>,
}

fn ti(t: Token) -> usize {
    match t {
        Token::Near => 0,
        Token::Usdc => 1,
    }
}

impl Harness {
    fn new() -> Self {
        SENT.with(|s| s.borrow_mut().clear());
        let h = Self { v: unsafe_init(), now: 1_000, next_proposal: 0, delivered: [0, 0], executed_at: BTreeMap::new() };
        h.at(&acc("deployer.near"), 0);
        h
    }

    fn at(&self, who: &AccountId, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.near"))
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            // The mock does not add attached deposits to the account; give it room to pay out.
            .account_balance(NearToken::from_near(1_000_000_000))
            .block_timestamp(self.now);
        testing_env!(b.build());
    }

    fn shares(&self, who: &AccountId) -> u128 {
        self.v.get_shares(who.clone()).0
    }

    /// What every holder could take out right now.
    fn values(&self) -> Vec<(AccountId, u128, u128)> {
        let b = self.v.get_balances();
        self.v
            .get_members(0, 100)
            .into_iter()
            .map(|(a, s)| (a, pro_rata(b.near.0, s.0, b.total_shares.0), pro_rata(b.usdc.0, s.0, b.total_shares.0)))
            .collect()
    }

    fn approver_of_open(&self, who: &AccountId) -> bool {
        self.v.get_open_spends().iter().any(|s| s.approvers.contains(who))
    }

    fn expect_panic<F: FnOnce(&mut Vault)>(&mut self, f: F) -> Result<(), TestCaseError> {
        let r = catch_unwind(AssertUnwindSafe(|| f(&mut self.v)));
        prop_assert!(r.is_err(), "expected the call to be refused");
        Ok(())
    }

    fn apply(&mut self, op: &Op) -> Result<(), TestCaseError> {
        match op.clone() {
            Op::Deposit { who, usdc } => {
                self.at(&acc("usdc.near"), 0);
                let _ = self.v.ft_on_transfer(acc(NAMES[who]), U128(usdc), "join".into());
            }
            Op::Join { who, near, usdc } => {
                let who = acc(NAMES[who.min(NAMES.len() - 1)]);
                if usdc > 0 {
                    self.at(&acc("usdc.near"), 0);
                    let _ = self.v.ft_on_transfer(who.clone(), U128(usdc), "join".into());
                }
                let pending = self.v.get_pending(who.clone()).0;
                let window_open = !self.v.get_open_spends().is_empty();
                self.at(&who, near);
                if window_open || (near == 0 && pending == 0) {
                    // Invariant 7: no join while a window is open.
                    return self.expect_panic(|v| {
                        let _ = v.join();
                    });
                }
                let before = self.values();
                let _ = self.v.join();
                self.at(&acc("vault.near"), 0);
                let issued = self.v.complete_join(who.clone(), near, Some(&policy()));
                let is_member = NAMES[..MEMBERS].contains(&who.as_str());
                if !is_member {
                    prop_assert_eq!(issued, 0, "a non-member received shares");
                }
                if issued > 0 {
                    prop_assert_eq!(self.v.get_pending(who.clone()).0, 0);
                }
                // A join never dilutes anyone already in the fund.
                let after: BTreeMap<_, _> = self.values().into_iter().map(|(a, n, u)| (a, (n, u))).collect();
                for (a, n, u) in before {
                    if a == who {
                        continue;
                    }
                    let (n2, u2) = after[&a];
                    prop_assert!(n2 >= n && u2 >= u, "join diluted {a}: near {n}->{n2}, usdc {u}->{u2}");
                }
            }
            Op::CancelJoin { who } => {
                let who = acc(NAMES[who]);
                self.at(&who, 0);
                if self.v.get_pending(who.clone()).0 == 0 {
                    return self.expect_panic(|v| v.cancel_join());
                }
                self.v.cancel_join();
                prop_assert_eq!(self.v.get_pending(who).0, 0);
            }
            Op::Queue { usdc, share_bps, approve, reject, to_shop } => {
                let holders: Vec<AccountId> = self.v.get_members(0, 100).into_iter().map(|(a, _)| a).collect();
                let pick = |mask: u8| -> Vec<AccountId> {
                    holders.iter().enumerate().filter(|(i, _)| mask & (1 << (i % 8)) != 0).map(|(_, a)| a.clone()).collect()
                };
                let approvers = pick(approve);
                if approvers.is_empty() {
                    return Ok(());
                }
                let rejecters: Vec<AccountId> = pick(reject).into_iter().filter(|a| !approvers.contains(a)).collect();
                let token = if usdc { Token::Usdc } else { Token::Near };
                let bal = self.v.get_ledger(token).balance.0;
                let amount = (bal * share_bps as u128 / 10_000).max(1);
                let recipient = if to_shop { acc("shop.near") } else { approvers[0].clone() };
                let token_id = if usdc { "usdc.near" } else { "near" };
                let pid = self.next_proposal;
                self.next_proposal += 1;
                let args = near_sdk::serde_json::to_vec(&json!({
                    "proposal_id": pid, "recipient": recipient, "token_id": token_id, "amount": U128(amount), "memo": "p"
                }))
                .unwrap();
                let mut votes = near_sdk::serde_json::Map::new();
                for a in &approvers {
                    votes.insert(a.to_string(), json!("Approve"));
                }
                for a in &rejecters {
                    votes.insert(a.to_string(), json!("Reject"));
                }
                let proposal = json!({
                    "status": "Approved",
                    "kind": { "FunctionCall": { "receiver_id": "vault.near", "actions": [{
                        "method_name": "queue_spend", "args": STANDARD.encode(&args), "deposit": "0", "gas": "150000000000000"
                    }]}},
                    "votes": votes
                });
                self.at(&acc("vault.near"), 0);
                let id = self.v.record_spend(&args, &proposal, pid, recipient, token, U128(amount), "p".into());
                prop_assert!(id.is_ok(), "a matching approved proposal was refused: {id:?}");
                let s = self.v.get_spend(id.unwrap()).unwrap();
                prop_assert_eq!(s.window_ends.0, self.now + WINDOW);
                // Replaying the same proposal is refused.
                let again = self.v.record_spend(&args, &proposal, pid, acc("shop.near"), token, U128(amount), "p".into());
                prop_assert_eq!(again, Err(ERR_ALREADY_QUEUED));
            }
            Op::Exit { who } => {
                let who = acc(NAMES[who]);
                self.at(&who, 0);
                let owned = self.shares(&who);
                if owned == 0 || self.approver_of_open(&who) {
                    // Invariant 6: an approver of an open spend cannot exit.
                    return self.expect_panic(|v| v.exit(None));
                }
                let b = self.v.get_balances();
                let want_near = pro_rata(b.near.0, owned, b.total_shares.0);
                let want_usdc = pro_rata(b.usdc.0, owned, b.total_shares.0);
                let exited = [self.v.get_ledger(Token::Near).exited.0, self.v.get_ledger(Token::Usdc).exited.0];
                let before = self.values();
                self.v.exit(Some("h".into()));
                // Invariant 3: an exit pays exactly the pro-rata share, rounded down, of each token.
                prop_assert_eq!(self.v.get_ledger(Token::Near).exited.0 - exited[0], want_near);
                prop_assert_eq!(self.v.get_ledger(Token::Usdc).exited.0 - exited[1], want_usdc);
                prop_assert_eq!(self.shares(&who), 0);
                // Nobody who stays loses value because someone left.
                let after: BTreeMap<_, _> = self.values().into_iter().map(|(a, n, u)| (a, (n, u))).collect();
                for (a, n, u) in before {
                    if a == who {
                        continue;
                    }
                    let (n2, u2) = after[&a];
                    prop_assert!(n2 >= n && u2 >= u, "exit hurt {a}: near {n}->{n2}, usdc {u}->{u2}");
                }
            }
            Op::Advance { secs } => self.now += secs * 1_000_000_000,
            Op::Execute { pick } => {
                let n = self.v.get_spends(0, 100).len();
                if n == 0 {
                    return Ok(());
                }
                let id = (pick % n) as u64;
                let s = self.v.get_spend(id).unwrap();
                let bal = self.v.get_ledger(s.token).balance.0;
                let affordable = s.amount.0 + fee_for(s.amount.0) <= bal;
                self.at(&acc("anyone.near"), 0);
                if s.status != SpendStatus::Queued || self.now < s.window_ends.0 || !affordable {
                    // Invariant 5: never before the window closes, never twice, never unaffordable.
                    return self.expect_panic(|v| v.execute_spend(id));
                }
                self.v.execute_spend(id);
                prop_assert_eq!(self.v.get_ledger(s.token).balance.0, bal - s.amount.0 - fee_for(s.amount.0));
                self.executed_at.insert(id, self.now);
            }
            Op::Cancel { pick } => {
                let n = self.v.get_spends(0, 100).len();
                if n == 0 {
                    return Ok(());
                }
                let id = (pick % n) as u64;
                let s = self.v.get_spend(id).unwrap();
                let affordable = s.amount.0 + fee_for(s.amount.0) <= self.v.get_ledger(s.token).balance.0;
                self.at(&acc("anyone.near"), 0);
                if s.status != SpendStatus::Queued || affordable {
                    return self.expect_panic(|v| v.cancel_spend(id));
                }
                self.v.cancel_spend(id);
                prop_assert_eq!(self.v.get_spend(id).unwrap().status, SpendStatus::Cancelled);
            }
            Op::Settle { ok } => {
                let next = SENT.with(|s| {
                    let mut s = s.borrow_mut();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.remove(0))
                    }
                });
                if let Some((to, token, amount)) = next {
                    self.at(&acc("vault.near"), 0);
                    self.v.settle_transfer(to, token, amount, ok);
                    if ok {
                        self.delivered[ti(token)] += amount;
                    }
                }
            }
            Op::Claim { who, usdc } => {
                let name = if who < NAMES.len() { NAMES[who] } else { OTHERS[who - NAMES.len()] };
                let who = acc(name);
                let token = if usdc { Token::Usdc } else { Token::Near };
                let (n, u) = self.v.get_claimable(who.clone());
                let owed = if usdc { u.0 } else { n.0 };
                self.at(&who, 0);
                if owed == 0 {
                    return self.expect_panic(|v| v.claim(token));
                }
                self.v.claim(token);
                let (n, u) = self.v.get_claimable(who);
                prop_assert_eq!(if usdc { u.0 } else { n.0 }, 0);
            }
            Op::SetRules { who, bps } => {
                let who = acc(NAMES[who]);
                self.at(&who, 0);
                let bad = self.shares(&who) == 0 || bps == 0 || bps > 10_000;
                let rules = Rules { max_spend_share_bps: Some(bps), new_recipient: bps % 2 == 0, blocked_recipients: vec![] };
                if bad {
                    return self.expect_panic(move |v| v.set_rules(rules));
                }
                self.v.set_rules(rules.clone());
                prop_assert_eq!(self.v.get_rules(who), Some(rules));
            }
        }
        Ok(())
    }

    fn check_invariants(&self) -> Result<(), TestCaseError> {
        let b = self.v.get_balances();
        // 1. Shares add up.
        let sum: u128 = self.v.get_members(0, 100).iter().map(|(_, s)| s.0).sum();
        prop_assert_eq!(sum, b.total_shares.0, "sum of shares != total_shares");
        prop_assert!(self.v.get_members(0, 100).iter().all(|(_, s)| s.0 > 0), "a zero-share holder is listed");

        let sent = SENT.with(|s| s.borrow().clone());
        let everyone: Vec<AccountId> = NAMES.iter().chain(OTHERS.iter()).map(|n| acc(n)).collect();
        for token in [Token::Near, Token::Usdc] {
            let l = self.v.get_ledger(token);
            // 2. Books: everything the vault received is held, in flight, claimable, or was paid out.
            prop_assert_eq!(
                l.balance.0 + l.pending_joins.0,
                l.deposited.0 - l.spent.0 - l.fees.0 - l.exited.0 - l.refunded.0,
                "{:?} books do not balance: {:?}", token, l
            );
            // In-flight equals the transfers still unsettled.
            let flying: u128 = sent.iter().filter(|(_, t, _)| *t == token).map(|(_, _, a)| a).sum();
            prop_assert_eq!(l.in_flight.0, flying, "{:?} in_flight drifted", token);
            // Claimable equals the sum of every account's claim.
            let claims: u128 = everyone
                .iter()
                .map(|a| {
                    let (n, u) = self.v.get_claimable(a.clone());
                    if token == Token::Near { n.0 } else { u.0 }
                })
                .sum();
            prop_assert_eq!(l.claimable.0, claims, "{:?} claimable drifted", token);
            // 4. Money leaves only through the paths we count: holdings plus deliveries equal deposits.
            let held = l.balance.0 + l.pending_joins.0 + l.in_flight.0 + l.claimable.0;
            prop_assert_eq!(held + self.delivered[ti(token)], l.deposited.0, "{:?} money left by an uncounted path", token);
        }
        // 5. Executed spends ran at or after their window closed.
        for (id, t) in &self.executed_at {
            let s = self.v.get_spend(*id).unwrap();
            prop_assert_eq!(s.status, SpendStatus::Executed);
            prop_assert!(*t >= s.window_ends.0, "spend {} executed early", id);
        }
        // 6. Every approver of an open spend still holds shares.
        for s in self.v.get_open_spends() {
            for a in &s.approvers {
                prop_assert!(self.shares(a) > 0, "approver {} left while spend {} was open", a, s.id);
            }
        }
        prop_assert_eq!(b.open_spends as usize, self.v.get_open_spends().len());
        Ok(())
    }
}

fn unsafe_init() -> Vault {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("vault.near")).predecessor_account_id(acc("deployer.near"));
    testing_env!(b.build());
    Vault::new(acc("group.sputnik-dao.near"), acc("usdc.near"), acc("fee.near"), U64(WINDOW))
}

/// The mocked chain lives in a thread-local, so each case runs on a fresh thread with empty storage.
fn isolated<F>(f: F) -> Result<(), TestCaseError>
where
    F: FnOnce() -> Result<(), TestCaseError> + Send + 'static,
{
    match std::thread::spawn(f).join() {
        Ok(r) => r,
        Err(p) => {
            let msg = p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            Err(TestCaseError::fail(format!("unexpected panic: {msg}")))
        }
    }
}

fn run_sequence(ops: Vec<Op>) -> Result<(), TestCaseError> {
    let mut h = Harness::new();
    for op in &ops {
        h.apply(op)?;
        h.check_invariants()?;
    }
    // Drain: settle every transfer, then the books close exactly.
    while SENT.with(|s| !s.borrow().is_empty()) {
        h.apply(&Op::Settle { ok: true })?;
    }
    h.check_invariants()?;
    for token in [Token::Near, Token::Usdc] {
        prop_assert_eq!(h.v.get_ledger(token).in_flight.0, 0);
    }
    Ok(())
}

fn run_everyone_leaves(joins: Vec<(usize, u128, u128)>) -> Result<(), TestCaseError> {
    let mut h = Harness::new();
    for (who, near, usdc) in joins {
        h.apply(&Op::Join { who, near, usdc })?;
    }
    for who in 0..MEMBERS {
        if h.shares(&acc(NAMES[who])) > 0 {
            h.apply(&Op::Exit { who })?;
        }
    }
    let b = h.v.get_balances();
    prop_assert_eq!(b.total_shares.0, 0);
    // The last member out takes everything that is left: nothing is stranded.
    prop_assert_eq!(b.near.0, 0, "NEAR stranded: {:?}", b);
    prop_assert_eq!(b.usdc.0, 0, "USDC stranded: {:?}", b);
    h.check_invariants()
}

proptest! {
    // PROPTEST_CASES=32 for quick runs while building; the default 256 before each commit.
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(256),
        ..ProptestConfig::default()
    })]

    #[test]
    fn invariants_hold_after_every_step(ops in proptest::collection::vec(op(), 1..80)) {
        isolated(move || run_sequence(ops))?;
    }

    #[test]
    fn everyone_leaving_empties_the_fund(
        joins in proptest::collection::vec((0usize..MEMBERS, 1u128..50_000_000_000_000_000_000_000_000, 1u128..500_000_000), 1..12)
    ) {
        isolated(move || run_everyone_leaves(joins))?;
    }
}
