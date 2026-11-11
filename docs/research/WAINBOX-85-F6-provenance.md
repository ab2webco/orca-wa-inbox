# WAINBOX-115 (WAINBOX-85 F-6): where the Rust Signal code in whatsapp-rust-bridge comes from

> **Not legal advice.** This is an engineering spike. It records what the source history and the
> shipped binary show. Counsel decides what the findings mean (WAINBOX-85 §6.7).

- Ticket: WAINBOX-115 (Spike, S). Parent: WAINBOX-110. Source: WAINBOX-85 §4 and §5 F-6
  (`docs/research/WAINBOX-85-libsignal-gpl.md`).
- Date: 2026-11-11
- Build examined: `main` at `343287f` (plugin v4.35.0). `sidecar/sidecar.cjs` inlines
  `whatsapp-rust-bridge` **0.5.4**, the exact version `@whiskeysockets/baileys` 7.0.0-rc14 pins.
- Trees compared: `oxidezap/whatsapp-rust` (formerly `jlucaso1/whatsapp-rust`) at the revision
  0.5.4 was built from (`95397408`, 2026-03-18) and at `main` (`baa3cfa0`, 2026-11-11);
  `signalapp/libsignal` at `9e2bcb2a` (2025-08-14, the last commit before the code was vendored).

## 1. Verdict

**Derived, for the version we ship.** The Signal code inside `whatsapp-rust-bridge` 0.5.4 was
copied from Signal's libsignal (AGPL-3.0-only), through a fork, and kept Signal's copyright and
`SPDX-License-Identifier: AGPL-3.0-only` headers in 31 files. The `license = "MIT"` label on
`wacore-libsignal` and on the npm package did not describe those files.

Upstream already accepts this. Issue
[oxidezap/whatsapp-rust#1828](https://github.com/oxidezap/whatsapp-rust/issues/1828) (opened
2026-11-01, "wacore-libsignal is published as MIT, but 31 of its files are AGPL-3.0-only") was closed
as completed by PR [#1842](https://github.com/oxidezap/whatsapp-rust/pull/1842) (merged
2026-11-05, "replace inherited Signal code with a storage-compatible sans-I/O engine"). That PR
removed the inherited files. **No released npm version of the bridge contains the rewrite yet:**
the latest is 0.5.5 (2026-05-14), and Baileys 7.0.0-rc14 pins 0.5.4.

So the answer has two parts:

| Code | Verdict | What it means for us |
|---|---|---|
| `whatsapp-rust-bridge` 0.5.4 (shipped in `sidecar.cjs` today) | **Derived** (AGPL-3.0-only parts) | The notice must say so now. |
| `wacore-libsignal` after #1842 (upstream `main`, not yet on npm) | **Unknown, leaning independent** | Upstream calls it a replacement. It is not a documented clean-room rewrite (same author, same storage format). Re-check when a bridge release that contains it reaches Baileys. |

## 2. Evidence (Deliverable 2, TC-2)

### E-1. The code was vendored from a libsignal fork, not written fresh

`whatsapp-rust` commit `6a3bcb00` (2025-08-15, "feat: vendoring libsignal") removes the dependency

```toml
libsignal-protocol = { git = "https://github.com/jlucaso1/libsignal", branch = "working" }
```

and adds 37 files (about 7,000 lines) under `wacore/src/libsignal/`. `jlucaso1/libsignal` is a fork
of `signalapp/libsignal`; its `working` branch still exists (`git ls-remote`, head `e361c8bc`).
Commit `9d61d1e0` (2025-10-16, "move libsignal to submodule") later moved the same files, unchanged
or lightly edited, to `wacore/libsignal/` as the `wacore-libsignal` crate. That is why
`git log --diff-filter=A -- wacore/libsignal` (the command in the ticket) shows 2025-10-16: it
finds the move, not the origin.

### E-2. Signal's copyright and AGPL headers came along

The vendoring commit contains 33 `Copyright … Signal Messenger, LLC.` lines, each followed by
`// SPDX-License-Identifier: AGPL-3.0-only`. At `95397408`, the revision 0.5.4 was built from,
**31 files** in `wacore/libsignal/src` still carry them, among them `core/curve.rs`,
`core/curve/curve25519.rs`, `crypto/aes_gcm.rs`, `protocol/session_cipher.rs`,
`protocol/group_cipher.rs`, `protocol/sender_keys.rs`, `protocol/ratchet.rs`,
`protocol/state/session.rs` and `protocol/identity_key.rs`. Example (`core/curve/curve25519.rs`):

```rust
//
// Copyright 2020-2021 Signal Messenger, LLC.
// SPDX-License-Identifier: AGPL-3.0-only
//
```

At upstream `main` today none are left (`git grep -il 'agpl\|Signal Messenger' HEAD -- wacore/libsignal`
returns nothing).

### E-3. The code matches Signal's file by file

File layout matches `signalapp/libsignal` `rust/protocol/src` and `rust/core/src` name for name
(`session_cipher.rs`, `group_cipher.rs`, `sender_keys.rs`, `ratchet/keys.rs`, `ratchet/params.rs`,
`state/session.rs`, `state/bundle.rs`, `identity_key.rs`, `curve/curve25519.rs`, …).

Share of distinct non-blank, non-comment, non-brace lines in each `wacore` file (at `95397408`)
that appear verbatim in the matching Signal file (at `9e2bcb2a`):

| `wacore-libsignal` file | Lines | Shared with Signal | Share |
|---|---:|---:|---:|
| `protocol/session_cipher.rs` | 409 | 308 | 75% |
| `protocol/identity_key.rs` | 103 | 72 | 69% |
| `core/curve/curve25519.rs` | 133 | 90 | 67% |
| `protocol/ratchet.rs` | 77 | 50 | 64% |
| `protocol/group_cipher.rs` | 182 | 103 | 56% |
| `core/curve.rs` | 293 | 128 | 43% |
| `protocol/state/session.rs` | 579 | 224 | 38% |
| `protocol/sender_keys.rs` | 385 | 116 | 30% |
| `protocol/ratchet/keys.rs` | 253 | 63 | 24% |

Across the whole crate (lines of 25 characters or more): **1,257 of 2,768 (45%)** match Signal at
`95397408`, against **152 of 6,565 (2.3%)** at upstream `main` after #1842. The remaining 2.3% are
generic Rust (`fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {`, derives, error variant
names), as expected for code that speaks the same protocol.

Identifiers and comments in `session_cipher.rs` match too. Shared functions: `message_encrypt`,
`message_decrypt`, `message_decrypt_prekey`, `message_decrypt_signal`,
`decrypt_message_with_record`, `decrypt_message_with_state`, `get_or_create_chain_key`,
`get_or_create_message_key`, `create_decryption_failure_log`, `append_session_summary`. Shared
comments, word for word, include "A PreKey message creates a session and then decrypts a Whisper
message", "Check for a completely empty or invalid session state before we do anything else." and
"Make sure we log the session state if we fail to process the pre-key."

No 8-byte hex test vectors are shared in `curve25519.rs`; the vendored copy dropped Signal's tests
there. Test vectors are therefore not part of the evidence.

### E-4. The binary we ship was built from exactly that revision

- `npm view whatsapp-rust-bridge@0.5.4 gitHead` → `a0b265b8` (2026-05-08, "fix: tsc errors blocking
  npm publish", `package.json` version 0.5.4). Its `Cargo.lock` pins
  `wacore-libsignal 0.3.0` at `git+https://github.com/jlucaso1/whatsapp-rust.git?branch=main#95397408…`.
- The two WASM modules inlined in the 0.5.4 tarball (`dist/index.js`, 721,354 and 738,926 bytes)
  contain Rust panic-location strings of the form
  `…/.cargo/git/checkouts/whatsapp-rust-<hash>/9539740/wacore/libsignal/src/protocol/session_cipher.rs`
  (also `group_cipher.rs`, `sender_keys.rs`, `session.rs`, `state/session.rs`, `protocol.rs`,
  `crypto/aes_cbc.rs`).
- Both base64 WASM strings from the tarball occur byte for byte in this repo's
  `sidecar/sidecar.cjs` (checked with `String.prototype.includes` on `main` at `343287f`).

So the AGPL-headed files of E-2 are compiled into the WASM we redistribute.

### E-5. Upstream's own answer

Deliverable 1 asked for an upstream issue. One already exists and is answered, so this spike did
not open a duplicate:

- [#1828](https://github.com/oxidezap/whatsapp-rust/issues/1828) asks exactly this question:
  crate metadata says MIT, 31 files say AGPL-3.0-only. Closed **completed** on 2026-11-05.
- [#1842](https://github.com/oxidezap/whatsapp-rust/pull/1842), by the maintainer, says it
  "replaces the Signal runtime", that "the inherited executable implementation [has] been removed",
  and "Closes #1828". Session, prekey and sender-key storage stays compatible, so existing logins
  survive.
- Upstream did **not** relicense or re-label the old releases. `wacore-libsignal` up to 0.7.0
  and bridge releases up to 0.5.5 still say MIT.

TC-3 (upstream silent) does not apply: upstream answered by action, not by a written comment.

## 3. What F-1 and F-4 must change (Deliverable 3, TC-4)

The plugin is GPL-3.0 (option C). GPL-3.0 §13 lets GPL-3.0 code be combined with AGPL-3.0 code
in one work. The AGPL-covered part keeps its own terms, including AGPL §13 (offer source to users
who interact with it over a network). The sidecar runs on the user's own machine and serves no
remote users, so §13's network clause is unlikely to bite in practice, but the notice still has to
state the AGPL terms. Counsel confirms (WAINBOX-85 §6.7).

### Verdict "derived", which applies to 0.5.4, the version we ship today

**F-1 (WAINBOX-112), notice text.** `sidecar/THIRD-PARTY-NOTICES` must:

1. List `whatsapp-rust-bridge` 0.5.4 as **"MIT AND AGPL-3.0-only"**, not MIT alone.
2. Include the full AGPL-3.0 text (<https://www.gnu.org/licenses/agpl-3.0.txt>) next to the
   GPL-3.0 text already planned for libsignal-node.
3. Add this entry (proposed wording):

   > whatsapp-rust-bridge 0.5.4 (inlined as WebAssembly in `sidecar.cjs`) is published as MIT,
   > Copyright (c) 2025 João Lucas de Oliveira Lopes. It contains the `wacore-libsignal` crate,
   > which includes code from Signal's libsignal: Copyright 2020–2024 Signal Messenger, LLC,
   > licensed under the GNU Affero General Public License v3.0 only. Corresponding source:
   > <https://github.com/oxidezap/whatsapp-rust/tree/95397408f84fda502c3bb2c755fda82a07cab055/wacore/libsignal>
   > (built through <https://github.com/jlucaso1/whatsapp-rust-bridge/tree/a0b265b852a916c35569da1b2046493c3c06c0db>).

   The full SHA `95397408f84fda502c3bb2c755fda82a07cab055` is confirmed with `git rev-parse` and
   matches the bridge's `Cargo.lock`.
4. Keep the fallback MIT text F-1 already plans: the npm tarball ships no `LICENSE`. Upstream's
   `LICENSE` reads "MIT License, Copyright (c) 2025 João Lucas de Oliveira Lopes".
5. Add a test check in F-1's generator: a package can carry more than one license, and
   `whatsapp-rust-bridge@0.5.4` maps to `MIT AND AGPL-3.0-only` through a local override, because
   its `package.json` says MIT.

**F-4 (WAINBOX-111), README statement.** The licensing section must add one sentence (proposed):

> The bundled sidecar (`sidecar/sidecar.cjs`) also contains WebAssembly built from
> `whatsapp-rust-bridge` 0.5.4, part of which is Signal's libsignal under the GNU AGPL v3.0 only;
> that part stays under the AGPL-3.0 when combined with this GPL-3.0 plugin (GPL-3.0 §13), and its
> source is linked from `sidecar/THIRD-PARTY-NOTICES`.

### Verdict "clean-room", which would apply only after a bridge release built on #1842 ships

- F-1: list the new bridge version as MIT only, with the MIT text. Drop the AGPL entry.
- F-4: no AGPL sentence. The GPL-3.0 statement for libsignal-node (until F-5 removes it) is enough.
- Before you switch: confirm the new release's `Cargo.lock` pins a `whatsapp-rust` revision
  **after** `1017f263` (#1842), and that `git grep -il 'Signal Messenger\|AGPL' <rev> -- wacore/libsignal`
  is empty.

### Verdict "unknown"

Treat it as derived: keep the "derived" notice and README sentence. Over-attributing costs one
paragraph. Under-attributing is the non-compliance WAINBOX-85 is closing.

## 4. Consequences for F-5 (WAINBOX-114, adopting the Rust replacement)

- WAINBOX-85 §4 warned that the "replacement" could be more copyleft than libsignal-node. **For
  every bridge release to date, it is:** AGPL-3.0-only in part, against GPL-3.0 for libsignal-node.
  Moving to it today would not remove copyleft. It would add the AGPL.
- After #1842 the replacement is plausibly MIT. Upstream removed the inherited code because of
  the licence report. Two caveats for counsel:
  1. It is **not a documented clean-room rewrite.** The same maintainer who vendored the AGPL code
     wrote the new engine, it keeps Signal's storage format (protobuf records) on purpose, and the
     PR does not describe a clean-room process. A storage format is usually treated as an interface,
     not expression, but that is counsel's call.
  2. No bridge or Baileys release contains it yet. F-5's trigger should be "a Baileys release whose
     `whatsapp-rust-bridge` is built from `whatsapp-rust` at or after `1017f263`", not merely "Baileys
     drops `libsignal`".

## 5. Open items for the team (not done in this spike)

- **Counsel (AC 4):** send §1 and §2 of this doc to counsel as the answer to WAINBOX-85 §6.7, and
  record the date in a comment on WAINBOX-115. The worker could not do that.
- **Link the upstream issue on WAINBOX-115 (AC 1):** #1828 and #1842 above.
- **Optional follow-up upstream:** ask the bridge maintainer on `jlucaso1/whatsapp-rust-bridge`
  whether a release built on #1842 is planned, and whether the earlier releases' metadata will be
  corrected. It is not needed for our notice.

## 6. How to reproduce

```bash
git clone https://github.com/oxidezap/whatsapp-rust wr
git clone --filter=blob:none https://github.com/signalapp/libsignal sl
cd wr
git show --stat 6a3bcb00                      # E-1: vendoring commit, removes the fork dependency
git grep -l 'SPDX-License-Identifier: AGPL-3.0-only' 95397408 -- wacore/libsignal | wc -l   # E-2: 31
git grep -il 'agpl\|Signal Messenger' HEAD -- wacore/libsignal                              # E-2: none
cd ..
npm view whatsapp-rust-bridge@0.5.4 gitHead   # E-4: a0b265b8…
npm pack whatsapp-rust-bridge@0.5.4           # extract the base64 WASM from dist/index.js, run `strings`
```

The E-3 overlap figures come from `sort -u` sets of trimmed lines (blank lines, `//` comments
and brace-only lines dropped) compared with `comm -12`, run under `LC_ALL=C`. They measure
verbatim reuse, not similarity, so they understate how much was copied and then reformatted.

## 7. Sources

- Upstream issue: <https://github.com/oxidezap/whatsapp-rust/issues/1828>
- Upstream rewrite: <https://github.com/oxidezap/whatsapp-rust/pull/1842> (merge commit `1017f263`)
- whatsapp-rust commits `6a3bcb00` (vendoring), `9d61d1e0` (move to `wacore/libsignal`),
  `95397408` (0.5.4's pin): <https://github.com/oxidezap/whatsapp-rust>
- Fork it was vendored from: <https://github.com/jlucaso1/libsignal> (branch `working`)
- Signal libsignal, AGPL-3.0-only: <https://github.com/signalapp/libsignal> (`rust/protocol/src`,
  `rust/core/src` at `9e2bcb2a`)
- whatsapp-rust-bridge: <https://github.com/jlucaso1/whatsapp-rust-bridge> (0.5.4 `gitHead`
  `a0b265b8`, `Cargo.lock`); npm `whatsapp-rust-bridge@0.5.4` (published 2026-05-08)
- Baileys 7.0.0-rc14 dependency: `npm view @whiskeysockets/baileys@7.0.0-rc14 dependencies` →
  `whatsapp-rust-bridge: 0.5.4`
- GPL-3.0 §13: <https://www.gnu.org/licenses/gpl-3.0.html#section13>. AGPL-3.0:
  <https://www.gnu.org/licenses/agpl-3.0.html>
- Prior spike: `docs/research/WAINBOX-85-libsignal-gpl.md` §4, §5 F-6, §6.7
