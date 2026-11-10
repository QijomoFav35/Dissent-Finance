// One pass of the watcher: for every open spend and every member it acts for, decide, write the
// note, exit when a rule is broken, then cancel any spend the exits have made unaffordable.

import { evaluate, unaffordable } from "./rules.js";
import { hashNote, makeNote } from "./note.js";

export const MAX_ATTEMPTS = 3;

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
          if (r?.ok === false) throw new Error(`cancel failed: ${JSON.stringify(r.failure)}`);
          this.store.put(key, { tx: r?.hash ?? null, at: this.now() });
          done.cancelled.push({ spend: spend.id, tx: r?.hash ?? null });
          this.log(`cancelled spend ${spend.id}`);
        } catch (e) {
          done.errors.push({ spend: spend.id, action: "cancel", error: String(e?.message ?? e) });
        }
      }
    }
    return done;
  }

  async decide(spend, member, done) {
    const key = `decision:${spend.id}:${member.accountId}`;
    const prior = this.store.get(key);
    if (prior && (prior.final || prior.attempts >= MAX_ATTEMPTS)) return;

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
    await this.publish(note, hash);
    done.decided.push({ spend: spend.id, member: member.accountId, decision: result.decision, hash });

    if (result.decision === "stay") {
      this.store.put(key, { final: true, decision: "stay", hash });
      return;
    }

    const attempts = (prior?.attempts ?? 0) + 1;
    try {
      const r = await member.caller.exit(hash);
      if (r?.ok === false) throw new Error(`exit failed: ${JSON.stringify(r.failure)}`);
      this.store.put(key, { final: true, decision: "exit", hash, tx: r?.hash ?? null });
      done.exited.push({ spend: spend.id, member: member.accountId, hash, tx: r?.hash ?? null });
      this.log(`${member.accountId} exited over spend ${spend.id} (${hash.slice(0, 12)})`);
    } catch (e) {
      this.store.put(key, { final: false, decision: "exit", hash, attempts, error: String(e?.message ?? e) });
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
