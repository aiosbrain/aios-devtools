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
