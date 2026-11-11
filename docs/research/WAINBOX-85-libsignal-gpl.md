# WAINBOX-85 — Is distributing the bundled GPL-3.0 libsignal acceptable?

> **Not legal advice.** This is an engineering spike. It records facts about the build and
> the options. Section 6 lists what a lawyer must confirm before anyone relies on it.

- Ticket: WAINBOX-85 (Spike, time-boxed S)
- Date: 2026-11-11
- Build examined: `main` at `a9bf3ba` (plugin v4.33.1), `sidecar/build.mjs`,
  dependencies from `scripts/deps.package.json` (`@whiskeysockets/baileys` 7.0.0-rc14,
  override `libsignal` 6.0.0)
- **Approver: pending — the owner (ticket Q1 default).** This spike recommends. It does not decide.

## 1. Short answer

**Not acceptable as shipped today.** The recommendation is **Option B now (comply), then
Option D once Baileys drops libsignal**:

1. Today `sidecar/sidecar.cjs` is one minified file that contains libsignal 6.0.0
   (GPL-3.0) alongside Baileys (MIT). It is distributed in a public repo and through the
   plugin marketplace.
2. The repo has **no license at all** (no `LICENSE` file; GitHub reports `licenseInfo: null`).
   It ships **no GPL text, no notice that GPL code is inside, and no source offer**.
   The esbuild legal-comment footer keeps only the Apache-2.0, BSD-3-Clause and MIT
   banners. Nothing in the bundle mentions the GPL.
3. Under the usual reading of GPL-3.0 §5(c), one statically bundled file is one
   "work based on the Program", so the whole bundle would have to be conveyed under GPL-3.0.
   That conflicts with a repo that grants no license. Whether the rest of the plugin
   (panels, `main.mjs`, Python tools, which talk to the sidecar over a process boundary)
   is also covered is the key question for counsel. It is probably not, but that needs confirming.

## 2. Bundled dependencies and licenses (Deliverable 1, TC-1)

How this list was made: esbuild ran with the exact options from `sidecar/build.mjs`, plus
`metafile: true, write: false`, so nothing was written to the repo. Every `node_modules`
input in the metafile was grouped by package root, and the license was read from each
package's `package.json`. `sharp` is `external` and is **not** bundled.

| Package | Version | License | Notes |
|---|---|---|---|
| **libsignal** | **6.0.0** | **GPL-3.0** | WhiskeySockets/libsignal-node; 14 files, ~89 KB of input |
| @whiskeysockets/baileys | 7.0.0-rc14 | MIT | ~6.0 MB of input |
| whatsapp-rust-bridge | 0.5.4 | MIT | WASM inlined in `dist/index.js`, ~2.0 MB (see §4) |
| long | 5.3.2 | Apache-2.0 | banner kept in the bundle |
| lru-cache | 11.5.3 | BlueOak-1.0.0 | |
| protobufjs | 7.6.6 | BSD-3-Clause | |
| @protobufjs/aspromise, base64, eventemitter, float, pool, utf8 | 1.0.2–1.1.2 | BSD-3-Clause | |
| @hapi/boom | 9.1.4 | BSD-3-Clause | |
| @hapi/hoek | 9.3.0 | BSD-3-Clause | |
| ieee754 | 1.2.1 | BSD-3-Clause | |
| @borewit/text-codec | 0.2.3 | MIT | |
| @cacheable/memory | 2.2.0 | MIT | |
| @cacheable/node-cache | 1.7.6 | MIT | |
| @cacheable/utils | 2.5.0 | MIT | |
| @keyv/serialize | 1.1.1 | MIT | |
| @pinojs/redact | 0.4.0 | MIT | |
| @tokenizer/inflate | 0.4.1 | MIT | |
| async-mutex | 0.5.0 | MIT | |
| atomic-sleep | 1.0.0 | MIT | |
| cacheable | 2.5.0 | MIT | |
| content-type | 2.1.0 | MIT | |
| curve25519-js | 0.0.4 | MIT | dependency of libsignal |
| debug | 4.4.3 | MIT | |
| eventemitter3 | 5.0.4 | MIT | |
| file-type | 21.3.4 | MIT | |
| hashery | 1.5.1 | MIT | |
| hookified | 1.15.1 and 2.2.0 | MIT | two copies (2.2.0 nested under qified) |
| keyv | 5.6.0 | MIT | |
| media-typer | 2.0.0 | MIT | |
| ms | 2.1.3 | MIT | |
| music-metadata | 11.16.1 | MIT | |
| on-exit-leak-free | 2.1.2 | MIT | |
| p-queue | 9.3.5 | MIT | |
| p-timeout | 7.0.2 | MIT | |
| pino | 9.14.0 | MIT | |
| pino-std-serializers | 7.1.0 | MIT | |
| qified | 0.10.1 | MIT | |
| quick-format-unescaped | 4.0.4 | MIT | |
| safe-stable-stringify | 2.5.0 | MIT | |
| sonic-boom | 4.2.1 | MIT | |
| strtok3 | 10.7.0 | MIT | |
| thread-stream | 3.2.0 | MIT | |
| token-types | 6.2.0 | MIT | |
| uint8array-extras | 1.6.0 | MIT | |
| win-guid | 0.2.1 | MIT | |
| ws | 8.22.2 | MIT | |

**53 package roots in total (52 names, since hookified appears twice). There is one copyleft
license (libsignal, GPL-3.0). Everything else is permissive** (MIT, BSD-3-Clause, Apache-2.0,
BlueOak-1.0.0). Apache-2.0 and BSD-3-Clause both require their notice to travel with the
binary. esbuild keeps `long`'s banner and `ieee754`'s, but no full license texts are shipped
for any package.

Caveat on completeness: the repo **does not track a lockfile** (`scripts/deps.package.json`
uses ranges such as `^0.25.0`, and the transitive tree resolves at install time). The list
is exact for the dependency tree installed when this spike ran. The metafile output was
5,464,757 bytes, while the committed `sidecar.cjs` is 5,455,369 bytes, so the committed
bundle was built from a slightly different tree or source. The list can drift without
anyone noticing. Follow-up F-3 fixes that.

### How libsignal gets in

- Baileys 7.0.0-rc14 declares `"libsignal": "^6.0.0"` as a runtime dependency. `scripts/deps.package.json`
  also pins it with `overrides`.
- Baileys calls it from `lib/Signal/libsignal.js`, `lib/Utils/crypto.js` and every file
  under `lib/Signal/Group/*`. It sits on the core message encrypt/decrypt path, so it
  cannot be dropped with a flag.
- libsignal's `package.json` says `"license": "GPL-3.0"` and its `LICENSE` file is the
  verbatim GPLv3. It describes itself as "Open Whisper Systems' libsignal for Node.js",
  which means the copyright traces back to Open Whisper Systems / Signal.

## 3. Options (keep / replace / relicense / split)

| | Option | What it means | Effort | Residual risk |
|---|---|---|---|---|
| **A** | **Keep as is** | Change nothing. | 0 | **High.** A GPL work is distributed with no license text, no notice and no source offer, inside a repo that grants no license. That is a straightforward GPL §4–§6 non-compliance and termination exposure (§8). It also clashes with "Orca Lab's official plugin" branding. |
| **B** | **Keep + comply** | Keep the bundle and meet GPL-3.0 for it: (1) ship `sidecar/THIRD-PARTY-NOTICES` with the full license texts (GPL-3.0, Apache-2.0, BSD, BlueOak, MIT); (2) state that `sidecar.cjs` as a whole is conveyed under GPL-3.0; (3) supply the Corresponding Source, which is `sidecar/src`, `build.mjs`, `scripts/deps.package.json` **plus a committed lockfile**, in the public repo (§6(d), "equivalent access ... from the same place") and point to it from the notice; (4) give the repo an explicit license for non-sidecar code that is compatible with this setup. | S–M (1–2 days, plus counsel) | **Low–medium.** Lawful if counsel agrees with the boundary. Side effect: anyone may redistribute and modify `sidecar.cjs` under GPL-3.0. That is acceptable because the sidecar is a thin Baileys wrapper with no trade secrets. Counsel must confirm the process boundary keeps the rest of the plugin outside the GPL work. |
| **C** | **Relicense (whole plugin GPL-3.0)** | License the whole repo under GPL-3.0. | XS (code), but a business decision | **Low** legally, but the most restrictive for Ab2Web/Orca: every downstream fork of the plugin has to stay GPL. Only worth it if the owner wants the plugin open source anyway. |
| **D** | **Replace** | Remove libsignal from the bundle. (D1) Wait for Baileys to finish moving to its own Rust/WASM Signal code (the rc11 notes say this is planned), then upgrade. (D2) Do it ourselves: patch/alias Baileys' `lib/Signal/*` onto `whatsapp-rust-bridge`'s Signal API, which the bridge README lists as supported. (D3) Move transport to another MIT library. | D1: XS when it lands, but **no date**. D2: L (crypto/session-store compatibility, high regression risk on encrypt/decrypt, migrating existing paired sessions). D3: XL. | D1: none once landed, but the exposure stays open until then, so it must be paired with B. D2: high engineering risk on the hottest path, and we would maintain a fork. D3: rewrite. Also see §4: the replacement's own provenance must be checked first. |
| **E** | **Split the bundle** | Build libsignal (and curve25519-js) as a separate, unminified file (`sidecar/vendor/libsignal/` with its `LICENSE` and source), loaded at runtime with `require`, so the main bundle no longer contains GPL code. | S (`build.mjs`: `external: ['libsignal']` plus a copy step; the 50 MB / 2,000-file limit is fine because it's 14 files) | **Medium.** It makes source, notice and replacement easy. But under the FSF's view, dynamic linking in one process still forms one combined work, so it **does not by itself** take the sidecar out of GPL-3.0. Use it as a way to deliver B more cleanly, not as a substitute for B. |

### Recommendation

1. **Now: B, delivered through E** (split + notices + source + lockfile + an explicit repo
   license). This closes the open non-compliance at low cost and keeps the GPL scope
   visibly limited to the sidecar process.
2. **Track D1.** When Baileys releases a version without the `libsignal` dependency, upgrade
   and drop the GPL notice. Do **not** start D2 unless D1 stalls for a long time and the owner wants it.
3. **Reject A.** Choose C only if the owner independently wants the plugin GPL.

## 4. Watch-out: whatsapp-rust-bridge and the "Rust replacement"

- `whatsapp-rust-bridge` 0.5.4 says it is MIT, and so do its upstream (`jlucaso1/whatsapp-rust`,
  now under `oxidezap/whatsapp-rust`) and the `wacore-libsignal` crate (`Cargo.toml`: `license = "MIT"`).
- Signal's official Rust **libsignal is AGPL-3.0**. If any of `wacore-libsignal` was ported
  or copied from it, rather than written clean-room, the MIT label would not hold, and the
  "replacement" would be *more* copyleft (AGPL) than what it replaces. This spike found **no
  attribution either way**. The crate gives no origin note.
- The bridge is **already bundled today**, inlined as WASM, so this matters for the current
  build too, not just for D1.
- The npm package ships only built `dist/index.js` (with the WASM) and no `LICENSE` file,
  so even the MIT notice is missing from what we redistribute.

## 5. Follow-up items (Deliverable 3)

- **F-1 Ship third-party notices for the sidecar.** AC: `sidecar/THIRD-PARTY-NOTICES` (or
  similar) lists every package in §2 with its license text. It is generated from the esbuild
  metafile so it can't drift. `test/sidecar-build.test.mjs` fails if a bundled package is missing from it.
- **F-2 Split libsignal out of `sidecar.cjs` (Option E).** AC: `sidecar.cjs` no longer contains
  libsignal code. `sidecar/vendor/libsignal/` holds the unminified source and the GPL `LICENSE`.
  Pairing, send and receive tests (`sidecar-pairing`, `sidecar-mensajes`, `envio`) pass.
  The plugin stays under 50 MB and 2,000 files.
- **F-3 Commit a lockfile for the sidecar dependency tree.** AC: `scripts/setup.mjs` installs
  from a tracked lockfile (`npm ci`), and rebuilding `sidecar.cjs` from a clean clone reproduces
  the committed bundle byte for byte, or the difference is documented.
- **F-4 Give the repo an explicit license and a GPL scope statement.** Needs an owner decision.
  AC: a `LICENSE` exists at the root. The README states that `sidecar/` (built output) is
  distributed under GPL-3.0, with a link to the Corresponding Source.
- **F-5 Track Baileys' libsignal removal (Option D1).** AC: an issue is subscribed to the Baileys
  releases. When a release drops `libsignal`, the upgrade ticket is opened and F-1/F-4 are revised.
- **F-6 Provenance of `wacore-libsignal`.** AC: a written answer from upstream (an issue on
  `oxidezap/whatsapp-rust`) or a code comparison stating whether it derives from Signal's AGPL libsignal.

## 6. What a lawyer must confirm

1. Whether a single esbuild bundle that contains Baileys (MIT) and libsignal (GPL-3.0) is one
   "work based on the Program" that has to be conveyed entirely under GPL-3.0 (§5(c)).
2. Whether the rest of the plugin, which talks to the sidecar only through a child process
   and IPC, is "separate and independent" or an "aggregate" (§5, last paragraph). If so, it can
   stay under any license.
3. Whether a public GitHub repo with the source, build script and lockfile meets §6(d)
   "Corresponding Source ... from the same place" for copies distributed through the Orca
   plugin marketplace. Otherwise a written offer (§6(b)) is needed.
4. Whether Option E (a separate file in the same process) changes anything legally.
5. Whether the past distribution without notices needs any remedy beyond curing it now
   (§8 lets rights be reinstated after a cure within 30 days of notice).
6. Whether marketplace terms or any Orca Lab / Ab2Web licensing policy conflict with
   distributing GPL-3.0 code at all.
7. The provenance question for `wacore-libsignal` / whatsapp-rust-bridge (§4) and the
   implications if it is AGPL-derived.
8. Separately from copyright: whether WhatsApp's Terms of Service (unofficial clients) carry
   risk. That is out of scope here but belongs in the same review.

## 7. Sources

- libsignal-node (GPL-3.0): <https://github.com/WhiskeySockets/libsignal-node>. Locally:
  `node_modules/libsignal/package.json` (`"license": "GPL-3.0"`) and `LICENSE` (GPLv3 text).
- Baileys (MIT): <https://github.com/WhiskeySockets/Baileys>. Local `package.json` of
  7.0.0-rc14 declares `"libsignal": "^6.0.0"` and `"whatsapp-rust-bridge": "0.5.4"`.
- Baileys v7.0.0-rc11 release notes: "We are working on migrating away from the libsignal dep
  as soon as possible to our own Rust-based equivalent ... libsignal is in GPLv3 but Baileys is
  under MIT". rc10 lists integrating whatsapp-rust-bridge into Baileys.
  <https://github.com/WhiskeySockets/Baileys/releases>
- whatsapp-rust-bridge (MIT): <https://github.com/jlucaso1/whatsapp-rust-bridge>
- whatsapp-rust / wacore-libsignal (MIT): <https://github.com/jlucaso1/whatsapp-rust>,
  `wacore/libsignal/Cargo.toml`
- Signal libsignal (Rust, AGPL-3.0): <https://github.com/signalapp/libsignal>
- GPL-3.0 text: <https://www.gnu.org/licenses/gpl-3.0.html>. FSF FAQ on linking and
  aggregates: <https://www.gnu.org/licenses/gpl-faq.html#GPLStaticVsDynamic>,
  <https://www.gnu.org/licenses/gpl-faq.html#MereAggregation>
- Repo facts: `sidecar/build.mjs` (bundle, minify, `external: ['sharp']`),
  `scripts/deps.package.json`, `gh repo view` → `visibility: PUBLIC`, `licenseInfo: null`.

## 8. Decision record

| Field | Value |
|---|---|
| Option recommended | B via E now, then D1 |
| Option chosen | **pending owner** |
| Approved by | **pending owner** (ticket Q1 default: the owner) |
| Legal review | **pending** (see §6) |
