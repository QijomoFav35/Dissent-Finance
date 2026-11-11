use super::*;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const WINDOW: u64 = 600 * 1_000_000_000;
const USDC: u128 = 1_000_000; // 1 USDC, 6 decimals
const NEAR: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn vault_id() -> AccountId {
    acc("vault.near")
}
fn dao() -> AccountId {
    acc("group.sputnik-dao.near")
}
fn usdc() -> AccountId {
    acc("usdc.near")
}

struct Env {
    now: u64,
}

impl Env {
    fn call(&self, who: &AccountId, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(vault_id())
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(self.now);
        testing_env!(b.build());
    }
}

fn setup() -> (Vault, Env) {
    let env = Env { now: 1_000 };
    env.call(&acc("deployer.near"), 0);
    let v = Vault::new(dao(), usdc(), acc("fee.near"), U64(WINDOW));
    (v, env)
}

fn join(v: &mut Vault, env: &Env, who: &str, near: u128, usdc_amt: u128) -> u128 {
    let who = acc(who);
    if usdc_amt > 0 {
        env.call(&usdc(), 0);
        match v.ft_on_transfer(who.clone(), U128(usdc_amt), "join".into()) {
            PromiseOrValue::Value(r) => assert_eq!(r.0, 0),
            _ => panic!("expected value"),
        }
    }
    env.call(&who, near);
    let _ = v.join();
    // The DAO answers get_policy; the callback finishes the join.
    env.call(&vault_id(), 0);
    v.complete_join(who, near, Some(&member_policy()))
}

fn member_policy() -> Value {
    json!({
        "roles": [
            { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
            { "name": "council", "kind": { "Group": ["ada.near", "bayo.near", "chi.near", "dayo.near", "efe.near", "frank.near"] },
              "permissions": ["*:*"], "vote_policy": {} }
        ]
    })
}

fn five_members() -> (Vault, Env) {
    let (mut v, env) = setup();
    for m in ["ada.near", "bayo.near", "chi.near", "dayo.near", "efe.near"] {
        join(&mut v, &env, m, 10 * NEAR, 100 * USDC);
    }
    (v, env)
}

fn spend_args(proposal_id: u64, recipient: &str, token_id: &str, amount: u128) -> Vec<u8> {
    near_sdk::serde_json::to_vec(&json!({
        "proposal_id": proposal_id,
        "recipient": recipient,
        "token_id": token_id,
        "amount": U128(amount),
        "memo": "spend",
    }))
    .unwrap()
}

fn proposal(status: &str, receiver: &str, method: &str, args: &[u8], votes: Value) -> Value {
    json!({
        "id": 7,
        "proposer": "bayo.near",
        "description": "pay the designer",
        "status": status,
        "kind": { "FunctionCall": {
            "receiver_id": receiver,
            "actions": [{ "method_name": method, "args": STANDARD.encode(args), "deposit": "0", "gas": "150000000000000" }]
        }},
        "vote_counts": {},
        "votes": votes,
        "submission_time": "0"
    })
}

fn two_approvals() -> Value {
    json!({ "bayo.near": "Approve", "chi.near": "Approve" })
}

/// Queues a spend the way the callback does, after a passing proposal check.
fn queue(v: &mut Vault, env: &Env, proposal_id: u64, recipient: &str, token: Token, amount: u128, votes: Value) -> u64 {
    let token_id = match token {
        Token::Near => "near".to_string(),
        Token::Usdc => usdc().to_string(),
    };
    let args = spend_args(proposal_id, recipient, &token_id, amount);
    let p = proposal("Approved", "vault.near", "queue_spend", &args, votes);
    env.call(&vault_id(), 0);
    v.record_spend(&args, &p, proposal_id, acc(recipient), token, U128(amount), "spend".into())
        .unwrap()
}

fn assert_books(v: &Vault, token: Token) {
    let l = v.get_ledger(token);
    assert_eq!(
        l.balance.0 + l.pending_joins.0,
        l.deposited.0 - l.spent.0 - l.fees.0 - l.exited.0 - l.refunded.0,
        "books do not balance for {token:?}: {l:?}"
    );
}

// ---------- joining ----------

#[test]
fn first_join_sets_the_ratio() {
    let (mut v, env) = setup();
    let shares = join(&mut v, &env, "ada.near", 10 * NEAR, 100 * USDC);
    assert_eq!(shares, 10 * NEAR);
    let b = v.get_balances();
    assert_eq!(b.near.0, 10 * NEAR);
    assert_eq!(b.usdc.0, 100 * USDC);
    assert_eq!(b.members, 1);
    assert_books(&v, Token::Near);
    assert_books(&v, Token::Usdc);
}

#[test]
fn later_join_matches_ratio_and_refunds_excess() {
    let (mut v, env) = setup();
    join(&mut v, &env, "ada.near", 10 * NEAR, 100 * USDC);
    // Sends twice the NEAR the ratio needs for 50 USDC.
    let shares = join(&mut v, &env, "bayo.near", 10 * NEAR, 50 * USDC);
    assert_eq!(shares, 5 * NEAR);
    let b = v.get_balances();
    assert_eq!(b.near.0, 15 * NEAR);
    assert_eq!(b.usdc.0, 150 * USDC);
    assert_eq!(v.get_ledger(Token::Near).refunded.0, 5 * NEAR);
    assert_books(&v, Token::Near);
    assert_books(&v, Token::Usdc);
}

#[test]
fn excess_usdc_is_refunded_too() {
    let (mut v, env) = setup();
    join(&mut v, &env, "ada.near", 10 * NEAR, 100 * USDC);
    let shares = join(&mut v, &env, "bayo.near", 1 * NEAR, 100 * USDC);
    assert_eq!(shares, NEAR);
    assert_eq!(v.get_balances().usdc.0, 110 * USDC);
    assert_eq!(v.get_ledger(Token::Usdc).refunded.0, 90 * USDC);
    assert_books(&v, Token::Usdc);
}

#[test]
fn first_join_needs_both_tokens_and_refunds_otherwise() {
    let (mut v, env) = setup();
    assert_eq!(join(&mut v, &env, "ada.near", 10 * NEAR, 0), 0);
    assert_eq!(v.get_balances().total_shares.0, 0);
    assert_eq!(v.get_ledger(Token::Near).refunded.0, 10 * NEAR);
    assert_books(&v, Token::Near);
}

#[test]
fn non_member_is_refused_and_refunded() {
    let (mut v, env) = setup();
    join(&mut v, &env, "ada.near", 10 * NEAR, 100 * USDC);
    assert_eq!(join(&mut v, &env, "stranger.near", 10 * NEAR, 100 * USDC), 0);
    assert_eq!(v.get_shares(acc("stranger.near")).0, 0);
    assert_eq!(v.get_balances().near.0, 10 * NEAR);
    assert_eq!(v.get_ledger(Token::Near).refunded.0, 10 * NEAR);
    // The USDC stays pending so it can be withdrawn.
    assert_eq!(v.get_pending(acc("stranger.near")).0, 100 * USDC);
    env.call(&acc("stranger.near"), 0);
    v.cancel_join();
    assert_books(&v, Token::Near);
    assert_books(&v, Token::Usdc);
}

#[test]
fn unreadable_policy_refuses_the_join() {
    let (mut v, env) = setup();
    env.call(&usdc(), 0);
    let _ = v.ft_on_transfer(acc("ada.near"), U128(100 * USDC), "join".into());
    env.call(&acc("ada.near"), 10 * NEAR);
    let _ = v.join();
    env.call(&vault_id(), 0);
    assert_eq!(v.complete_join(acc("ada.near"), 10 * NEAR, None), 0);
    assert_eq!(v.get_balances().members, 0);
}

#[test]
fn everyone_role_is_not_membership() {
    let p = json!({ "roles": [{ "name": "all", "kind": "Everyone" }, { "name": "holders", "kind": { "Member": "1" } }] });
    assert!(!is_member(&p, &acc("ada.near")));
    assert!(is_member(&member_policy(), &acc("ada.near")));
    assert!(!is_member(&json!({}), &acc("ada.near")));
}

#[test]
fn spend_queued_between_join_and_callback_refuses_the_join() {
    let (mut v, env) = five_members();
    env.call(&usdc(), 0);
    let _ = v.ft_on_transfer(acc("frank.near"), U128(100 * USDC), "join".into());
    env.call(&acc("frank.near"), 10 * NEAR);
    let _ = v.join();
    // A spend lands before the policy callback runs.
    queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    env.call(&vault_id(), 0);
    assert_eq!(v.complete_join(acc("frank.near"), 10 * NEAR, Some(&member_policy())), 0);
    assert_eq!(v.get_shares(acc("frank.near")).0, 0);
}

#[test]
#[should_panic(expected = "ERR_EMPTY_DEPOSIT")]
fn join_with_nothing_fails() {
    let (mut v, env) = setup();
    join(&mut v, &env, "ada.near", 0, 0);
}

#[test]
#[should_panic(expected = "ERR_WINDOW_OPEN")]
fn join_refused_while_a_spend_is_queued() {
    let (mut v, env) = five_members();
    queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    join(&mut v, &env, "frank.near", 10 * NEAR, 100 * USDC);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn only_the_fund_usdc_is_accepted() {
    let (mut v, env) = setup();
    env.call(&acc("fake-usdc.near"), 0);
    let _ = v.ft_on_transfer(acc("ada.near"), U128(USDC), "join".into());
}

#[test]
fn transfer_without_join_msg_is_returned() {
    let (mut v, env) = setup();
    env.call(&usdc(), 0);
    match v.ft_on_transfer(acc("ada.near"), U128(5 * USDC), "hello".into()) {
        PromiseOrValue::Value(r) => assert_eq!(r.0, 5 * USDC),
        _ => panic!("expected value"),
    }
    assert_eq!(v.get_pending(acc("ada.near")).0, 0);
}

#[test]
fn cancel_join_refunds_pending_usdc() {
    let (mut v, env) = setup();
    env.call(&usdc(), 0);
    let _ = v.ft_on_transfer(acc("ada.near"), U128(40 * USDC), "join".into());
    assert_eq!(v.get_pending(acc("ada.near")).0, 40 * USDC);
    env.call(&acc("ada.near"), 0);
    v.cancel_join();
    assert_eq!(v.get_pending(acc("ada.near")).0, 0);
    let l = v.get_ledger(Token::Usdc);
    assert_eq!(l.refunded.0, 40 * USDC);
    assert_eq!(l.in_flight.0, 40 * USDC);
    assert_books(&v, Token::Usdc);
}

#[test]
#[should_panic(expected = "ERR_NO_PENDING_DEPOSIT")]
fn cancel_join_without_deposit_fails() {
    let (mut v, env) = setup();
    env.call(&acc("ada.near"), 0);
    v.cancel_join();
}

// ---------- the proposal check ----------

#[test]
fn proposal_check_passes_on_exact_match() {
    let args = spend_args(3, "bayo.near", "usdc.near", 300 * USDC);
    let votes = json!({ "bayo.near": "Approve", "chi.near": "Approve", "ada.near": "Reject", "dayo.near": "Remove" });
    let p = proposal("Approved", "vault.near", "queue_spend", &args, votes);
    let c = check_proposal(&p, &vault_id(), "queue_spend", &args).unwrap();
    assert_eq!(c.approvers, vec![acc("bayo.near"), acc("chi.near")]);
    assert_eq!(c.objectors, vec![acc("ada.near"), acc("dayo.near")]);
}

#[test]
fn proposal_check_rejects_every_mismatch() {
    let args = spend_args(3, "bayo.near", "usdc.near", 300 * USDC);
    let ok = |p: &Value, a: &[u8]| check_proposal(p, &vault_id(), "queue_spend", a);

    for status in ["InProgress", "Rejected", "Removed", "Expired", "Failed", "Moved"] {
        let p = proposal(status, "vault.near", "queue_spend", &args, two_approvals());
        assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH), "status {status}");
    }
    let p = proposal("Approved", "other-vault.near", "queue_spend", &args, two_approvals());
    assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH));

    let p = proposal("Approved", "vault.near", "exit", &args, two_approvals());
    assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH));

    // One byte different: the amount.
    let other = spend_args(3, "bayo.near", "usdc.near", 300 * USDC + 1);
    let p = proposal("Approved", "vault.near", "queue_spend", &other, two_approvals());
    assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH));

    // Same JSON with different key order is still different bytes.
    let reordered = near_sdk::serde_json::to_vec(&json!({
        "recipient": "bayo.near", "proposal_id": 3, "token_id": "usdc.near", "amount": U128(300 * USDC), "memo": "spend"
    }))
    .unwrap();
    if reordered != args {
        let p = proposal("Approved", "vault.near", "queue_spend", &reordered, two_approvals());
        assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH));
    }

    let p = proposal("Approved", "vault.near", "queue_spend", &args, json!({ "ada.near": "Reject" }));
    assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH), "no approvers");

    let p = proposal("Approved", "vault.near", "queue_spend", &args, json!({ "ada.near": "Maybe" }));
    assert_eq!(ok(&p, &args), Err(ERR_PROPOSAL_MISMATCH), "unknown vote");
}

#[test]
fn proposal_check_rejects_two_actions_and_other_kinds() {
    let args = spend_args(3, "bayo.near", "usdc.near", 300 * USDC);
    let mut p = proposal("Approved", "vault.near", "queue_spend", &args, two_approvals());
    let action = p["kind"]["FunctionCall"]["actions"][0].clone();
    p["kind"]["FunctionCall"]["actions"] = json!([action.clone(), action]);
    assert_eq!(check_proposal(&p, &vault_id(), "queue_spend", &args), Err(ERR_PROPOSAL_MISMATCH));

    let transfer = json!({
        "status": "Approved",
        "kind": { "Transfer": { "token_id": "", "receiver_id": "bayo.near", "amount": "1" } },
        "votes": two_approvals()
    });
    assert_eq!(check_proposal(&transfer, &vault_id(), "queue_spend", &args), Err(ERR_PROPOSAL_MISMATCH));

    let mut bad_b64 = proposal("Approved", "vault.near", "queue_spend", &args, two_approvals());
    bad_b64["kind"]["FunctionCall"]["actions"][0]["args"] = json!("%%%not base64");
    assert_eq!(check_proposal(&bad_b64, &vault_id(), "queue_spend", &args), Err(ERR_PROPOSAL_MISMATCH));
}

#[test]
#[should_panic(expected = "ERR_NOT_DAO")]
fn queue_spend_only_from_the_dao() {
    let (mut v, env) = five_members();
    env.call(&acc("bayo.near"), 0);
    let _ = v.queue_spend(1, acc("bayo.near"), "usdc.near".into(), U128(USDC), None);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn queue_spend_rejects_unknown_token() {
    let (mut v, env) = five_members();
    env.call(&dao(), 0);
    let _ = v.queue_spend(1, acc("bayo.near"), "wbtc.near".into(), U128(USDC), None);
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn queue_spend_rejects_zero() {
    let (mut v, env) = five_members();
    env.call(&dao(), 0);
    let _ = v.queue_spend(1, acc("bayo.near"), "usdc.near".into(), U128(0), None);
}

#[test]
fn queue_spend_from_dao_schedules_the_check() {
    let (mut v, env) = five_members();
    env.call(&dao(), 0);
    let _ = v.queue_spend(1, acc("bayo.near"), "usdc.near".into(), U128(USDC), None);
    // Nothing is queued until the DAO's record is read back.
    assert!(v.get_open_spends().is_empty());
}

#[test]
fn record_spend_opens_a_window_and_stores_votes() {
    let (mut v, env) = five_members();
    let id = queue(&mut v, &env, 4, "bayo.near", Token::Usdc, 300 * USDC, json!({
        "bayo.near": "Approve", "chi.near": "Approve", "ada.near": "Reject"
    }));
    let s = v.get_spend(id).unwrap();
    assert_eq!(s.status, SpendStatus::Queued);
    assert_eq!(s.window_ends.0, env.now + WINDOW);
    assert_eq!(s.approvers, vec![acc("bayo.near"), acc("chi.near")]);
    assert_eq!(s.objectors, vec![acc("ada.near")]);
    assert_eq!(v.get_spend_by_proposal(4).unwrap().id, id);
    assert_eq!(v.get_open_spends().len(), 1);
}

#[test]
fn the_same_proposal_cannot_be_queued_twice() {
    let (mut v, env) = five_members();
    queue(&mut v, &env, 4, "bayo.near", Token::Usdc, 10 * USDC, two_approvals());
    let args = spend_args(4, "bayo.near", "usdc.near", 10 * USDC);
    let p = proposal("Approved", "vault.near", "queue_spend", &args, two_approvals());
    let r = v.record_spend(&args, &p, 4, acc("bayo.near"), Token::Usdc, U128(10 * USDC), "spend".into());
    assert_eq!(r, Err(ERR_ALREADY_QUEUED));
}

#[test]
fn a_spend_approved_by_someone_with_no_shares_is_refused() {
    let (mut v, _env) = five_members();
    let approvals = json!({ "bayo.near": "Approve", "ghost.near": "Approve" });
    let args = spend_args(9, "bayo.near", "usdc.near", 10 * USDC);
    let p = proposal("Approved", "vault.near", "queue_spend", &args, approvals);
    let r = v.record_spend(&args, &p, 9, acc("bayo.near"), Token::Usdc, U128(10 * USDC), "spend".into());
    assert_eq!(r, Err(ERR_APPROVER_NOT_HOLDER));
    assert!(v.get_open_spends().is_empty());
}

// ---------- exits ----------

#[test]
fn exit_pays_an_exact_fifth_and_burns_shares() {
    let (mut v, env) = five_members();
    env.call(&acc("ada.near"), 0);
    v.exit(Some("note-hash".into()));
    let b = v.get_balances();
    assert_eq!(b.near.0, 40 * NEAR);
    assert_eq!(b.usdc.0, 400 * USDC);
    assert_eq!(b.members, 4);
    assert_eq!(v.get_shares(acc("ada.near")).0, 0);
    assert_eq!(v.get_ledger(Token::Usdc).exited.0, 100 * USDC);
    assert_books(&v, Token::Near);
    assert_books(&v, Token::Usdc);
}

#[test]
#[should_panic(expected = "ERR_NO_SHARES")]
fn exit_twice_fails() {
    let (mut v, env) = five_members();
    env.call(&acc("ada.near"), 0);
    v.exit(None);
    v.exit(None);
}

#[test]
#[should_panic(expected = "ERR_APPROVED_SPEND_PENDING")]
fn approver_cannot_exit_while_their_spend_is_open() {
    let (mut v, env) = five_members();
    queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    env.call(&acc("chi.near"), 0);
    v.exit(None);
}

#[test]
fn objector_and_absent_member_can_exit_during_the_window() {
    let (mut v, env) = five_members();
    queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, json!({
        "bayo.near": "Approve", "chi.near": "Approve", "ada.near": "Reject"
    }));
    env.call(&acc("ada.near"), 0);
    v.exit(None);
    env.call(&acc("dayo.near"), 0);
    v.exit(None);
    assert_eq!(v.get_balances().usdc.0, 300 * USDC);
}

#[test]
fn approver_can_exit_once_the_spend_is_settled() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "shop.near", Token::Usdc, 10 * USDC, two_approvals());
    env.now += WINDOW;
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(id);
    env.call(&acc("chi.near"), 0);
    v.exit(None);
    assert_eq!(v.get_shares(acc("chi.near")).0, 0);
}

#[test]
fn exit_rounds_down_in_the_vaults_favour() {
    let (mut v, env) = setup();
    join(&mut v, &env, "ada.near", 3, 10);
    join(&mut v, &env, "bayo.near", 3, 10);
    join(&mut v, &env, "chi.near", 3, 10);
    env.call(&acc("ada.near"), 0);
    v.exit(None);
    let b = v.get_balances();
    assert_eq!(b.near.0, 6);
    assert_eq!(b.usdc.0, 20);
    assert_books(&v, Token::Near);
    assert_books(&v, Token::Usdc);
}

#[test]
fn exit_takes_no_deposit_so_a_limited_key_can_sign_it() {
    // A function-call access key cannot attach a deposit; exit must work with zero attached.
    let (mut v, env) = five_members();
    env.call(&acc("efe.near"), 0);
    v.exit(None);
    assert_eq!(v.get_balances().members, 4);
}

// ---------- spends ----------

#[test]
#[should_panic(expected = "ERR_WINDOW_NOT_CLOSED")]
fn spend_cannot_execute_early() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "shop.near", Token::Usdc, 10 * USDC, two_approvals());
    env.now += WINDOW - 1;
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(id);
}

#[test]
fn spend_executes_after_the_window_with_fee() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "shop.near", Token::Usdc, 100 * USDC, two_approvals());
    env.now += WINDOW;
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(id);
    let b = v.get_balances();
    assert_eq!(b.usdc.0, 500 * USDC - 100 * USDC - 100_000);
    assert_eq!(b.open_spends, 0);
    assert_eq!(v.get_spend(id).unwrap().status, SpendStatus::Executed);
    assert!(v.was_paid(acc("shop.near")));
    let l = v.get_ledger(Token::Usdc);
    assert_eq!(l.spent.0, 100 * USDC);
    assert_eq!(l.fees.0, 100_000);
    assert_books(&v, Token::Usdc);
}

#[test]
fn near_spend_executes() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "shop.near", Token::Near, 5 * NEAR, two_approvals());
    env.now += WINDOW;
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(id);
    assert_eq!(v.get_balances().near.0, 50 * NEAR - 5 * NEAR - fee_for(5 * NEAR));
    assert_books(&v, Token::Near);
}

#[test]
#[should_panic(expected = "ERR_ALREADY_EXECUTED")]
fn spend_cannot_execute_twice() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "shop.near", Token::Usdc, 10 * USDC, two_approvals());
    env.now += WINDOW;
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(id);
    v.execute_spend(id);
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_SPEND")]
fn unknown_spend_fails() {
    let (mut v, env) = five_members();
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(99);
}

#[test]
fn collective_cancel_three_agents_leave_and_the_spend_dies() {
    let (mut v, mut env) = five_members();
    // Bayo and Chi approve 300 USDC to Bayo, 60% of the fund's USDC.
    let id = queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    for m in ["ada.near", "dayo.near", "efe.near"] {
        env.call(&acc(m), 0);
        v.exit(Some(format!("{m}-note")));
    }
    assert_eq!(v.get_balances().usdc.0, 200 * USDC);

    env.now += WINDOW;
    env.call(&acc("efe.near"), 0);
    v.cancel_spend(id);
    assert_eq!(v.get_spend(id).unwrap().status, SpendStatus::Cancelled);
    assert_eq!(v.get_balances().open_spends, 0);
    assert_books(&v, Token::Usdc);
    assert_books(&v, Token::Near);

    // With the spend gone, the approvers are free to leave too.
    env.call(&acc("bayo.near"), 0);
    v.exit(None);
}

#[test]
#[should_panic(expected = "ERR_SPEND_UNAFFORDABLE")]
fn unaffordable_spend_cannot_execute() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    for m in ["ada.near", "dayo.near", "efe.near"] {
        env.call(&acc(m), 0);
        v.exit(None);
    }
    env.now += WINDOW;
    env.call(&acc("bayo.near"), 0);
    v.execute_spend(id);
}

#[test]
#[should_panic(expected = "ERR_SPEND_AFFORDABLE")]
fn affordable_spend_cannot_be_cancelled() {
    let (mut v, env) = five_members();
    let id = queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    env.call(&acc("ada.near"), 0);
    v.cancel_spend(id);
}

#[test]
fn spend_of_exactly_the_balance_minus_fee_is_affordable() {
    let (mut v, mut env) = five_members();
    // 500 USDC held; amount + 0.1% fee must fit.
    let amount = 500 * USDC * 10_000 / 10_010;
    let id = queue(&mut v, &env, 1, "shop.near", Token::Usdc, amount, two_approvals());
    env.now += WINDOW;
    env.call(&acc("anyone.near"), 0);
    v.execute_spend(id);
    assert_books(&v, Token::Usdc);
}

// ---------- transfers that bounce, and claims ----------

#[test]
fn failed_transfer_becomes_claimable_and_claim_retries() {
    let (mut v, env) = five_members();
    env.call(&acc("ada.near"), 0);
    v.exit(None);
    assert_eq!(v.get_ledger(Token::Usdc).in_flight.0, 100 * USDC);

    // Ada had no USDC storage: the transfer fails.
    env.call(&vault_id(), 0);
    v.settle_transfer(acc("ada.near"), Token::Usdc, 100 * USDC, false);
    assert_eq!(v.get_claimable(acc("ada.near")).1 .0, 100 * USDC);
    let l = v.get_ledger(Token::Usdc);
    assert_eq!(l.in_flight.0, 0);
    assert_eq!(l.claimable.0, 100 * USDC);

    env.call(&acc("ada.near"), 0);
    v.claim(Token::Usdc);
    assert_eq!(v.get_claimable(acc("ada.near")).1 .0, 0);
    assert_eq!(v.get_ledger(Token::Usdc).in_flight.0, 100 * USDC);

    env.call(&vault_id(), 0);
    v.settle_transfer(acc("ada.near"), Token::Usdc, 100 * USDC, true);
    let l = v.get_ledger(Token::Usdc);
    assert_eq!(l.in_flight.0, 0);
    assert_eq!(l.claimable.0, 0);
    assert_books(&v, Token::Usdc);
}

#[test]
#[should_panic(expected = "ERR_NOTHING_TO_CLAIM")]
fn claim_with_nothing_fails() {
    let (mut v, env) = five_members();
    env.call(&acc("ada.near"), 0);
    v.claim(Token::Near);
}

// ---------- rules and record ----------

#[test]
fn member_sets_rules_anyone_reads_them() {
    let (mut v, env) = five_members();
    env.call(&acc("ada.near"), 0);
    let r = Rules { max_spend_share_bps: Some(2_000), new_recipient: true, blocked_recipients: vec![acc("bayo.near")] };
    v.set_rules(r.clone());
    assert_eq!(v.get_rules(acc("ada.near")), Some(r));
    v.exit(None);
    assert_eq!(v.get_rules(acc("ada.near")), None);
}

#[test]
#[should_panic(expected = "ERR_NO_SHARES")]
fn non_member_cannot_set_rules() {
    let (mut v, env) = five_members();
    env.call(&acc("stranger.near"), 0);
    v.set_rules(Rules::default());
}

#[test]
#[should_panic(expected = "ERR_BAD_RULES")]
fn rule_share_above_100_percent_is_refused() {
    let (mut v, env) = five_members();
    env.call(&acc("ada.near"), 0);
    v.set_rules(Rules { max_spend_share_bps: Some(10_001), ..Default::default() });
}

#[test]
fn every_action_lands_in_the_record() {
    let (mut v, mut env) = five_members();
    let id = queue(&mut v, &env, 1, "bayo.near", Token::Usdc, 300 * USDC, two_approvals());
    for m in ["ada.near", "dayo.near", "efe.near"] {
        env.call(&acc(m), 0);
        v.exit(None);
    }
    env.now += WINDOW;
    env.call(&acc("efe.near"), 0);
    v.cancel_spend(id);
    let events: Vec<String> = v
        .get_record(0, 100)
        .iter()
        .map(|line| near_sdk::serde_json::from_str::<Value>(line).unwrap()["event"].as_str().unwrap().to_string())
        .collect();
    let joins = events.iter().filter(|e| *e == "join").count();
    let exits = events.iter().filter(|e| *e == "exit").count();
    assert_eq!(joins, 5);
    assert_eq!(exits, 3);
    assert!(events.contains(&"queue_spend".to_string()));
    assert_eq!(events.last().unwrap(), "cancel_spend");
    assert_eq!(v.get_record_len() as usize, events.len());
}

// ---------- math ----------

#[test]
fn join_math_never_keeps_more_than_it_was_given() {
    let cases = [(7u128, 13u128, 17u128, 5u128, 9u128), (1_000, 999, 1, 3, 1), (10, 10, 10, 1, 1000)];
    for (t, n, u, ni, ui) in cases {
        if let Ok((issued, nu, uu)) = join_math(t, n, u, ni, ui) {
            assert!(nu <= ni && uu <= ui);
            // The member's new share is never worth more than what was kept.
            assert!(issued * n <= nu * t && issued * u <= uu * t);
        }
    }
}

#[test]
fn fee_is_a_tenth_of_a_percent_rounded_down() {
    assert_eq!(fee_for(1_000_000), 1_000);
    assert_eq!(fee_for(999), 0);
    assert_eq!(fee_for(1_000), 1);
}
