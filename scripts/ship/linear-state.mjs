// Move an issue's Linear card when the factory starts working on it. `aios ship` used to leave the
// card in Backlog/Todo for the whole build, so the board did not show the work happening.
// Best effort by design: a Linear hiccup must never fail or stall a build, and a card that has
// already been started (or is in review, done or canceled) is never moved backwards.

const QUERY = `query ShipIssueState($key: String!, $num: Float!) {
  issues(filter: { team: { key: { eq: $key } }, number: { eq: $num } }, first: 1) {
    nodes { id identifier state { name type } team { states { nodes { id name type } } } }
  }
}`;
const MUTATION = `mutation ShipIssueStart($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { identifier state { name } } }
}`;

/** @returns {Promise<{ moved: boolean, from?: string, to?: string, reason?: string }>} never throws */
export async function moveIssueToInProgress(linear, identifier, log = () => {}) {
  const r = await move(linear, identifier);
  if (r.moved) log(`linear: ${identifier} ${r.from} -> ${r.to}`);
  return r;
}

async function move(linear, identifier) {
  try {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(identifier ?? ""));
    if (!m || typeof linear?.request !== "function") return { moved: false, reason: "no linear client" };
    const data = await linear.request(QUERY, { key: m[1].toUpperCase(), num: Number(m[2]) });
    const node = data?.issues?.nodes?.[0];
    if (!node) return { moved: false, reason: "issue not found" };
    const from = node.state?.name ?? "";
    if (!["backlog", "unstarted", "triage"].includes(node.state?.type)) {
      return { moved: false, from, reason: "already started or closed" };
    }
    const states = node.team?.states?.nodes ?? [];
    const target = states.find((s) => s.type === "started" && /^in progress$/i.test(s.name)) ?? states.find((s) => s.type === "started");
    if (!target) return { moved: false, from, reason: "team has no started state" };
    const res = await linear.request(MUTATION, { id: node.id, stateId: target.id });
    if (!res?.issueUpdate?.success) return { moved: false, from, reason: "issueUpdate not successful" };
    return { moved: true, from, to: target.name };
  } catch (e) {
    return { moved: false, reason: e?.message ?? String(e) };
  }
}
