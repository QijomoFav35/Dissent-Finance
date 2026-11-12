// Read-only NEAR RPC with retries and failover across several public endpoints. No keys.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Rpc {
  /**
   * @param {string[]} urls endpoints tried in order; a failing one is skipped for the rest of the call
   * @param {{ tries?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(urls, opts = {}) {
    if (!urls?.length) throw new Error("Rpc needs at least one URL");
    this.urls = urls;
    this.tries = opts.tries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetch = opts.fetchImpl ?? fetch;
    // "final" is safe for agents; scripts that read back their own writes use "optimistic".
    this.finality = opts.finality ?? "final";
  }

  async query(params) {
    let lastError;
    for (let attempt = 0; attempt < this.tries; attempt++) {
      const url = this.urls[attempt % this.urls.length];
      try {
        const res = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "agent", method: "query", params: { finality: this.finality, ...params } }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429) throw new Error(`rate limited by ${url}`);
        const json = await res.json();
        if (json.error) {
          const text = JSON.stringify(json.error);
          const err = new Error(`${url}: ${text.slice(0, 300)}`);
          // "This account or key does not exist" is an answer, not a transport failure: don't retry it.
          if (/UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist while viewing/.test(text)) err.contractError = true;
          throw err;
        }
        if (json.result?.error) {
          // A contract panic is an answer, not a transport failure: do not retry it.
          const err = new Error(json.result.error);
          err.contractError = true;
          throw err;
        }
        return json.result;
      } catch (e) {
        if (e.contractError) throw e;
        lastError = e;
        await sleep(Math.min(500 * (attempt + 1), 4000));
      }
    }
    throw lastError;
  }

  async view(accountId, methodName, args = {}) {
    const r = await this.query({
      request_type: "call_function",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const text = Buffer.from(r.result).toString();
    return text.length ? JSON.parse(text) : null;
  }
}
