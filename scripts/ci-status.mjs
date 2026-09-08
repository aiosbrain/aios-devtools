// Shared structured-check classification for both the consolidation verdict and
// finding inventory. Keeping one predicate prevents analytics from claiming a
// clean denominator for a check state that the command itself blocks on.
const RED_STATES = new Set([
  "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR",
]);
const PENDING_STATES = new Set([
  "PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "EXPECTED",
]);
const SAFE_CHECK_PUNCTUATION = new Set(" ._:/()@+,#[]-");

function isAsciiAlphaNumeric(character) {
  const code = character.codePointAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function checkIsRed(check) {
  if (!check || typeof check !== "object" || Array.isArray(check)) return false;
  return ["fail", "cancel"].includes(check.bucket)
    || RED_STATES.has(check.state)
    || RED_STATES.has(check.conclusion);
}

export function checkIsPending(check) {
  if (!check || typeof check !== "object" || Array.isArray(check)) return false;
  return check.bucket === "pending"
    || PENDING_STATES.has(check.state)
    || PENDING_STATES.has(check.conclusion);
}

export function sanitizedCheckIdentity(check) {
  const allowed = new Set(["name", "state", "bucket", "conclusion"]);
  if (!check || typeof check !== "object" || Array.isArray(check)
    || Object.keys(check).some((key) => !allowed.has(key))) throw new Error("unsafe CI check fields");
  const hasSafeCharacters = typeof check.name === "string"
    && check.name.length >= 1
    && check.name.length <= 200
    && [...check.name].every((character) => isAsciiAlphaNumeric(character) || SAFE_CHECK_PUNCTUATION.has(character));
  const hasSafeFirstCharacter = typeof check.name === "string" && check.name.length > 0
    && isAsciiAlphaNumeric(check.name[0]);
  if (!hasSafeCharacters || !hasSafeFirstCharacter) {
    throw new Error("unsafe CI check name");
  }
  const at = check.name.indexOf("@");
  const looksLikeEmail = at > 0 && check.name.indexOf(".", at + 2) > at + 1;
  if (looksLikeEmail
    || /(?:\/Users\/|\/home\/)/.test(check.name)) throw new Error("private CI check name");
  if (!/^[A-Z_]{0,32}$/.test(check.state ?? "") || !/^[a-z_]{0,32}$/.test(check.bucket ?? "")
    || !/^[A-Z_]{0,32}$/.test(check.conclusion ?? "")) throw new Error("unsafe CI check state");
  return { name: check.name, state: check.state ?? "", bucket: check.bucket ?? "", conclusion: check.conclusion ?? "" };
}
