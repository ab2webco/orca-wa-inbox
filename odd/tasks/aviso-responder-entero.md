# aviso-responder-entero (WAINBOX-66)

## Objective

The owner's WhatsApp notice for a held `responder` (or `trabajar`) proposal shows the
whole proposed text, as the `escalar` notice does since WAINBOX-58, split into several
messages when long, and the approval stays bound to the version the notice showed.

## Scope

- `texto_de_aviso` (bin/wa-scope): no `recorta(..., LARGO_PROPUESTA)` on the proposal; the
  notice goes through `partes_de_aviso` (header lines, the proposal, the `como` line last).
- No change to the escalar path, the board, or the approval rules (version binding already
  lives in `aviso.version` and `version_superada`).

## Tasks

- [ ] R1 Tests (RED): a held `responder` longer than 300 characters arrives whole in one
  notice; a longer-than-one-message text arrives whole in parts with the question last;
  quoting a part approves and sends the text byte for byte; a stale version is refused.
- [ ] R2 wa-scope: `texto_de_aviso` uses `partes_de_aviso` (GREEN).
- [ ] R3 `npm run check` without shots, PR.

## Acceptance

- No proposal text is cut in the owner's notice; `…` never appears from a cut.
- Approving after the text changed is refused with the `cambio` message.
- Fake data only (public repo).

## Checks

- `scripts/check-casos`, the rest of the `check` chain without `npm run shots`. No panel is
  touched, so no shots.
