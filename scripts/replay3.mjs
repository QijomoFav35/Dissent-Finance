// Replay, full detail: every approved Sputnik transfer that had at least one Reject vote, with what an
// exit agent would have needed to judge it at the time. Public mainnet data only. No keys.
//
//   node scripts/replay3.mjs > replay3.json
//   node scripts/replay3.mjs https://rpc.intea.rs > replay3.json
//
// For each contested transfer it records the amount, who voted which way, whether this DAO had paid the
// receiver before, whether the receiver voted for their own payment, and the DAO's median earlier
// transfer in the same token. Past treasury balances are not readable from a view call, so they are
// not recorded: the simulation has to model the fund size and says so.

const RPCS = [process.argv[2], "https://rpc.intea.rs", "https://near.blockpi.network/v1/rpc/public", "https://free.rpc.fastnear.com"].filter(Boolean);
const PAGE = 100;

// The 16 DAOs where yesterday's scan of the 49 largest found contested transfers.
const DAOS = [
  "nearweek-news-contribution", "marmaj", "muti", "ref-finance", "marketing", "incubadora", "testing-astradao",
  "open-web-sandbox", "community", "gambiarra-dao", "freelancerdao", "romakqatesting", "gwg", "thekindao",
  "croncat", "creativesdao",
].map((d) => `${d}.sputnik-dao.near`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function view(accountId, method, args = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "replay3",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  });
  let last;
  for (let i = 0; i < 8; i++) {
    const rpc = RPCS[i % RPCS.length];
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) throw new Error(`429 from ${rpc}`);
      const json = await res.json();
      if (json.error || json.result?.error) throw new Error(JSON.stringify(json.error || json.result.error).slice(0, 200));
      return JSON.parse(Buffer.from(json.result.result).toString());
    } catch (e) {
      last = e;
      await sleep(700 * (i + 1));
    }
  }
  throw last;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

function council(policy) {
  const out = new Set();
  for (const role of policy?.roles || []) for (const a of role.kind?.Group || []) out.add(a);
  return [...out];
}

async function scan(dao) {
  const policy = await view(dao, "get_policy").catch(() => null);
  const members = council(policy);
  const total = Number(await view(dao, "get_last_proposal_id"));
  const paidBefore = new Map(); // receiver -> approved transfers so far
  const earlier = new Map(); // token -> amounts of earlier approved transfers (BigInt)
  const contested = [];
  let approved = 0;

  for (let from = 0; from < total; from += PAGE) {
    const page = await view(dao, "get_proposals", { from_index: from, limit: PAGE });
    for (const p of page) {
      const t = p.kind?.Transfer;
      if (!t || p.status !== "Approved") continue;
      approved++;
      const token = t.token_id || "NEAR";
      const amount = BigInt(t.amount);
      const votes = Object.entries(p.votes || {});
      const approvers = votes.filter(([, v]) => v === "Approve").map(([a]) => a);
      const rejecters = votes.filter(([, v]) => v === "Reject" || v === "Remove").map(([a]) => a);
      if (rejecters.length) {
        const voted = new Set(votes.map(([a]) => a));
        const prior = earlier.get(token) || [];
        const med = median(prior);
        contested.push({
          dao,
          id: p.id,
          submitted_ns: p.submission_time,
          token,
          amount: t.amount,
          receiver: t.receiver_id,
          approvers,
          rejecters,
          absent_now_council: members.filter((m) => !voted.has(m)).length,
          receiver_paid_before: (paidBefore.get(t.receiver_id) || 0) > 0,
          receiver_voted_approve: approvers.includes(t.receiver_id),
          proposer_is_receiver: p.proposer === t.receiver_id,
          earlier_transfers_same_token: prior.length,
          median_earlier_amount: med === null ? null : med.toString(),
        });
      }
      paidBefore.set(t.receiver_id, (paidBefore.get(t.receiver_id) || 0) + 1);
      if (!earlier.has(token)) earlier.set(token, []);
      earlier.get(token).push(amount);
    }
    process.stderr.write(`\r${dao}: ${Math.min(from + PAGE, total)}/${total}   `);
  }
  process.stderr.write(`\n`);
  return { dao, council_now: members.length, proposals: total, approved_transfers: approved, contested };
}

const out = { scanned_at: new Date().toISOString(), rpcs: RPCS, daos: [], errors: [] };
for (const dao of DAOS) {
  try {
    out.daos.push(await scan(dao));
  } catch (e) {
    out.errors.push({ dao, error: String(e).slice(0, 300) });
    process.stderr.write(`\n${dao}: FAILED ${e}\n`);
  }
}
out.contested_total = out.daos.reduce((s, d) => s + d.contested.length, 0);
process.stderr.write(`contested transfers: ${out.contested_total} across ${out.daos.filter((d) => d.contested.length).length} DAOs, errors: ${out.errors.length}\n`);
console.log(JSON.stringify(out, null, 2));
