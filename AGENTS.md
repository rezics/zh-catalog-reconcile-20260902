# Repository agent instructions

This public repository prepares and records the one-time REZICS Chinese-only metadata catalog
reconciliation. Read `PLAN.md` and the repository skill before changing or running the workflow.

## Hard boundaries

- Treat a Book as a cleanup source only when its complete `unit_localization.language` set is
  exactly `{zh}`. A Book with any other metadata language, especially `ja`, is protected from
  source-side merge, revision, and deletion.
- Use only data already stored in REZICS. Do not browse, fetch, or validate third-party book,
  author, publisher, ISBN, or external-link data. A hosted model may receive REZICS evidence for
  inference, but it must not retrieve external evidence.
- This repository has no production write implementation. It may produce a validated action
  manifest, but it must not mutate REZICS. Production application belongs in a separately
  reviewed REZICS maintenance command that calls the owning domain services.
- Never commit credentials, cookies, tokens, database URLs, raw production evidence packets, or
  unreviewed model prompts and outputs. Run artifacts belong under `runs/<run-id>/` and are
  ignored by default.
- Never infer facts that the stored evidence does not prove. Use `review` rather than inventing a
  title, author, identifier, date, or merge target.

## Engineering rules

- Use typed runtime schemas at every database, JSONL, and model-output boundary.
- Preserve `updatedAt` values through action planning so the future executor can reject stale
  writes.
- Keep corpus work keyset-paginated, resumable, sharded, and bounded. Design for 500,000,000
  rows and estimate 3,000,000,000 rows; never load the full corpus into one process.
- Keep JSONL append-only. Derive corrections through new events or decisions rather than
  rewriting historical evidence.
- Use `apply_patch` for hand-authored changes. Run `bun run check` and the skill validator before
  handing off.
