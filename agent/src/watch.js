#!/usr/bin/env node
// The watcher: polls the vault and runs the exit agent for each member in the config.
//
//   node src/watch.js agent.config.json --member alice.near
//
// Start one watcher per member, each with only that member's key in its environment.
//
// agent.config.json:
//   {
//     "vault": "vault.example.near",
//     "rpc": ["https://free.rpc.fastnear.com", "https://rpc.intea.rs"],
//     "interval_sec": 15,
//     "notes_dir": "notes",
//     "members": [{ "account_id": "alice.near", "key_env": "ALICE_AGENT_KEY" }]
//   }
//
// Each member's key is read from the named environment variable, never from the config file.
// It must be a function-call key limited to the vault's exit and cancel_spend methods.

import fs from "node:fs";
import path from "node:path";
import { Rpc } from "./rpc.js";
import { VaultReader } from "./vault.js";
import { KeyCaller } from "./chain.js";
import { ExitAgent, FileStore } from "./agent.js";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node src/watch.js <config.json> [--once]");
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const once = process.argv.includes("--once");
const notesDir = cfg.notes_dir ?? "notes";
fs.mkdirSync(notesDir, { recursive: true });

// One process holds one member's key. Run one watcher per member so no process can act for anyone else.
const pick = process.argv.includes("--member") ? process.argv[process.argv.indexOf("--member") + 1] : null;
const mine = pick ? cfg.members.filter((m) => m.account_id === pick) : cfg.members;
if (mine.length !== 1) {
  console.error(`run with --member <account_id>; one watcher holds exactly one member's key (config lists ${cfg.members.length})`);
  process.exit(2);
}

const rpc = new Rpc(cfg.rpc);
const members = mine.map((m) => {
  const secretKey = process.env[m.key_env];
  if (!secretKey) throw new Error(`set ${m.key_env} to ${m.account_id}'s function-call key`);
  return { accountId: m.account_id, caller: new KeyCaller({ accountId: m.account_id, secretKey, rpcUrl: cfg.rpc[0], vaultId: cfg.vault }) };
});

const agent = new ExitAgent({
  vaultId: cfg.vault,
  reader: new VaultReader(rpc, cfg.vault),
  members,
  store: new FileStore(fs, path.join(notesDir, `state-${members[0].accountId}.json`)),
  publish: (note, hash) => {
    fs.writeFileSync(path.join(notesDir, `${note.spend.id}-${note.member}.json`), JSON.stringify({ hash, note }, null, 2));
  },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});

async function loop() {
  for (;;) {
    try {
      const r = await agent.tick();
      if (r.decided.length || r.cancelled.length || r.errors.length) console.log(JSON.stringify(r));
    } catch (e) {
      console.error(`${new Date().toISOString()} tick failed: ${e?.message ?? e}`);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, (cfg.interval_sec ?? 15) * 1000));
  }
}

loop();
