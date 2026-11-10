//! Vault: holds a group's fund outside its Sputnik DAO, queues every approved spend
//! for a fixed window, and lets members who did not approve take their share out first.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

mod checks;
pub use checks::{check_proposal, ProposalCheck};

pub const ERR_NOT_DAO: &str = "ERR_NOT_DAO";
pub const ERR_ALREADY_QUEUED: &str = "ERR_ALREADY_QUEUED";
pub const ERR_PROPOSAL_MISMATCH: &str = "ERR_PROPOSAL_MISMATCH";
pub const ERR_WINDOW_OPEN: &str = "ERR_WINDOW_OPEN";
pub const ERR_WINDOW_NOT_CLOSED: &str = "ERR_WINDOW_NOT_CLOSED";
pub const ERR_ALREADY_EXECUTED: &str = "ERR_ALREADY_EXECUTED";
pub const ERR_SPEND_CANCELLED: &str = "ERR_SPEND_CANCELLED";
pub const ERR_SPEND_UNAFFORDABLE: &str = "ERR_SPEND_UNAFFORDABLE";
pub const ERR_SPEND_AFFORDABLE: &str = "ERR_SPEND_AFFORDABLE";
pub const ERR_APPROVED_SPEND_PENDING: &str = "ERR_APPROVED_SPEND_PENDING";
pub const ERR_NO_SHARES: &str = "ERR_NO_SHARES";
pub const ERR_NO_PENDING_DEPOSIT: &str = "ERR_NO_PENDING_DEPOSIT";
pub const ERR_EMPTY_DEPOSIT: &str = "ERR_EMPTY_DEPOSIT";
pub const ERR_EMPTY_FUND: &str = "ERR_EMPTY_FUND";
pub const ERR_WRONG_TOKEN: &str = "ERR_WRONG_TOKEN";
pub const ERR_UNKNOWN_SPEND: &str = "ERR_UNKNOWN_SPEND";
pub const ERR_NOTHING_TO_CLAIM: &str = "ERR_NOTHING_TO_CLAIM";
pub const ERR_ZERO_AMOUNT: &str = "ERR_ZERO_AMOUNT";
pub const ERR_BAD_RULES: &str = "ERR_BAD_RULES";

/// Fee on executed spends, in basis points (0.1%).
pub const FEE_BPS: u128 = 10;
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const EVENT_STANDARD: &str = "dissent";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Shares,
    Pending,
    ClaimNear,
    ClaimUsdc,
    Spends,
    ByProposal,
    Paid,
    Rules,
    Record,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Token {
    Near,
    Usdc,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SpendStatus {
    Queued,
    Executed,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Spend {
    pub id: u64,
    pub proposal_id: u64,
    pub recipient: AccountId,
    pub token: Token,
    pub amount: U128,
    pub memo: String,
    pub approvers: Vec<AccountId>,
    pub objectors: Vec<AccountId>,
    pub queued_at: U64,
    pub window_ends: U64,
    pub status: SpendStatus,
}

/// A member's exit rules, stored on the vault so anyone can read and replay them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Rules {
    pub max_spend_share_bps: Option<u16>,
    pub new_recipient: bool,
    pub blocked_recipients: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct Config {
    pub dao: AccountId,
    pub usdc: AccountId,
    pub fee_account: AccountId,
    pub window_ns: U64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Balances {
    pub near: U128,
    pub usdc: U128,
    pub total_shares: U128,
    pub members: u32,
    pub open_spends: u32,
}

/// Every unit of each token the vault is answerable for, for the accounting invariant.
#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Ledger {
    pub balance: U128,
    pub in_flight: U128,
    pub claimable: U128,
    pub pending_joins: U128,
    pub deposited: U128,
    pub spent: U128,
    pub fees: U128,
    pub exited: U128,
    pub refunded: U128,
}

#[near(serializers = [borsh])]
#[derive(Default)]
struct Tally {
    in_flight: u128,
    claimable: u128,
    deposited: u128,
    spent: u128,
    fees: u128,
    exited: u128,
    refunded: u128,
}

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDao {
    fn get_proposal(&self, id: u64) -> Value;
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_proposal(
        &mut self,
        raw_args: Base64VecU8,
        proposal_id: u64,
        recipient: AccountId,
        token: Token,
        amount: U128,
        memo: String,
    ) -> u64;
    fn on_transfer(&mut self, account_id: AccountId, token: Token, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    dao: AccountId,
    usdc: AccountId,
    fee_account: AccountId,
    window_ns: u64,
    total_shares: u128,
    shares: IterableMap<AccountId, u128>,
    near_balance: u128,
    usdc_balance: u128,
    pending_usdc: LookupMap<AccountId, u128>,
    pending_total: u128,
    claim_near: LookupMap<AccountId, u128>,
    claim_usdc: LookupMap<AccountId, u128>,
    spends: Vector<Spend>,
    by_proposal: LookupMap<u64, u64>,
    queued_ids: Vec<u64>,
    paid: LookupSet<AccountId>,
    rules: LookupMap<AccountId, Rules>,
    record: Vector<String>,
    near_tally: Tally,
    usdc_tally: Tally,
}

#[near]
impl Vault {
    #[init]
    pub fn new(dao: AccountId, usdc: AccountId, fee_account: AccountId, window_ns: U64) -> Self {
        require!(window_ns.0 > 0, "ERR_BAD_WINDOW");
        Self {
            dao,
            usdc,
            fee_account,
            window_ns: window_ns.0,
            total_shares: 0,
            shares: IterableMap::new(Key::Shares),
            near_balance: 0,
            usdc_balance: 0,
            pending_usdc: LookupMap::new(Key::Pending),
            pending_total: 0,
            claim_near: LookupMap::new(Key::ClaimNear),
            claim_usdc: LookupMap::new(Key::ClaimUsdc),
            spends: Vector::new(Key::Spends),
            by_proposal: LookupMap::new(Key::ByProposal),
            queued_ids: Vec::new(),
            paid: LookupSet::new(Key::Paid),
            rules: LookupMap::new(Key::Rules),
            record: Vector::new(Key::Record),
            near_tally: Tally::default(),
            usdc_tally: Tally::default(),
        }
    }

    // ---------- joining ----------

    /// NEP-141 receiver. Step 1 of joining: USDC sent with msg "join" becomes a pending deposit.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, ERR_WRONG_TOKEN);
        if msg != "join" || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let prev = self.pending_usdc.get(&sender_id).copied().unwrap_or(0);
        self.pending_usdc.insert(sender_id.clone(), prev + amount.0);
        self.pending_total += amount.0;
        self.usdc_tally.deposited += amount.0;
        self.emit("pending_deposit", json!({ "account_id": sender_id, "usdc": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// Step 2 of joining: attach NEAR; the pending USDC and the NEAR are matched to the fund's ratio.
    #[payable]
    pub fn join(&mut self) -> U128 {
        require!(self.queued_ids.is_empty(), ERR_WINDOW_OPEN);
        let account = env::predecessor_account_id();
        let near_in = env::attached_deposit().as_yoctonear();
        let usdc_in = self.pending_usdc.get(&account).copied().unwrap_or(0);
        require!(near_in > 0 || usdc_in > 0, ERR_EMPTY_DEPOSIT);

        let (issued, near_used, usdc_used) =
            join_math(self.total_shares, self.near_balance, self.usdc_balance, near_in, usdc_in)
                .unwrap_or_else(|e| env::panic_str(e));

        self.pending_usdc.remove(&account);
        self.pending_total -= usdc_in;
        self.near_tally.deposited += near_in;
        self.near_balance += near_used;
        self.usdc_balance += usdc_used;
        self.total_shares += issued;
        let prev = self.shares.get(&account).copied().unwrap_or(0);
        self.shares.insert(account.clone(), prev + issued);

        let near_back = near_in - near_used;
        let usdc_back = usdc_in - usdc_used;
        if near_back > 0 {
            self.send(account.clone(), Token::Near, near_back, Some(Movement::Refund));
        }
        if usdc_back > 0 {
            self.send(account.clone(), Token::Usdc, usdc_back, Some(Movement::Refund));
        }
        self.emit(
            "join",
            json!({ "account_id": account, "shares": U128(issued), "near": U128(near_used), "usdc": U128(usdc_used) }),
        );
        U128(issued)
    }

    /// Refunds a pending USDC deposit that never completed its join.
    pub fn cancel_join(&mut self) {
        let account = env::predecessor_account_id();
        let amount = self.pending_usdc.remove(&account).unwrap_or(0);
        require!(amount > 0, ERR_NO_PENDING_DEPOSIT);
        self.pending_total -= amount;
        self.send(account.clone(), Token::Usdc, amount, Some(Movement::Refund));
        self.emit("cancel_join", json!({ "account_id": account, "usdc": U128(amount) }));
    }

    // ---------- spends ----------

    /// Called by the DAO when a FunctionCall proposal to this vault is approved.
    /// The vault reads the proposal back from the DAO and checks it byte for byte before queueing.
    pub fn queue_spend(
        &mut self,
        proposal_id: u64,
        recipient: AccountId,
        token_id: String,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.dao, ERR_NOT_DAO);
        require!(!self.by_proposal.contains_key(&proposal_id), ERR_ALREADY_QUEUED);
        require!(amount.0 > 0, ERR_ZERO_AMOUNT);
        let token = self.token_from_id(&token_id);
        let raw = env::input().unwrap_or_default();
        ext_dao::ext(self.dao.clone())
            .with_static_gas(GAS_VIEW)
            .get_proposal(proposal_id)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_proposal(
                Base64VecU8::from(raw),
                proposal_id,
                recipient,
                token,
                amount,
                memo.unwrap_or_default(),
            ))
    }

    #[private]
    pub fn on_proposal(
        &mut self,
        raw_args: Base64VecU8,
        proposal_id: u64,
        recipient: AccountId,
        token: Token,
        amount: U128,
        memo: String,
        #[callback_result] proposal: Result<Value, PromiseError>,
    ) -> u64 {
        let proposal = proposal.unwrap_or_else(|_| env::panic_str(ERR_PROPOSAL_MISMATCH));
        self.record_spend(&raw_args.0, &proposal, proposal_id, recipient, token, amount, memo)
            .unwrap_or_else(|e| env::panic_str(e))
    }

    /// Anyone, after the window: pays the recipient and the 0.1% fee.
    pub fn execute_spend(&mut self, spend_id: u64) {
        let mut spend = self.spend_or_panic(spend_id);
        match spend.status {
            SpendStatus::Executed => env::panic_str(ERR_ALREADY_EXECUTED),
            SpendStatus::Cancelled => env::panic_str(ERR_SPEND_CANCELLED),
            SpendStatus::Queued => {}
        }
        require!(env::block_timestamp() >= spend.window_ends.0, ERR_WINDOW_NOT_CLOSED);
        let fee = fee_for(spend.amount.0);
        require!(self.affordable(&spend), ERR_SPEND_UNAFFORDABLE);

        *self.balance_mut(spend.token) -= spend.amount.0 + fee;
        self.tally_mut(spend.token).spent += spend.amount.0;
        self.tally_mut(spend.token).fees += fee;
        spend.status = SpendStatus::Executed;
        self.spends.replace(spend_id as u32, spend.clone());
        self.queued_ids.retain(|id| *id != spend_id);
        self.paid.insert(spend.recipient.clone());

        self.send(spend.recipient.clone(), spend.token, spend.amount.0, None);
        if fee > 0 {
            self.send(self.fee_account.clone(), spend.token, fee, None);
        }
        self.emit(
            "execute_spend",
            json!({ "spend_id": spend_id, "recipient": spend.recipient, "token": spend.token, "amount": spend.amount, "fee": U128(fee) }),
        );
    }

    /// Anyone: cancels a queued spend the fund can no longer pay after exits.
    pub fn cancel_spend(&mut self, spend_id: u64) {
        let mut spend = self.spend_or_panic(spend_id);
        require!(spend.status == SpendStatus::Queued, ERR_ALREADY_EXECUTED);
        require!(!self.affordable(&spend), ERR_SPEND_AFFORDABLE);
        spend.status = SpendStatus::Cancelled;
        self.spends.replace(spend_id as u32, spend);
        self.queued_ids.retain(|id| *id != spend_id);
        self.emit("cancel_spend", json!({ "spend_id": spend_id, "by": env::predecessor_account_id() }));
    }

    // ---------- exits and claims ----------

    /// Pays the caller their share of every token and burns their shares.
    /// Takes no deposit, so a function-call key limited to this vault can sign it.
    pub fn exit(&mut self, reason_hash: Option<String>) {
        let account = env::predecessor_account_id();
        let owned = self.shares.get(&account).copied().unwrap_or(0);
        require!(owned > 0, ERR_NO_SHARES);
        require!(!self.approves_open_spend(&account), ERR_APPROVED_SPEND_PENDING);

        let near_out = pro_rata(self.near_balance, owned, self.total_shares);
        let usdc_out = pro_rata(self.usdc_balance, owned, self.total_shares);
        self.shares.remove(&account);
        self.total_shares -= owned;
        self.near_balance -= near_out;
        self.usdc_balance -= usdc_out;
        self.near_tally.exited += near_out;
        self.usdc_tally.exited += usdc_out;
        self.rules.remove(&account);

        if near_out > 0 {
            self.send(account.clone(), Token::Near, near_out, None);
        }
        if usdc_out > 0 {
            self.send(account.clone(), Token::Usdc, usdc_out, None);
        }
        self.emit(
            "exit",
            json!({ "account_id": account, "shares": U128(owned), "near": U128(near_out), "usdc": U128(usdc_out), "reason_hash": reason_hash }),
        );
    }

    /// Retries a transfer that failed earlier, for example because the account had no USDC storage.
    pub fn claim(&mut self, token: Token) {
        let account = env::predecessor_account_id();
        let map = match token {
            Token::Near => &mut self.claim_near,
            Token::Usdc => &mut self.claim_usdc,
        };
        let amount = map.remove(&account).unwrap_or(0);
        require!(amount > 0, ERR_NOTHING_TO_CLAIM);
        self.tally_mut(token).claimable -= amount;
        self.send(account.clone(), token, amount, None);
        self.emit("claim", json!({ "account_id": account, "token": token, "amount": U128(amount) }));
    }

    #[private]
    pub fn on_transfer(&mut self, account_id: AccountId, token: Token, amount: U128) {
        let ok = matches!(env::promise_result_checked(0, 64), Ok(_));
        self.settle_transfer(account_id, token, amount.0, ok);
    }

    /// Stores the caller's exit rules where their agent and anyone else can read them.
    pub fn set_rules(&mut self, rules: Rules) {
        let account = env::predecessor_account_id();
        require!(self.shares.get(&account).copied().unwrap_or(0) > 0, ERR_NO_SHARES);
        if let Some(bps) = rules.max_spend_share_bps {
            require!(bps > 0 && bps <= 10_000, ERR_BAD_RULES);
        }
        require!(rules.blocked_recipients.len() <= 50, ERR_BAD_RULES);
        self.rules.insert(account.clone(), rules.clone());
        self.emit("set_rules", json!({ "account_id": account, "rules": rules }));
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        Config {
            dao: self.dao.clone(),
            usdc: self.usdc.clone(),
            fee_account: self.fee_account.clone(),
            window_ns: U64(self.window_ns),
        }
    }

    pub fn get_balances(&self) -> Balances {
        Balances {
            near: U128(self.near_balance),
            usdc: U128(self.usdc_balance),
            total_shares: U128(self.total_shares),
            members: self.shares.len(),
            open_spends: self.queued_ids.len() as u32,
        }
    }

    pub fn get_shares(&self, account_id: AccountId) -> U128 {
        U128(self.shares.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_members(&self, from_index: u32, limit: u32) -> Vec<(AccountId, U128)> {
        self.shares
            .iter()
            .skip(from_index as usize)
            .take(limit.min(100) as usize)
            .map(|(a, s)| (a.clone(), U128(*s)))
            .collect()
    }

    pub fn get_pending(&self, account_id: AccountId) -> U128 {
        U128(self.pending_usdc.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_claimable(&self, account_id: AccountId) -> (U128, U128) {
        (
            U128(self.claim_near.get(&account_id).copied().unwrap_or(0)),
            U128(self.claim_usdc.get(&account_id).copied().unwrap_or(0)),
        )
    }

    pub fn get_spend(&self, spend_id: u64) -> Option<Spend> {
        self.spends.get(spend_id as u32).cloned()
    }

    pub fn get_spend_by_proposal(&self, proposal_id: u64) -> Option<Spend> {
        self.by_proposal.get(&proposal_id).and_then(|id| self.spends.get(*id as u32).cloned())
    }

    pub fn get_open_spends(&self) -> Vec<Spend> {
        self.queued_ids.iter().filter_map(|id| self.spends.get(*id as u32).cloned()).collect()
    }

    pub fn get_spends(&self, from_index: u32, limit: u32) -> Vec<Spend> {
        (from_index..self.spends.len().min(from_index.saturating_add(limit.min(100))))
            .filter_map(|i| self.spends.get(i).cloned())
            .collect()
    }

    pub fn get_rules(&self, account_id: AccountId) -> Option<Rules> {
        self.rules.get(&account_id).cloned()
    }

    pub fn was_paid(&self, account_id: AccountId) -> bool {
        self.paid.contains(&account_id)
    }

    pub fn get_record(&self, from_index: u32, limit: u32) -> Vec<String> {
        (from_index..self.record.len().min(from_index.saturating_add(limit.min(100))))
            .filter_map(|i| self.record.get(i).cloned())
            .collect()
    }

    pub fn get_record_len(&self) -> u32 {
        self.record.len()
    }

    pub fn get_ledger(&self, token: Token) -> Ledger {
        let t = self.tally(token);
        Ledger {
            balance: U128(self.balance(token)),
            in_flight: U128(t.in_flight),
            claimable: U128(t.claimable),
            pending_joins: U128(if token == Token::Usdc { self.pending_total } else { 0 }),
            deposited: U128(t.deposited),
            spent: U128(t.spent),
            fees: U128(t.fees),
            exited: U128(t.exited),
            refunded: U128(t.refunded),
        }
    }
}

/// Where a transfer's money is counted if it bounces back into claimable.
#[derive(Clone, Copy)]
enum Movement {
    Refund,
}

impl Vault {
    fn token_from_id(&self, token_id: &str) -> Token {
        if token_id == "near" {
            Token::Near
        } else if token_id == self.usdc.as_str() {
            Token::Usdc
        } else {
            env::panic_str(ERR_WRONG_TOKEN)
        }
    }

    fn balance(&self, token: Token) -> u128 {
        match token {
            Token::Near => self.near_balance,
            Token::Usdc => self.usdc_balance,
        }
    }

    fn balance_mut(&mut self, token: Token) -> &mut u128 {
        match token {
            Token::Near => &mut self.near_balance,
            Token::Usdc => &mut self.usdc_balance,
        }
    }

    fn tally(&self, token: Token) -> &Tally {
        match token {
            Token::Near => &self.near_tally,
            Token::Usdc => &self.usdc_tally,
        }
    }

    fn tally_mut(&mut self, token: Token) -> &mut Tally {
        match token {
            Token::Near => &mut self.near_tally,
            Token::Usdc => &mut self.usdc_tally,
        }
    }

    fn spend_or_panic(&self, spend_id: u64) -> Spend {
        self.spends
            .get(spend_id as u32)
            .cloned()
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_SPEND))
    }

    fn affordable(&self, spend: &Spend) -> bool {
        spend.amount.0 + fee_for(spend.amount.0) <= self.balance(spend.token)
    }

    fn approves_open_spend(&self, account: &AccountId) -> bool {
        self.queued_ids.iter().any(|id| {
            self.spends
                .get(*id as u32)
                .map(|s| s.approvers.contains(account))
                .unwrap_or(false)
        })
    }

    /// Checks the DAO's own record of the proposal, then queues the spend and opens its window.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_spend(
        &mut self,
        raw_args: &[u8],
        proposal: &Value,
        proposal_id: u64,
        recipient: AccountId,
        token: Token,
        amount: U128,
        memo: String,
    ) -> Result<u64, &'static str> {
        if self.by_proposal.contains_key(&proposal_id) {
            return Err(ERR_ALREADY_QUEUED);
        }
        let check = check_proposal(proposal, &env::current_account_id(), "queue_spend", raw_args)?;
        let now = env::block_timestamp();
        let id = self.spends.len() as u64;
        let spend = Spend {
            id,
            proposal_id,
            recipient,
            token,
            amount,
            memo,
            approvers: check.approvers,
            objectors: check.objectors,
            queued_at: U64(now),
            window_ends: U64(now + self.window_ns),
            status: SpendStatus::Queued,
        };
        self.spends.push(spend.clone());
        self.by_proposal.insert(proposal_id, id);
        self.queued_ids.push(id);
        self.emit(
            "queue_spend",
            json!({
                "spend_id": id, "proposal_id": proposal_id, "recipient": spend.recipient, "token": token,
                "amount": amount, "approve": spend.approvers.len(), "not_approve": spend.objectors.len(),
                "window_ends": spend.window_ends
            }),
        );
        Ok(id)
    }

    /// Starts a transfer out of the vault. The amount is already off the books; it is counted as in flight
    /// until the callback confirms it, and moved to claimable if it bounces.
    fn send(&mut self, to: AccountId, token: Token, amount: u128, movement: Option<Movement>) {
        if let Some(Movement::Refund) = movement {
            self.tally_mut(token).refunded += amount;
        }
        self.tally_mut(token).in_flight += amount;
        let callback = ext_self::ext(env::current_account_id())
            .with_static_gas(GAS_CALLBACK)
            .on_transfer(to.clone(), token, U128(amount));
        match token {
            Token::Near => {
                Promise::new(to).transfer(NearToken::from_yoctonear(amount)).then(callback).detach();
            }
            Token::Usdc => {
                ext_ft::ext(self.usdc.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(to, U128(amount), None)
                    .then(callback)
                    .detach();
            }
        }
    }

    pub(crate) fn settle_transfer(&mut self, account: AccountId, token: Token, amount: u128, ok: bool) {
        self.tally_mut(token).in_flight -= amount;
        if ok {
            return;
        }
        self.tally_mut(token).claimable += amount;
        let map = match token {
            Token::Near => &mut self.claim_near,
            Token::Usdc => &mut self.claim_usdc,
        };
        let prev = map.get(&account).copied().unwrap_or(0);
        map.insert(account.clone(), prev + amount);
        self.emit("claimable", json!({ "account_id": account, "token": token, "amount": U128(amount) }));
    }

    fn emit(&mut self, event: &str, data: Value) {
        let line = json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
            "event": event,
            "data": [data],
            "block": U64(env::block_height()),
            "ts": U64(env::block_timestamp()),
        });
        let text = serde_json::to_string(&line).unwrap_or_default();
        env::log_str(&format!("EVENT_JSON:{text}"));
        self.record.push(text);
    }
}

/// Fee on a spend, rounded down.
pub fn fee_for(amount: u128) -> u128 {
    amount * FEE_BPS / 10_000
}

/// A holder's share of a balance, rounded down so the vault never pays out more than it holds.
pub fn pro_rata(balance: u128, owned: u128, total: u128) -> u128 {
    if total == 0 {
        return 0;
    }
    mul_div_floor(balance, owned, total)
}

uint::construct_uint! {
    /// 256-bit integer for share maths: NEAR amounts (10^24 per NEAR) times share counts overflow u128.
    pub struct U256(4);
}

fn mul_div_floor(a: u128, b: u128, c: u128) -> u128 {
    let q = U256::from(a) * U256::from(b) / U256::from(c);
    q.try_into().expect("ERR_OVERFLOW")
}

fn mul_div_ceil(a: u128, b: u128, c: u128) -> u128 {
    let p = U256::from(a) * U256::from(b);
    let c = U256::from(c);
    let q = (p + c - U256::one()) / c;
    q.try_into().expect("ERR_OVERFLOW")
}

/// Shares issued for a deposit and how much of each token is kept; the rest is refunded.
/// The first deposit sets the ratio. Later deposits are matched to the fund's current ratio,
/// and the amounts kept are rounded up so the vault never issues more than it receives.
pub fn join_math(
    total_shares: u128,
    near_bal: u128,
    usdc_bal: u128,
    near_in: u128,
    usdc_in: u128,
) -> Result<(u128, u128, u128), &'static str> {
    if total_shares == 0 {
        if near_in == 0 || usdc_in == 0 {
            return Err(ERR_EMPTY_DEPOSIT);
        }
        return Ok((near_in, near_in, usdc_in));
    }
    let by_near = if near_bal > 0 { Some(mul_div_floor(near_in, total_shares, near_bal)) } else { None };
    let by_usdc = if usdc_bal > 0 { Some(mul_div_floor(usdc_in, total_shares, usdc_bal)) } else { None };
    let issued = match (by_near, by_usdc) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return Err(ERR_EMPTY_FUND),
    };
    if issued == 0 {
        return Err(ERR_EMPTY_DEPOSIT);
    }
    let near_used = mul_div_ceil(issued, near_bal, total_shares).min(near_in);
    let usdc_used = mul_div_ceil(issued, usdc_bal, total_shares).min(usdc_in);
    Ok((issued, near_used, usdc_used))
}

#[cfg(test)]
mod tests;
