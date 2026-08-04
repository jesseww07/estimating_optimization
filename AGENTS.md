<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project rules — VE Estimator (Premier Lighting)

This is Premier Lighting's internal estimating substitution finder. Start with
`README.md`; deep context lives in `openwiki/quickstart.md` and `docs/*.md`.

- **This repo is PUBLIC.** Never commit customer bid workbooks, pricing data,
  or raw Airtable exports. Test fixtures use the already-committed frozen
  snapshots or synthetic data only.
- **Engine changes must pass the eval ratchet.** Anything under `lib/engine/`
  is measured: run `npm run eval` and review the per-case flip diff before
  pushing. Never run `npm run eval:update` to make a regression pass — the
  baseline only moves when a change is a deliberate, reviewed trade-off.
- **`lib/**` stays Next/React-free**, and `lib/engine/**` is additionally
  Airtable-SDK-free (pure TypeScript) — the engine must run identically in
  API routes, unit tests, and the eval harness. The Airtable SDK is used
  only by the adapters in `lib/airtable/`.
- **History write-back is create-only** and gated by `HISTORY_WRITEBACK`
  (unset = `live` in production, `dry_run` everywhere else). Never make
  non-production code paths write to the live History table.
- **Data lives in one Airtable base** (`appWj912AEOvtxqJF`): Premier Items,
  3rd Party Domestic Items, Fans, and History. Field IDs are pinned in
  `lib/airtable/` — don't guess field names.
- Pushes to `openwiki/update` deliberately skip Vercel deployments
  (`vercel.json` → `git.deploymentEnabled`); don't "fix" that.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
