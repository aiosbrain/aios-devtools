// Regression guard for the publish-critical fields of package.json.
//
// Why this file exists: publishing 0.2.1 failed at the very last step of
// .github/workflows/publish-npm.yml with
//
//   npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@aiosbrain%2faios-devtools
//   Error verifying sigstore provenance bundle: Failed to validate repository information:
//   package.json: "repository.url" is "", expected to match
//   "https://github.com/aiosbrain/aios-devtools" from provenance
//
// package.json carried no `repository` field at all. We publish via Trusted
// Publishing / OIDC, so npm signs a provenance statement naming the GitHub repo the
// build came from and then cross-checks that claim against package.json before it
// will accept the tarball. Everything cheap happened first — checkout, npm ci, the
// full test suite, the tarball build, a Sigstore-logged signature — and only then
// did the registry reject the PUT. That is the most expensive place a one-line
// metadata mistake can surface: a manual workflow_dispatch, minutes of CI, and a
// burned release attempt, to learn something a string comparison knows for free.
// Fixed in PR #12; nothing stopped it recurring, hence this file.
//
// Scope discipline: assert only what actually gates or breaks a publish. Fields
// that legitimately vary (description, dependency ranges, the version *number*)
// are not asserted — only that version is well-formed. Everything here is a pure
// read of package.json plus a few statSync calls: no network, no npm invocation.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the expected origin. A fork or rename changes this
// one constant — nothing below repeats the org/repo string.
const ORG = "aiosbrain";
const REPO = "aios-devtools";
const REPO_URL = `https://github.com/${ORG}/${REPO}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

// The registry compares the *normalized* repository URL against the provenance
// subject: a leading `git+` scheme prefix and a trailing `.git` are stripped, as
// is a trailing slash. Reproduce that normalization exactly.
function normalizeRepoUrl(url) {
  return String(url)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

test("repository.url normalizes to the URL npm provenance validates against", () => {
  assert.ok(
    pkg.repository,
    "package.json has no `repository` field — this is the exact 422 that killed the 0.2.1 publish"
  );
  const url =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
  assert.equal(
    typeof url,
    "string",
    "`repository.url` must be a string; npm reads it verbatim when verifying provenance"
  );
  assert.equal(
    normalizeRepoUrl(url),
    REPO_URL,
    `normalized repository.url must equal ${REPO_URL} — the registry rejects the publish (422) when it disagrees with the OIDC provenance subject`
  );
  if (typeof pkg.repository === "object") {
    assert.equal(pkg.repository.type, "git", "repository.type must be `git`");
  }
});

test("homepage and bugs.url point at the same repository", () => {
  assert.equal(typeof pkg.homepage, "string", "package.json needs a `homepage`");
  assert.ok(
    pkg.homepage.startsWith(`${REPO_URL}`),
    `homepage must point at ${REPO_URL}, got ${pkg.homepage}`
  );
  assert.ok(pkg.bugs, "package.json needs a `bugs` field");
  const bugsUrl = typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs.url;
  assert.equal(typeof bugsUrl, "string", "`bugs.url` must be a string");
  assert.ok(
    bugsUrl.startsWith(`${REPO_URL}`),
    `bugs.url must point at ${REPO_URL}, got ${bugsUrl}`
  );
});

test("name, version, license and publishConfig satisfy the registry", () => {
  // The scope is half of what the registry resolves the PUT against
  // (@aiosbrain%2faios-devtools in the 422 above).
  assert.equal(
    pkg.name,
    `@${ORG}/${REPO}`,
    "package name must match the scope/name the trusted publisher is configured for"
  );
  // publish-npm.yml's version guard compares its dispatch input to this string,
  // and npm rejects a non-semver version outright. Exact semver only — no ranges,
  // no leading `v`. (The number itself legitimately changes; the shape does not.)
  assert.match(
    String(pkg.version),
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    `version must be exact semver, got ${pkg.version}`
  );
  // Without this, a scoped package publishes private by default and the publish
  // fails on a free/unentitled account (402 Payment Required).
  assert.equal(
    pkg.publishConfig?.access,
    "public",
    "scoped packages need publishConfig.access = public or npm attempts a private publish"
  );
  assert.equal(typeof pkg.license, "string", "package.json needs a `license`");
  assert.ok(pkg.license.length > 0, "`license` must not be empty");
  assert.notEqual(
    pkg.private,
    true,
    "`private: true` makes `npm publish` refuse outright"
  );
});

test("every advertised entrypoint exists and ships inside `files`", () => {
  // Not a 422 risk, but the other way a publish "succeeds" and is broken: `files`
  // is an allowlist, so an entrypoint outside it resolves locally and 404s for
  // every installer. Deterministic and cheap to check here.
  const included = pkg.files ?? [];
  const shipped = (relative) =>
    included.some((entry) => {
      const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
      return relative === normalized || relative.startsWith(`${normalized}/`);
    });

  const targets = [
    ...Object.values(pkg.bin ?? {}),
    ...Object.values(pkg.exports ?? {}).flatMap((value) =>
      typeof value === "string" ? [value] : Object.values(value)
    ),
    ...(pkg.main ? [pkg.main] : []),
  ];
  assert.ok(targets.length > 0, "package.json advertises no entrypoints at all");

  for (const target of targets) {
    const relative = target.replace(/^\.\//, "");
    assert.ok(
      existsSync(path.join(repoRoot, relative)),
      `entrypoint ${target} does not exist on disk`
    );
    // package.json itself is always included by npm regardless of `files`.
    if (relative === "package.json") continue;
    assert.ok(
      shipped(relative),
      `entrypoint ${target} is not covered by package.json "files" — it would be missing from the published tarball`
    );
  }
});

// The lockfile carries its OWN copy of the root package's license, and npm does not keep the
// two in step. `0.2.1` shipped with an AGPL manifest and a lockfile that still said MIT: the
// upstream relicense bumped no version, so nothing forced the pair to be re-derived together.
// A registry artifact that disagrees with itself about its licence is exactly the ambiguity a
// relicense exists to remove.
test("the lockfile agrees with the manifest about version and license", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.name, pkg.name, "lockfile name must match the manifest");
  assert.equal(lock.version, pkg.version, "lockfile version must match the manifest");
  assert.equal(
    lock.packages?.[""]?.version,
    pkg.version,
    "the lockfile's root package entry must match the manifest version"
  );
  assert.equal(
    lock.packages?.[""]?.license,
    pkg.license,
    "the lockfile's root package license must match the manifest — they drifted for all of 0.2.1"
  );
});

// CHANGELOG.md is in `files`, so it ships inside the immutable tarball. If it is written after
// the bump, that version's own changelog can never name what the version changed.
test("the shipped changelog names the version being published", () => {
  assert.ok(pkg.files.includes("CHANGELOG.md"), "CHANGELOG.md must ship in the tarball");
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.ok(
    changelog.split("\n").some((line) => line.startsWith(`## [${pkg.version}]`)),
    `CHANGELOG.md must contain a '## [${pkg.version}]' section — publish-npm.yml gates on it`
  );
});
