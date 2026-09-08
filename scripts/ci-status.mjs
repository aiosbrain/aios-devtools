// Shared structured-check classification for both the consolidation verdict and
// finding inventory. Keeping one predicate prevents analytics from claiming a
// clean denominator for a check state that the command itself blocks on.
const RED_STATES = new Set([
  "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR",
]);
const PENDING_STATES = new Set([
  "PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "EXPECTED",
]);

export function checkIsRed(check) {
  return ["fail", "cancel"].includes(check.bucket)
    || RED_STATES.has(check.state)
    || RED_STATES.has(check.conclusion);
}

export function checkIsPending(check) {
  return check.bucket === "pending"
    || PENDING_STATES.has(check.state)
    || PENDING_STATES.has(check.conclusion);
}

export function sanitizedCheckIdentity(check) {
  const allowed = new Set(["name", "state", "bucket", "conclusion"]);
  if (!check || typeof check !== "object" || Array.isArray(check)
    || Object.keys(check).some((key) => !allowed.has(key))) throw new Error("unsafe CI check fields");
  if (typeof check.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._:/()@+,#\[\]-]{0,199}$/.test(check.name)) {
    throw new Error("unsafe CI check name");
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(check.name)
    || /(?:\/Users\/|\/home\/)/.test(check.name)) throw new Error("private CI check name");
  if (!/^[A-Z_]{0,32}$/.test(check.state ?? "") || !/^[a-z_]{0,32}$/.test(check.bucket ?? "")
    || !/^[A-Z_]{0,32}$/.test(check.conclusion ?? "")) throw new Error("unsafe CI check state");
  return { name: check.name, state: check.state ?? "", bucket: check.bucket ?? "", conclusion: check.conclusion ?? "" };
}
