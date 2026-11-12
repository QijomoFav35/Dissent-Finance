#!/usr/bin/env node
// Builds the live group on mainnet, step by step. Safe to run again: every step checks first.
//
//   node mainnet/setup.mjs            # shows the plan and the balances it needs, sends nothing
//   node mainnet/setup.mjs --go       # does it
//
// Needs ~/.near-credentials/mainnet/dissentfinance.near.json (near-cli wrote it) and the vault built
// at contracts/vault/target/near/vault.wasm. New keys for the sub-accounts are written next to it.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { actions, baseEncode, KeyPair, teraToGas } from "near-api-js";
import crypto from "node:crypto";
import {
  ROOT, USDC, FACTORY, DAO_NAME, DAO, VAULT, VAULT_NAME, MEMBERS, member, NEAR, milli, USDC_STORAGE, AGENT_KEYS,
  log, near, usdc, signerFor, newKeyFile, exists, balance, view, call, record, explorer, policy, rulesFor, rpc,
} from "./lib.mjs";
const rpcQuery = (p) => rpc.query(p);

const GO = process.argv.includes("--go");
const WASM = path.resolve(new URL("../../contracts/vault/target/near/vault.wasm", import.meta.url).pathname);
const WINDOW_SEC = Number(process.env.DISSENT_WINDOW_SEC || 600);

const FUND_MEMBER = milli(180); // join deposit 0.1, gas, the proposal bond
const JOIN_NEAR = milli(100);
const MEMBER_FREE_BEFORE_JOIN = milli(250); // 0.1 join deposit + 0.1 held for its gas; after it, 0.14 left for a vote (0.12 held) or an exit (0.08 held)
const DAO_DEPOSIT = milli(100);
const PER_MEMBER_USDC = 200_000n; // 0.2 USDC each; members who already hold it use their own
const STORAGE_PER_BYTE = 10n ** 19n;

async function main() {
  // ---------- preflight ----------
  if (!fs.existsSync(WASM)) throw new Error(`build the vault first: missing ${WASM}`);
  const code = fs.readFileSync(WASM);
  // Only a build whose hash you name gets deployed: run `cargo near build reproducible-wasm` on a
  // pushed commit and pass the bs58 checksum it prints.
  const codeHash = baseEncode(crypto.createHash("sha256").update(code).digest());
  const expected = process.argv.includes("--code-hash") ? process.argv[process.argv.indexOf("--code-hash") + 1] : null;
  if (expected !== codeHash) throw new Error(`the wasm at ${WASM} hashes to ${codeHash}; pass --code-hash ${codeHash} if that is the reproducible build you mean to deploy`);
  const vaultFund = BigInt(code.length) * STORAGE_PER_BYTE + milli(250); // code storage, the reserve for exits, and room for its state
  const root = signerFor(ROOT);
  const rootBal = await balance(ROOT);
  const rootUsdc = BigInt(await view(USDC, "ft_balance_of", { account_id: ROOT }));

  const plan = [];
  for (const m of MEMBERS) if (!(await exists(member(m)))) plan.push([`create ${member(m)}`, FUND_MEMBER]);
  if (!(await exists(VAULT))) plan.push([`create ${VAULT} (code is ${code.length} bytes)`, vaultFund]);
  else {
    // The vault exists but has no code yet (an earlier run stopped): top it up if it needs more for this code.
    const vs = await balance(VAULT);
    const want = BigInt(code.length) * STORAGE_PER_BYTE + milli(250);
    if (/^1{32}$/.test(vs.code) && vs.amount < want) plan.push([`top up ${VAULT} for its code`, want - vs.amount]);
  }
  if (!(await exists(DAO))) plan.push([`create ${DAO} through ${FACTORY}`, DAO_DEPOSIT]);
  let topUps = 0n;
  for (const m of MEMBERS) {
    if (!(await exists(member(m)))) { topUps += MEMBER_FREE_BEFORE_JOIN - FUND_MEMBER + milli(5); continue; }
    if (await exists(VAULT) && !/^1{32}$/.test((await balance(VAULT)).code) && BigInt(await view(VAULT, "get_shares", { account_id: member(m) })) > 0n) continue;
    const st = await balance(member(m));
    const free = st.amount - BigInt(st.storage) * STORAGE_PER_BYTE;
    if (free < MEMBER_FREE_BEFORE_JOIN) topUps += MEMBER_FREE_BEFORE_JOIN - free;
  }
  if (topUps) plan.push(["top up members so each can join and still pay for an exit", topUps]);
  const needNear = plan.reduce((s, [, a]) => s + a, 0n) + 8n * USDC_STORAGE + milli(30);
  // The DAO call also holds back 0.2 NEAR of gas until it finishes, so that much must be free at that moment.
  const peak = (await exists(DAO)) ? 0n : DAO_DEPOSIT + milli(210);
  const alreadyIn = await alreadyJoined();
  const perMember = PER_MEMBER_USDC;
  let usdcShortfall = 0n;
  if (!alreadyIn) {
    for (const m of MEMBERS) {
      const id = member(m);
      const have = (await exists(id)) ? BigInt(await view(USDC, "ft_balance_of", { account_id: id })) : 0n;
      const joined = (await exists(VAULT)) && !/^1{32}$/.test((await balance(VAULT)).code) && BigInt(await view(VAULT, "get_shares", { account_id: id })) > 0n;
      if (!joined && have < perMember) usdcShortfall += perMember - have;
    }
  }

  log(`${ROOT}: ${near(rootBal.amount)} NEAR, ${usdc(rootUsdc)} USDC`);
  for (const [what, amount] of plan) log(`  will ${what}: ${near(amount)} NEAR`);
  log(`  needs about ${near(needNear)} NEAR in total, plus gas`);
  if (!alreadyIn) log(`  each member joins with ${usdc(perMember)} USDC and ${near(JOIN_NEAR)} NEAR; ${ROOT} covers ${usdc(usdcShortfall)} USDC they are missing`);
  log(`  spend window: ${WINDOW_SEC} seconds`);
  log(`  code to deploy: ${codeHash} (${code.length} bytes)`);
  if (rootBal.amount < peak) throw new Error(`not enough NEAR on ${ROOT} for the DAO call: has ${near(rootBal.amount)}, needs ${near(peak)} free while it runs`);
  if (rootBal.amount < needNear) throw new Error(`not enough NEAR on ${ROOT}: has ${near(rootBal.amount)}, needs about ${near(needNear)}`);
  if (!alreadyIn && rootUsdc < usdcShortfall) throw new Error(`not enough USDC on ${ROOT}: has ${usdc(rootUsdc)}, members are short ${usdc(usdcShortfall)}`);
  if (!GO) {
    log("dry run: nothing sent. Run again with --go to do it.");
    return;
  }

  // ---------- accounts ----------
  for (const name of [...MEMBERS, VAULT_NAME]) {
    const id = name === VAULT_NAME ? VAULT : member(name);
    if (await exists(id)) continue;
    const publicKey = newKeyFile(id);
    const out = await root.createSubAccount({ accountOrPrefix: name, publicKey, nearToTransfer: name === VAULT_NAME ? vaultFund : FUND_MEMBER });
    const hash = out?.transaction?.hash;
    log(`created ${id} ${explorer(hash)}`);
    record("create_account", { account: id, tx: hash });
  }

  // ---------- the DAO, through the official factory ----------
  if (!(await exists(DAO))) {
    const args = Buffer.from(JSON.stringify({ config: { name: DAO_NAME, purpose: "Dissent Finance demo group", metadata: "" }, policy: policy() })).toString("base64");
    const hash = await call(root, FACTORY, "create", { name: DAO_NAME, args }, { deposit: DAO_DEPOSIT, tgas: 200 });
    log(`created ${DAO} ${explorer(hash)}`);
    record("create_dao", { dao: DAO, tx: hash });
  }
  const daoPolicy = await view(DAO, "get_policy");
  const council = daoPolicy.roles.find((r) => r.kind?.Group)?.kind.Group ?? [];
  if (!MEMBERS.every((m) => council.includes(member(m)))) throw new Error(`${DAO} council is not the five members: ${JSON.stringify(council)}`);

  // ---------- the vault ----------
  let vaultState = await balance(VAULT);
  if (/^1{32}$/.test(vaultState.code) && vaultState.amount < BigInt(code.length) * STORAGE_PER_BYTE + milli(250)) {
    const need = BigInt(code.length) * STORAGE_PER_BYTE + milli(250) - vaultState.amount;
    const hash = await call(root, VAULT, "__transfer__", null, { deposit: need });
    log(`topped up ${VAULT} by ${near(need)} NEAR ${explorer(hash)}`);
    vaultState = await balance(VAULT);
  }
  if (!/^1{32}$/.test(vaultState.code) && vaultState.code !== codeHash) {
    // Same vault, new build (only possible while the vault still has its key): redeploy the code, keep the state.
    const out = await signerFor(VAULT).signAndSendTransaction({ receiverId: VAULT, actions: [actions.deployContract(code)] });
    log(`redeployed ${VAULT} with ${codeHash} ${explorer(out?.transaction?.hash)}`);
    record("redeploy_vault", { tx: out?.transaction?.hash, code_hash: codeHash, wasm_bytes: code.length });
  }
  if (/^1{32}$/.test(vaultState.code)) {
    const vault = signerFor(VAULT);
    const out = await vault.signAndSendTransaction({
      receiverId: VAULT,
      actions: [
        actions.deployContract(code),
        actions.functionCall("new", { dao: DAO, usdc: USDC, fee_account: ROOT, window_ns: String(BigInt(WINDOW_SEC) * 1_000_000_000n) }, teraToGas(30), 0n),
      ],
    });
    log(`deployed the vault ${explorer(out?.transaction?.hash)}`);
    record("deploy_vault", { tx: out?.transaction?.hash, code_hash: codeHash, wasm_bytes: code.length });
  }
  const config = await view(VAULT, "get_config");
  if (config.dao !== DAO || config.usdc !== USDC) throw new Error(`vault config is not what we expect: ${JSON.stringify(config)}`);

  // ---------- USDC storage for everyone who will hold it ----------
  for (const id of [VAULT, ROOT, ...MEMBERS.map(member)]) {
    if (await view(USDC, "storage_balance_of", { account_id: id })) continue;
    const hash = await call(root, USDC, "storage_deposit", { account_id: id, registration_only: true }, { deposit: USDC_STORAGE, tgas: 30 });
    log(`registered ${id} with USDC ${explorer(hash)}`);
  }

  // ---------- members get USDC, join, set rules ----------
  for (const m of MEMBERS) {
    const id = member(m);
    const acc = signerFor(id);
    if (BigInt(await view(VAULT, "get_shares", { account_id: id })) === 0n) {
      // NEAR holds back prepaid gas until a call finishes, so a member needs the join deposit plus
      // the join's gas up front, and enough left after it for their agent's exit.
      const st = await balance(id);
      const free = st.amount - BigInt(st.storage) * STORAGE_PER_BYTE;
      if (free < MEMBER_FREE_BEFORE_JOIN) {
        const hash = await call(root, id, "__transfer__", null, { deposit: MEMBER_FREE_BEFORE_JOIN - free });
        log(`topped up ${id} by ${near(MEMBER_FREE_BEFORE_JOIN - free)} NEAR ${explorer(hash)}`);
      }
      const pending = BigInt(await view(VAULT, "get_pending", { account_id: id }));
      if (pending < perMember) {
        const have = BigInt(await view(USDC, "ft_balance_of", { account_id: id }));
        if (have < perMember - pending) {
          await call(root, USDC, "ft_transfer", { receiver_id: id, amount: String(perMember - pending - have) }, { deposit: 1n, tgas: 30 });
        }
        await call(acc, USDC, "ft_transfer_call", { receiver_id: VAULT, amount: String(perMember - pending), msg: "join" }, { deposit: 1n, tgas: 60 });
      }
      const hash = await call(acc, VAULT, "join", {}, { deposit: JOIN_NEAR, tgas: 100 });
      const shares = BigInt(await view(VAULT, "get_shares", { account_id: id }));
      if (shares === 0n) throw new Error(`${id} did not get shares; see ${explorer(hash)}`);
      log(`${id} joined ${explorer(hash)}`);
      record("join", { account: id, tx: hash });
    }
    const want = rulesFor(m);
    if (!isDeepStrictEqual(await view(VAULT, "get_rules", { account_id: id }), want)) {
      const hash = await call(acc, VAULT, "set_rules", { rules: want }, { tgas: 30 });
      log(`${id} set rules ${JSON.stringify(want)}`);
      record("set_rules", { account: id, rules: want, tx: hash });
    }
  }

  // ---------- each member's agent key: exit and cancel_spend on the vault, nothing else ----------
  fs.mkdirSync(AGENT_KEYS, { recursive: true, mode: 0o700 });
  for (const m of MEMBERS) {
    const id = member(m);
    const file = path.join(AGENT_KEYS, `${id}.json`);
    let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (!saved) {
      const kp = KeyPair.fromRandom("ed25519");
      saved = { account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString(), added: false };
      fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    }
    if (!saved.added) {
      // If an earlier run added the key but lost the reply, the key is already on chain: just record that.
      const onChain = await rpcKeyExists(id, saved.public_key);
      if (onChain) {
        saved.added = true;
        fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
        log(`${id}'s agent key was already on chain`);
        continue;
      }
      const out = await signerFor(id).addFunctionCallAccessKey({ publicKey: saved.public_key, contractId: VAULT, methodNames: ["exit", "cancel_spend"], allowance: milli(250) });
      saved.added = true;
      fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      log(`${id} added its agent key ${saved.public_key} ${explorer(out?.transaction?.hash)}`);
      record("agent_key", { account: id, public_key: saved.public_key, tx: out?.transaction?.hash });
    }
  }

  const b = await view(VAULT, "get_balances");
  log(`done. vault holds ${near(b.near)} NEAR and ${usdc(b.usdc)} USDC for ${b.members} members`);
}

async function rpcKeyExists(accountId, publicKey) {
  try {
    await rpcQuery({ request_type: "view_access_key", account_id: accountId, public_key: publicKey });
    return true;
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCESS_KEY|access key/i.test(String(e?.message ?? e))) return false;
    throw e;
  }
}

async function alreadyJoined() {
  if (!(await exists(VAULT)) || /^1{32}$/.test((await balance(VAULT)).code)) return false;
  const b = await view(VAULT, "get_balances");
  return b.members === MEMBERS.length;
}


main().catch((e) => {
  console.error(`stopped: ${e?.message ?? e}${e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? ""})` : ""}`);
  if (!process.env.NODE_OPTIONS?.includes("ipv4first")) console.error("NODE_OPTIONS is not set to ipv4first in this terminal: run  source ~/.bashrc  and try again.");
  console.error("nothing after this step was sent. Fix the cause and run the same command again.");
  process.exit(1);
});
