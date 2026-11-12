// Shared helpers for the mainnet scripts. Keys live in ~/.near-credentials only; nothing here prints them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";
import { Rpc } from "../src/rpc.js";

export const ROOT = process.env.DISSENT_ROOT || "dissentfinance.near";
export const RPCS = (process.env.DISSENT_RPC || "https://free.rpc.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org,https://rpc.intea.rs").split(",");
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // native USDC on NEAR
export const FACTORY = "sputnik-dao.near";
export const DAO_NAME = process.env.DISSENT_DAO_NAME || "dissentfinance";
export const DAO = `${DAO_NAME}.${FACTORY}`;
// v1 ("vault") ran the first live story and is keyless with known limits; v2 ("vault2") has the fixes.
export const VAULT_NAME = process.env.DISSENT_VAULT || "vault2";
export const VAULT = `${VAULT_NAME}.${ROOT}`;
export const MEMBERS = ["alice", "ben", "cara", "dan", "emma"];
export const member = (m) => `${m}.${ROOT}`;

export const NEAR = 10n ** 24n;
export const milli = (n) => BigInt(n) * 10n ** 21n; // thousandths of a NEAR
export const USDC_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, the token's storage_deposit
export const PROPOSAL_BOND = milli(10); // 0.01 NEAR, returned when the proposal passes

const CRED = path.join(os.homedir(), ".near-credentials");
// Agent keys are bound to one vault, so each vault has its own folder (v1 kept the original path).
export const AGENT_KEYS = VAULT_NAME === "vault" ? path.join(CRED, "dissent-agents") : path.join(CRED, "dissent-agents", VAULT_NAME);
export const rpc = new Rpc(RPCS, { tries: 10, timeoutMs: 20_000 });
// Transactions go through every endpoint in turn: if one fails or rate-limits, the same signed
// transaction goes to the next, so a fallback can never pay twice.
export const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));

export const log = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
export const near = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);
export const usdc = (u) => (Number(u) / 1e6).toFixed(6);

/** The full-access key file near-cli wrote, or the one this script wrote for a sub-account. */
export function keyFile(accountId) {
  return path.join(CRED, "mainnet", `${accountId}.json`);
}

export function signerFor(accountId) {
  const file = keyFile(accountId);
  if (!fs.existsSync(file)) throw new Error(`no key file for ${accountId} at ${file}`);
  const { private_key, secret_key } = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Account(accountId, provider, private_key || secret_key);
}

/** Writes a new full-access key for a sub-account in the same format near-cli uses. Never overwrites. */
export function newKeyFile(accountId) {
  const file = keyFile(accountId);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).public_key;
  const kp = KeyPair.fromRandom("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return kp.getPublicKey().toString();
}

export async function exists(accountId) {
  try {
    await rpc.query({ request_type: "view_account", account_id: accountId });
    return true;
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(e?.message ?? e))) return false;
    throw e;
  }
}

export async function balance(accountId) {
  const a = await rpc.query({ request_type: "view_account", account_id: accountId });
  return { amount: BigInt(a.amount), storage: Number(a.storage_usage), code: a.code_hash, global: a.global_contract_hash || a.global_contract_account_id || null };
}

export const view = (contract, method, args = {}) => rpc.view(contract, method, args);

/** Sends a function call and throws with the contract's error if it fails. Returns the transaction hash. */
export async function call(account, contractId, methodName, args, { deposit = 0n, tgas = 100 } = {}) {
  if (methodName === "__transfer__") {
    const out = await account.transfer({ receiverId: contractId, amount: deposit });
    return out?.transaction?.hash;
  }
  const out = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas: teraToGas(tgas) });
  const status = out?.status;
  if (status && typeof status === "object" && "Failure" in status) {
    throw new Error(`${account.accountId} -> ${contractId}.${methodName} failed: ${JSON.stringify(status.Failure).slice(0, 400)}`);
  }
  return out?.transaction?.hash ?? out?.transaction_outcome?.id;
}

export const explorer = (hash) => `https://nearblocks.io/txns/${hash}`;

/** Appends one line to evidence.jsonl next to the scripts, for the README's mainnet section. */
export function record(step, data) {
  const file = new URL("./evidence.jsonl", import.meta.url);
  // Every line names the vault it belongs to, so v1's and v2's evidence never mix.
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), step, vault: VAULT, ...data }) + "\n");
}

export function policy() {
  return {
    roles: [{ name: "council", kind: { Group: MEMBERS.map(member) }, permissions: ["*:*"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" },
    proposal_bond: PROPOSAL_BOND.toString(),
    proposal_period: "604800000000000",
    bounty_bond: PROPOSAL_BOND.toString(),
    bounty_forgiveness_period: "86400000000000",
  };
}

/** The rules from the README story. Ben and Cara will approve, so theirs never come into play. */
export function rulesFor(m) {
  switch (m) {
    case "alice":
      return { max_spend_share_bps: 2000, new_recipient: false, blocked_recipients: [] };
    case "dan":
      return { max_spend_share_bps: null, new_recipient: true, blocked_recipients: [] };
    case "emma":
      return { max_spend_share_bps: null, new_recipient: false, blocked_recipients: [member("ben")] };
    default:
      return { max_spend_share_bps: 1000, new_recipient: false, blocked_recipients: [] };
  }
}
