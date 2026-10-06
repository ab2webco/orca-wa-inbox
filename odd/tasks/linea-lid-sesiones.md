# A line that stores every message empty: Baileys 6 cannot decrypt LID sessions

Status: in progress (2026-10-06). Branch `fix/linea-sin-sesion`.

## Objective

A WhatsApp Business line linked to the sidecar stores every incoming message with an empty
body. The sidecar log shows, every ~5 s, `failed to decrypt message` with `No matching
sessions found for message` on the line's own LID, then a placeholder resend request that
the phone never answers. From contacts: `Key used already or never filled`.

The auth folder shows the cause: signal sessions are split between PN addressing
(`<pn>.0`) and LID addressing (`<lid>.0`). The phone answers in one addressing and
Baileys 6.7.24 looks the session up in the other. Baileys 7 maps a PN sender to its LID
before decrypting (`getDecryptionJid`), stores LID<->PN mappings from each stanza and
migrates PN sessions to LID (`lid-mapping` store, `migrateSession`).

Fix: move the sidecar from Baileys 6.7.24 to 7.0.0-rc14 and keep every existing behaviour.

## Scope

- Dependency pin (`scripts/deps.package.json`, the deps folder) and the `libsignal`
  override decision.
- Port `sidecar/src/*.js` to the v7 shapes: message keys (`remoteJidAlt`,
  `participantAlt`), contacts (`lid`, `phoneNumber`), group participants (`phoneNumber`).
- Socket options that v7 documents for retries: `getMessage` from the outbox, a
  process-wide `msgRetryCounterCache`, and `makeCacheableSignalKeyStore`.
- Auth folders written by 6.7.24 keep loading (no forced relink).
- Rebuild `sidecar/sidecar.cjs` within the plugin size and file limits.

Out of scope: version bump, push, PR. Testing against real WhatsApp (not possible here).

## Tasks

- [x] T1 — Pin Baileys 7.0.0-rc14, install, rebuild the bundle. Test in
      `sidecar-build.test.mjs`: the bundle carries the v7 decode path
      (`getDecryptionJid`, `lid-mapping`) and not 6.7.24.
      Proof: RED 5/8 (three v7 markers missing), GREEN 8/8 after install + rebuild.
      `libsignal` override kept as an exact pin: v7 already asks for `^6.0.0` from the
      registry (6.0.0 is the only 6.x), so it no longer fixes a git URL; it keeps the
      exact pin, like Baileys itself.
- [x] T2 — Message keys: `parDeMensaje` / `filaDeMensaje` read `remoteJidAlt` and
      `participantAlt` (v7). The 6.x names (`senderPn`, `participantPn`...) no longer
      arrive, so they are not read. Tests in `sidecar-mensajes.test.mjs` and
      `almacen.test.mjs` (keys moved to the v7 shape).
      Proof: RED 114/119 and 308/311, GREEN 119/119 and 311/311.
- [x] T3 — Contacts and group participants: `phoneNumber` (v7) feeds `lid_telefono` like
      `jid` did in 6.x. A contact with `id` in LID and `phoneNumber` names both chats.
      The v7 `lid-mapping.update` event and `lidPnMappings` of the history batch also go
      to `lid_telefono` (`ingerirParesLid`), never the owner's own pair.
      Tests in `sidecar-mensajes.test.mjs` and `almacen.test.mjs` (group metadata moved
      to the v7 shape).
      Proof: RED 116/119 and a missing `ingerirParesLid` export, GREEN 119/119 and
      317/317. Bundle rebuilt, sidecar-build 8/8, sidecar-pairing 105/105.
- [x] T4 — Retries: `getMessage` answers from the outbox (`envio`), a process-wide
      `msgRetryCounterCache`, keys through `makeCacheableSignalKeyStore`. Tests in
      `sidecar-pairing.test.mjs` / `envio.test.mjs`.
      `getMessage` looks up by line and stanza id only (`estado='enviado'`), since the
      retry key may come by LID for a message sent to a phone number. The retry cache
      is a small `Map` with a 1 h TTL in the `CacheStore` shape (no new dependency).
      Proof: RED (missing exports `mensajeDeEnvio`, `authDeSocket`), GREEN 112/112 and
      114/114. Bundle rebuilt.
- [ ] T5 — A 6.7.24 auth folder loads under v7: creds (`me`, registration) and the PN
      session are found. Test with a fake 6.7.24 fixture.

## Acceptance

- The bundle is built from Baileys 7.0.0-rc14 and decrypts through `getDecryptionJid`.
- LID/PN pairs from v7 keys, contacts and group metadata land in `lid_telefono`.
- Owner detection, mentions, quotes and chat ids behave as before (existing tests green).
- A 6.7.24 auth folder loads under v7 without relinking.
- Plugin tree stays under 2,000 files and 50 MB.

## Checks

check-panels, check-voseo, check-datos-reales, check-prompts, check-resolver,
check-harness, check-clis, check-closing, check-casos, check-lid, manifest, resolver,
userdata, build:sidecar, sidecar-build, sidecar-pairing, sidecar-mensajes, almacen,
envio, panels, worker. `npm run shots` is not run: nothing visual changes.
