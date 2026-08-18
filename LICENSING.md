# Licensing

AIOS devtools is open source, licensed under the **GNU Affero General Public License
v3.0 only** (`AGPL-3.0-only`). It is OSI-approved, and the FSF lists it as a free
software license.

Copyright (C) 2026 Chetan Nandakumar and John Ellison.

---

## What is under which license

| Path | License |
| --- | --- |
| Everything in this repository | `AGPL-3.0-only` |

There are no Apache-2.0 directories here. That is a deliberate choice rather than an
oversight, and it is worth recording why, because the packaging suggests otherwise.

**Why this repository is AGPL and not Apache-2.0.** The package is published with public
access and a stable `bin`, which reads like something built for outside adoption. In its
current state it is not: the Linear issue prefix `AIO-` is a hardcoded *validation* regex
in six modules with no configuration override, so `ship`, `roadmap-run`,
`consolidate-findings`, `spec-publish` and `build --pr` reject another team's issue keys
outright rather than falling back. Toolkit-seam functionality also requires an AIOS
workspace checkout via `AIOS_TOOLKIT_DIR`. It is internal tooling that happens to be
packaged, and the license should say what the software is.

There is a second, harder constraint. This package depends on `@aiosbrain/foundation`,
which lives in the AGPL-licensed AIOS workspace repository. Licensing this package
Apache-2.0 would therefore violate the dependency-direction rule below on day one. If we
later want external adoption, the path is: carve `packages/foundation` out to Apache-2.0,
de-hardcode the issue prefix, then relax this license — in that order. Relaxing a license
later is easy; walking a permissive grant back is not.

Prior releases were published under the MIT License. **They remain MIT** — the change is
going-forward only and takes nothing away. That text is preserved verbatim in
[`LICENSE-MIT`](LICENSE-MIT), including the original copyright notice, as the MIT License
requires.

---

## What this means for you

**Running this inside your company is unrestricted.** The AGPL places no obligation on
internal use, however many people use it, however much you modify it.

**If your company's policy bans AGPL**, there is a free-of-charge commercial license for
internal use. See [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).

Longer answers: [`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md).

---

## The dependency-direction rule

Two licenses in one organization means one rule, and it only runs one way:

> **An Apache-2.0 package must never import from an AGPL-3.0 package.**
> Apache → AGPL is fine. AGPL → Apache is a license violation.

The reason is that the AGPL is contagious across a combined program and Apache-2.0 is not.
An AGPL module pulled into an Apache-2.0 package makes that package's Apache grant
undeliverable — we would be promising permissions on code we cannot grant them for. The
reverse is harmless: AGPL code may absorb Apache-2.0 code, and the result is AGPL.

The same rule holds across repositories in the `aiosbrain` organization. An Apache-2.0
repo may not depend on an AGPL-3.0 one.

For this repository the rule currently binds in only one direction of interest: this
package is AGPL and may freely depend on `@aiosbrain/foundation` (AGPL) and on permissive
packages. Nothing here may be imported by an Apache-2.0 package elsewhere in the org.

---

## Third-party components

[`NOTICE`](NOTICE) records the components carrying an attribution obligation.

---

## Contributing

Contributions are accepted under `AGPL-3.0-only`. A Contributor License Agreement will be
introduced once our company is formed, at which point contributors will be asked to sign
one.
