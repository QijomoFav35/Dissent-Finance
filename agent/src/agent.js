// One pass of the watcher: for every open spend and every member it acts for, decide, write the
// note, exit when a rule is broken, then cancel any spend the exits have made unaffordable.

import { evaluate, unaffordable } from "./rules.js";
import { hashNote, makeNote } from "./note.js";

// An exit that fails is retried on every pass until the spend's window closes: giving up early
// would hand the spend to the approvers. The note is written once and its hash reused, so the
// published note always matches whatever exit lands.
// Contract answers to cancel_spend that mean another member's agent already settled the spend.
const SETTLED = /ERR_ALREADY_EXECUTED|ERR_SPEND_AFFORDABLE/;

export class ExitAgent {
  /**
   * @param {{
   *   vaultId: string,
   *   reader: { openSpends(): Promise<any[]>, balances(): Promise<any>, rules(a: string): Promise<any>,
   *             shares(a: string): Promise<bigint>, wasPaid(a: string): Promise<boolean> },
   *   members: { accountId: string, caller: { exit(h: string): Promise<any>, cancelSpend(id: number): Promise<any> } }[],
   *   store: { has(key: string): boolean, get(key: string): any, put(key: string, value: any): void },
   *   publish?: (note: any, hash: string) => Promise<void> | void,
   *   now?: () => string,
   *   nowNs?: () => bigint,
   *   log?: (line: string) => void,
   * }} deps
   */
  constructor(deps) {
    this.vaultId = deps.vaultId;
    this.reader = deps.reader;
    this.members = deps.members;
    this.store = deps.store;
    this.publish = deps.publish ?? (() => {});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.nowNs = deps.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.log = deps.log ?? (() => {});
  }

  /** Runs one pass and returns what it did, for logs and tests. */
  async tick() {
    const done = { decided: [], exited: [], cancelled: [], errors: [] };
    const spends = (await this.reader.openSpends()) ?? [];
    for (const spend of spends) {
      for (const member of this.members) {
        try {
          await this.decide(spend, member, done);
        } catch (e) {
          done.errors.push({ spend: spend.id, member: member.accountId, error: String(e?.message ?? e) });
          this.log(`error spend ${spend.id} ${member.accountId}: ${e?.message ?? e}`);
        }
      }
    }
    // After this pass's exits, any spend the fund can no longer pay is dead: cancel it.
    if (spends.length) {
      const balances = await this.reader.balances();
      for (const spend of spends) {
        if (!unaffordable(spend, balances)) continue;
        const key = `cancel:${spend.id}`;
        if (this.store.has(key)) continue;
        const caller = this.members[0]?.caller;
        if (!caller) continue;
        try {
          const r = await caller.cancelSpend(spend.id);
          if (r?.ok === false) {
            // Another member's agent got there first: the spend is already settled, nothing left to do.
            if (SETTLED.test(JSON.stringify(r.failure))) {
              this.store.put(key, { tx: null, at: this.now(), by: "another member" });
              continue;
            }
            throw new Error(`cancel failed: ${JSON.stringify(r.failure)}`);
          }
          this.store.put(key, { tx: r?.hash ?? null, at: this.now() });
          done.cancelled.push({ spend: spend.id, tx: r?.hash ?? null });
          this.log(`cancelled spend ${spend.id}`);
        } catch (e) {
          const msg = String(e?.message ?? e);
          if (SETTLED.test(msg)) {
            this.store.put(key, { tx: null, at: this.now(), by: "another member" });
            continue;
          }
          done.errors.push({ spend: spend.id, action: "cancel", error: msg });
        }
      }
    }
    return done;
  }

  async decide(spend, member, done) {
    const key = `decision:${spend.id}:${member.accountId}`;
    const prior = this.store.get(key);
    if (prior?.final) return;

    if (prior?.decision === "exit") {
      // Already decided and published: retry the same exit with the same hash until the window closes.
      if (this.nowNs() >= BigInt(spend.window_ends)) {
        this.store.put(key, { ...prior, final: true, gave_up: "window closed" });
        this.log(`${member.accountId}: window for spend ${spend.id} closed before an exit landed`);
        return;
      }
      return this.tryExit(spend, member, key, prior, done);
    }

    const shares = await this.reader.shares(member.accountId);
    if (shares === 0n) {
      this.store.put(key, { final: true, decision: "none", reason: "no shares" });
      return;
    }

    const [balances, rules, recipientPaidBefore] = await Promise.all([
      this.reader.balances(),
      this.reader.rules(member.accountId),
      this.reader.wasPaid(spend.recipient),
    ]);
    const approved = spend.approvers.includes(member.accountId);
    const result = approved
      ? { decision: "stay", checks: [{ rule: "approved", limit: null, value: "member voted Approve", broken: false }] }
      : evaluate(spend, rules, { balances, recipientPaidBefore });

    const note = makeNote({ vault: this.vaultId, member: member.accountId, spend, balances, rules, result, approved, at: this.now() });
    const hash = hashNote(note);
    // Saved before publishing or exiting, so a crash or a retry can never produce a second, different note.
    const decision = { final: result.decision === "stay", decision: result.decision, hash, note, attempts: 0 };
    this.store.put(key, decision);
    await this.publish(note, hash);
    done.decided.push({ spend: spend.id, member: member.accountId, decision: result.decision, hash });
    if (result.decision === "stay") return;
    return this.tryExit(spend, member, key, decision, done);
  }

  async tryExit(spend, member, key, decision, done) {
    const attempts = (decision.attempts ?? 0) + 1;
    try {
      const r = await member.caller.exit(decision.hash);
      if (r?.ok === false) throw new Error(`exit failed: ${JSON.stringify(r.failure)}`);
      this.store.put(key, { ...decision, final: true, attempts, tx: r?.hash ?? null });
      done.exited.push({ spend: spend.id, member: member.accountId, hash: decision.hash, tx: r?.hash ?? null });
      this.log(`${member.accountId} exited over spend ${spend.id} (${decision.hash.slice(0, 12)})`);
    } catch (e) {
      const error = String(e?.message ?? e);
      // No shares left: an earlier attempt already landed, or the member left by hand. Nothing to retry.
      const final = /ERR_NO_SHARES/.test(error);
      this.store.put(key, { ...decision, final, attempts, error });
      throw e;
    }
  }
}

/** A tiny persistent store: one JSON file, rewritten on every put. */
export class FileStore {
  constructor(fs, path) {
    this.fs = fs;
    this.path = path;
    this.data = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  }
  has(key) {
    return Object.hasOwn(this.data, key);
  }
  get(key) {
    return this.data[key];
  }
  put(key, value) {
    this.data[key] = value;
    this.fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

export class MemoryStore {
  constructor() {
    this.data = new Map();
  }
  has(key) {
    return this.data.has(key);
  }
  get(key) {
    return this.data.get(key);
  }
  put(key, value) {
    this.data.set(key, value);
  }
}
