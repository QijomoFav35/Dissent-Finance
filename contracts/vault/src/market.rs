//! The share market: a member who wants to leave without taking money out of the fund offers
//! shares in a timed auction, and other members' agents bid for them. When the auction ends the
//! shares move to the highest bidder and the bid goes to the seller. The fund's balances never
//! change, so open spends stay exactly as payable as they were.
//!
//! Bids are paid from bid funds a member deposited earlier (`ft_transfer_call` with msg
//! "bid_funds"), so an agent key that cannot attach a deposit can still bid. Bid funds belong to
//! the member, sit outside the fund, and are counted on their own.
//!
//! No shares change hands while a spend is open: offers cannot be made while one is open, and an
//! offer during which a spend was queued ends unsold, its best bid returned. Otherwise a member who
//! approved a spend could sell their shares to one who did not, and the buyer could leave with them
//! without the approver's part being held back; and a seller could collect bids and then queue a
//! spend the buyer never priced.
//!
//! Everything here lives under its own storage keys, so the vault's state layout is unchanged.

use crate::*;

pub const ERR_NOT_HOLDER: &str = "ERR_NOT_HOLDER";
pub const ERR_OFFER_OPEN: &str = "ERR_OFFER_OPEN";
pub const ERR_TOO_MANY_OFFERS: &str = "ERR_TOO_MANY_OFFERS";
pub const ERR_UNKNOWN_OFFER: &str = "ERR_UNKNOWN_OFFER";
pub const ERR_OFFER_CLOSED: &str = "ERR_OFFER_CLOSED";
pub const ERR_AUCTION_RUNNING: &str = "ERR_AUCTION_RUNNING";
pub const ERR_BID_TOO_LOW: &str = "ERR_BID_TOO_LOW";
pub const ERR_OWN_OFFER: &str = "ERR_OWN_OFFER";
pub const ERR_NO_BID_FUNDS: &str = "ERR_NO_BID_FUNDS";
pub const ERR_HAS_BIDS: &str = "ERR_HAS_BIDS";
pub const ERR_NOT_SELLER: &str = "ERR_NOT_SELLER";
pub const ERR_BAD_OFFER: &str = "ERR_BAD_OFFER";

/// At most this many offers can be open at once, so agents can always read them all.
pub const MAX_OPEN_OFFERS: usize = 8;
/// The smallest deposit of bid funds, so storage cannot be filled with dust.
pub const MIN_BID_FUNDS: u128 = 10_000; // 0.01 USDC
/// A new bid must beat the best one by at least this many basis points (and at least 1 unit).
pub const MIN_RAISE_BPS: u128 = 100; // 1%

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum OfferStatus {
    Open,
    Sold,
    Lapsed,
    Withdrawn,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Offer {
    pub id: u64,
    pub seller: AccountId,
    pub shares: U128,
    /// The lowest bid, in USDC units, the seller accepts.
    pub reserve: U128,
    pub ends_at: U64,
    pub best_bidder: Option<AccountId>,
    pub best_bid: U128,
    pub bids: u32,
    pub status: OfferStatus,
}

fn key_offer(id: u64) -> Vec<u8> {
    [b"offer:".as_slice(), &id.to_le_bytes()].concat()
}
fn key_funds(account: &AccountId) -> Vec<u8> {
    [b"bidfunds:".as_slice(), account.as_bytes()].concat()
}
const KEY_NEXT_OFFER: &[u8] = b"offer:next";
const KEY_OPEN_OFFERS: &[u8] = b"offer:open";
const KEY_FUNDS_TOTAL: &[u8] = b"bidfunds:total";
const KEY_FUNDS_IN: &[u8] = b"bidfunds:in";

fn read_u128(key: &[u8]) -> u128 {
    env::storage_read(key).map(|b| u128::from_le_bytes(b.try_into().unwrap_or([0; 16]))).unwrap_or(0)
}
fn write_u128(key: &[u8], v: u128) {
    if v == 0 {
        env::storage_remove(key);
    } else {
        env::storage_write(key, &v.to_le_bytes());
    }
}

#[near]
impl Vault {
    // ---------- bid funds ----------

    /// Takes bid funds back out. Locked funds (the caller's best bids) are not part of them.
    pub fn withdraw_bid_funds(&mut self, amount: U128) {
        let account = env::predecessor_account_id();
        let have = self.bid_funds_of(&account);
        require!(amount.0 > 0 && amount.0 <= have, ERR_NO_BID_FUNDS);
        self.set_bid_funds(&account, have - amount.0);
        self.add_funds_total(-(amount.0 as i128));
        self.send(account.clone(), Token::Usdc, amount.0, None);
        self.log_only("bid_funds_out", json!({ "account_id": account, "usdc": amount }));
    }

    // ---------- offers ----------

    /// A member offers `shares` of their own for at least `reserve` USDC units. The auction runs for
    /// the vault's window. One open offer per member.
    pub fn offer_shares(&mut self, shares: U128, reserve: U128) -> u64 {
        let seller = env::predecessor_account_id();
        let owned = self.shares.get(&seller).copied().unwrap_or(0);
        require!(owned > 0, ERR_NOT_HOLDER);
        require!(self.queued_ids.is_empty(), ERR_WINDOW_OPEN);
        require!(shares.0 > 0 && shares.0 <= owned && reserve.0 > 0, ERR_BAD_OFFER);
        let open = self.open_offer_ids();
        require!(open.len() < MAX_OPEN_OFFERS, ERR_TOO_MANY_OFFERS);
        require!(!open.iter().any(|id| self.offer(*id).map(|o| o.seller == seller).unwrap_or(false)), ERR_OFFER_OPEN);
        let id = read_u128(KEY_NEXT_OFFER) as u64;
        write_u128(KEY_NEXT_OFFER, id as u128 + 1);
        let offer = Offer {
            id,
            seller: seller.clone(),
            shares,
            reserve,
            ends_at: U64(env::block_timestamp() + self.window_ns),
            best_bidder: None,
            best_bid: U128(0),
            bids: 0,
            status: OfferStatus::Open,
        };
        self.put_offer(&offer);
        let mut open = open;
        open.push(id);
        self.set_open_offer_ids(&open);
        // Log only: an offer can be withdrawn at once, so storing it in the record would let one member
        // grow the record in a loop. Sales are stored.
        self.log_only("offer", json!({ "offer_id": id, "seller": seller, "shares": shares, "reserve": reserve, "ends_at": offer.ends_at }));
        require!(self.storage_ok(0), ERR_STORAGE);
        id
    }

    /// A member bids `amount` USDC units from their bid funds. It must reach the reserve and beat the
    /// best bid by at least 1%. The bid is locked; the one it beats goes back to its bidder's funds.
    pub fn bid(&mut self, offer_id: u64, amount: U128) {
        let bidder = env::predecessor_account_id();
        require!(self.shares.get(&bidder).copied().unwrap_or(0) > 0, ERR_NOT_HOLDER);
        let mut offer = self.offer(offer_id).unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_OFFER));
        require!(offer.status == OfferStatus::Open, ERR_OFFER_CLOSED);
        require!(env::block_timestamp() < offer.ends_at.0, ERR_OFFER_CLOSED);
        require!(offer.seller != bidder, ERR_OWN_OFFER);
        let min = if offer.bids == 0 {
            offer.reserve.0
        } else {
            offer.best_bid.0 + (offer.best_bid.0 * MIN_RAISE_BPS / 10_000).max(1)
        };
        require!(amount.0 >= min, ERR_BID_TOO_LOW);
        // A bidder raising their own bid only adds the difference.
        let refund_prev = offer.best_bidder.clone().map(|b| (b, offer.best_bid.0));
        let mut have = self.bid_funds_of(&bidder);
        if let Some((prev, prev_amount)) = &refund_prev {
            if *prev == bidder {
                have += prev_amount;
            }
        }
        require!(have >= amount.0, ERR_NO_BID_FUNDS);
        if let Some((prev, prev_amount)) = refund_prev {
            if prev != bidder {
                let p = self.bid_funds_of(&prev);
                self.set_bid_funds(&prev, p + prev_amount);
            }
        }
        self.set_bid_funds(&bidder, have - amount.0);
        offer.best_bidder = Some(bidder.clone());
        offer.best_bid = amount;
        offer.bids += 1;
        self.put_offer(&offer);
        self.log_only("bid", json!({ "offer_id": offer_id, "bidder": bidder, "usdc": amount }));
    }

    /// Anyone, once the auction has ended and no spend is open: the shares go to the best bidder and
    /// the bid to the seller, or, with no bids, the offer lapses.
    pub fn settle_offer(&mut self, offer_id: u64) {
        let mut offer = self.offer(offer_id).unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_OFFER));
        require!(offer.status == OfferStatus::Open, ERR_OFFER_CLOSED);
        require!(env::block_timestamp() >= offer.ends_at.0, ERR_AUCTION_RUNNING);
        // Bids priced a fund with no spend pending. If a spend was queued after the offer was made,
        // the shares are not worth what was bid: the offer ends unsold and the best bid goes back.
        let made_at = offer.ends_at.0.saturating_sub(self.window_ns);
        let last_queued = self.spends.len().checked_sub(1).and_then(|i| self.spends.get(i)).map(|sp| sp.queued_at.0);
        if last_queued.map(|t| t >= made_at).unwrap_or(false) {
            self.close_offer(&mut offer, false);
            return;
        }
        require!(self.queued_ids.is_empty(), ERR_WINDOW_OPEN);
        self.close_offer(&mut offer, true);
    }

    /// The seller takes an offer back before anyone has bid.
    pub fn withdraw_offer(&mut self, offer_id: u64) {
        let mut offer = self.offer(offer_id).unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_OFFER));
        require!(offer.seller == env::predecessor_account_id(), ERR_NOT_SELLER);
        require!(offer.status == OfferStatus::Open, ERR_OFFER_CLOSED);
        require!(offer.bids == 0, ERR_HAS_BIDS);
        self.close_offer(&mut offer, false);
    }

    // ---------- views ----------

    pub fn get_offer(&self, offer_id: u64) -> Option<Offer> {
        self.offer(offer_id)
    }

    /// How many offers were ever made (the next offer's id). Unsold offers are removed, so pages of
    /// `get_offers` can be short before the end.
    pub fn get_offer_count(&self) -> u64 {
        read_u128(KEY_NEXT_OFFER) as u64
    }

    pub fn get_open_offers(&self) -> Vec<Offer> {
        self.open_offer_ids().into_iter().filter_map(|id| self.offer(id)).collect()
    }

    pub fn get_offers(&self, from_index: u64, limit: u64) -> Vec<Offer> {
        let next = read_u128(KEY_NEXT_OFFER) as u64;
        (from_index..next.min(from_index.saturating_add(limit.min(100)))).filter_map(|id| self.offer(id)).collect()
    }

    pub fn get_bid_funds(&self, account_id: AccountId) -> U128 {
        U128(self.bid_funds_of(&account_id))
    }

    /// Bid funds held for members, free and locked in best bids, and everything ever deposited.
    pub fn get_bid_funds_totals(&self) -> (U128, U128) {
        (U128(read_u128(KEY_FUNDS_TOTAL)), U128(read_u128(KEY_FUNDS_IN)))
    }
}

impl Vault {
    pub(crate) fn offer(&self, id: u64) -> Option<Offer> {
        env::storage_read(&key_offer(id)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
    }

    fn put_offer(&mut self, offer: &Offer) {
        env::storage_write(&key_offer(offer.id), &near_sdk::borsh::to_vec(offer).unwrap_or_default());
    }

    pub(crate) fn open_offer_ids(&self) -> Vec<u64> {
        env::storage_read(KEY_OPEN_OFFERS).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
    }

    fn set_open_offer_ids(&mut self, ids: &[u64]) {
        if ids.is_empty() {
            env::storage_remove(KEY_OPEN_OFFERS);
        } else {
            env::storage_write(KEY_OPEN_OFFERS, &near_sdk::borsh::to_vec(ids).unwrap_or_default());
        }
    }

    pub(crate) fn bid_funds_of(&self, account: &AccountId) -> u128 {
        read_u128(&key_funds(account))
    }

    /// Sets an account's free bid funds. Moving money between free funds and a locked bid does not
    /// change the total of all bid funds; only money coming in or going out does (`add_funds_total`).
    fn set_bid_funds(&mut self, account: &AccountId, amount: u128) {
        write_u128(&key_funds(account), amount);
    }

    fn add_funds_total(&mut self, delta: i128) {
        let total = read_u128(KEY_FUNDS_TOTAL) as i128 + delta;
        require!(total >= 0, "ERR_BID_FUNDS_BOOKS");
        write_u128(KEY_FUNDS_TOTAL, total as u128);
    }

    /// Called from `ft_on_transfer` for msg "bid_funds". Returns what to send back.
    pub(crate) fn deposit_bid_funds(&mut self, sender: AccountId, amount: u128) -> u128 {
        if amount < MIN_BID_FUNDS || self.shares.get(&sender).copied().unwrap_or(0) == 0 {
            return amount;
        }
        let have = self.bid_funds_of(&sender);
        self.set_bid_funds(&sender, have + amount);
        self.add_funds_total(amount as i128);
        write_u128(KEY_FUNDS_IN, read_u128(KEY_FUNDS_IN) + amount);
        self.log_only("bid_funds_in", json!({ "account_id": sender, "usdc": U128(amount) }));
        require!(self.storage_ok(0), ERR_STORAGE);
        0
    }

    /// Ends an offer: with `sell` and a best bid it sells, otherwise the best bid goes back to its
    /// bidder's funds. Removes it from the open list.
    fn close_offer(&mut self, offer: &mut Offer, sell: bool) {
        let open: Vec<u64> = self.open_offer_ids().into_iter().filter(|id| *id != offer.id).collect();
        self.set_open_offer_ids(&open);
        let best = offer.best_bidder.clone();
        let held = self.shares.get(&offer.seller).copied().unwrap_or(0);
        match best {
            Some(buyer) if sell && held >= offer.shares.0 => {
                // The locked bid leaves bid funds and goes to the seller.
                self.add_funds_total(-(offer.best_bid.0 as i128));
                let left = held - offer.shares.0;
                if left == 0 {
                    self.shares.remove(&offer.seller);
                    self.rules.remove(&offer.seller);
                } else {
                    self.shares.insert(offer.seller.clone(), left);
                }
                let b = self.shares.get(&buyer).copied().unwrap_or(0);
                self.shares.insert(buyer.clone(), b + offer.shares.0);
                offer.status = OfferStatus::Sold;
                self.put_offer(offer);
                self.send(offer.seller.clone(), Token::Usdc, offer.best_bid.0, None);
                self.emit(
                    "share_sale",
                    json!({ "offer_id": offer.id, "seller": offer.seller, "buyer": buyer, "shares": offer.shares, "usdc": offer.best_bid, "bids": offer.bids }),
                );
            }
            _ => {
                if let Some(bidder) = best {
                    let p = self.bid_funds_of(&bidder);
                    self.set_bid_funds(&bidder, p + offer.best_bid.0);
                }
                offer.status = if sell { OfferStatus::Lapsed } else { OfferStatus::Withdrawn };
                // Only sales are kept; an offer that ends unsold is removed so offers can't fill storage.
                env::storage_remove(&key_offer(offer.id));
                self.log_only("offer_closed", json!({ "offer_id": offer.id, "status": offer.status }));
            }
        }
    }

    /// Before an exit: withdraws the leaver's open offer (refunding its best bid) and drops the
    /// leaver's own best bids on other offers back into their bid funds. Returns the leaver's free
    /// bid funds, which the exit sends back with the rest.
    pub(crate) fn market_on_exit(&mut self, account: &AccountId) -> u128 {
        for id in self.open_offer_ids() {
            let Some(mut offer) = self.offer(id) else { continue };
            if offer.seller == *account {
                self.close_offer(&mut offer, false);
            } else if offer.best_bidder.as_ref() == Some(account) {
                // The leaver's bid is withdrawn; the auction carries on with no best bid.
                let p = self.bid_funds_of(account);
                self.set_bid_funds(account, p + offer.best_bid.0);
                offer.best_bidder = None;
                offer.best_bid = U128(0);
                offer.bids = 0;
                self.put_offer(&offer);
            }
        }
        let funds = self.bid_funds_of(account);
        self.set_bid_funds(account, 0);
        self.add_funds_total(-(funds as i128));
        funds
    }
}
