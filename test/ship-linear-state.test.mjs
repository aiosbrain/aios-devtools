import test from "node:test";
import assert from "node:assert/strict";
import { moveIssueToInProgress } from "../scripts/ship/linear-state.mjs";

const issue = (type, name) => ({
  issues: {
    nodes: [
      {
        id: "uuid-1",
        identifier: "AIO-556",
        state: { name, type },
        team: {
          states: {
            nodes: [
              { id: "s-todo", name: "Todo", type: "unstarted" },
              { id: "s-prog", name: "In Progress", type: "started" },
              { id: "s-rev", name: "In Review", type: "started" },
              { id: "s-done", name: "Done", type: "completed" },
            ],
          },
        },
      },
    ],
  },
});

function fake(node) {
  const calls = [];
  return {
    calls,
    request: async (q, v) => {
      calls.push(v);
      if (/ShipIssueState/.test(q)) return node;
      return { issueUpdate: { success: true, issue: { identifier: "AIO-556", state: { name: "In Progress" } } } };
    },
  };
}

test("moves a Todo card to In Progress, picking the state named In Progress", async () => {
  const l = fake(issue("unstarted", "Todo"));
  const r = await moveIssueToInProgress(l, "AIO-556");
  assert.deepEqual(r, { moved: true, from: "Todo", to: "In Progress" });
  assert.equal(l.calls.at(-1).stateId, "s-prog");
});

test("never moves a started, review or closed card backwards", async () => {
  for (const [type, name] of [["started", "In Review"], ["completed", "Done"], ["canceled", "Canceled"]]) {
    const l = fake(issue(type, name));
    const r = await moveIssueToInProgress(l, "AIO-556");
    assert.equal(r.moved, false, name);
    assert.equal(l.calls.length, 1, "no mutation sent");
  }
});

test("never throws: bad identifier, missing client, Linear error, unsuccessful update", async () => {
  assert.equal((await moveIssueToInProgress(null, "AIO-1")).moved, false);
  assert.equal((await moveIssueToInProgress(fake(issue("unstarted", "Todo")), "nope")).moved, false);
  const boom = { request: async () => { throw new Error("linear down"); } };
  assert.match((await moveIssueToInProgress(boom, "AIO-1")).reason, /linear down/);
  const noop = { request: async (q) => (/ShipIssueState/.test(q) ? issue("unstarted", "Todo") : { issueUpdate: { success: false } }) };
  assert.equal((await moveIssueToInProgress(noop, "AIO-1")).moved, false);
});
