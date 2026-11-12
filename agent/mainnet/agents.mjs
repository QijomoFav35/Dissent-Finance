#!/usr/bin/env node
// Starts one watcher process per member. Each process gets only its own member's agent key, which can
// call exit and cancel_spend on the vault and nothing else. Leave this running; Ctrl+C stops all five.
//
//   node mainnet/agents.mjs

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { VAULT, VAULT_NAME, RPCS, MEMBERS, member, AGENT_KEYS, log } from "./lib.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const config = path.join(here, VAULT_NAME === "vault" ? "agents.json" : `agents-${VAULT_NAME}.json`);
// Spend ids start at 0 in every vault, so each vault keeps its notes in its own folder.
const notesDir = VAULT_NAME === "vault" ? path.join(here, "notes") : path.join(here, "notes", VAULT_NAME);
fs.writeFileSync(
  config,
  JSON.stringify(
    {
      vault: VAULT,
      rpc: RPCS,
      interval_sec: Number(process.env.DISSENT_INTERVAL_SEC || 3),
      notes_dir: notesDir,
      members: MEMBERS.map((m) => ({ account_id: member(m), key_env: "AGENT_KEY" })),
    },
    null,
    2,
  ),
);

const children = [];
for (const m of MEMBERS) {
  const id = member(m);
  const file = path.join(AGENT_KEYS, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`no agent key for ${id}: run mainnet/setup.mjs --go first`);
  const { private_key, added } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!added) throw new Error(`${id}'s agent key was never added on chain: run mainnet/setup.mjs --go again`);
  const child = spawn(process.execPath, [path.join(here, "../src/watch.js"), config, "--member", id], {
    env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "", AGENT_KEY: private_key },
    cwd: path.join(here, ".."),
  });
  const prefix = m.padEnd(5);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (d) => {
      for (const line of String(d).split("\n").filter(Boolean)) console.log(`[${prefix}] ${line}`);
    });
  }
  child.on("exit", (code) => log(`${m}'s agent stopped (${code})`));
  children.push(child);
}
log(`five agents watching ${VAULT}. Notes go to ${notesDir}. Ctrl+C to stop.`);
process.on("SIGINT", () => {
  for (const c of children) c.kill();
  process.exit(0);
});
