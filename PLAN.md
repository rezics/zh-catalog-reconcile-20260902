# Production reconciliation plan

Status: **prepared; production reads allowed only through the guarded runner; writes not authorized**

Owner repository: `rezics/zh-catalog-reconcile-20260902`

Production contract observed: REZICS server `v1.7.0` surface on 2026-09-02; verify the immutable
server image digest and database migration head again before any apply phase.

## Canonical plan and current run

This `PLAN.md` is the repository's single authoritative work plan. The repository Skill,
architecture, decision policy, decision template, and runbook are supporting contracts and
procedures; they are not separate plans.

The current replacement execution is `full-online-luna-v6-20260904`: a fresh run from the
beginning with REZICS reference `v1.7.0`, cutoff `2026-09-02T16:00:00.000Z`, page size 256,
`evidence-claims-v3`, and the `full-online-luna-v6` worker protocol. It must use no source-start
cursor and no `--after-run`. Initialize it only if that run ID does not already exist; otherwise,
verify the persisted configuration before resuming. The exact guarded commands are maintained in
[`docs/runbook.md`](./docs/runbook.md).

Preserve historical artifacts but never resume or use them to skip source ranges:

- `rehearsal-online-10000-after-1000-20260903` contains untrusted deterministic decisions,
  including known false soft-deletes.
- `full-online-luna-20260904` used the superseded v1 proposal protocol.
- `full-online-luna-v2-20260904` captured 64 packets and recorded zero decisions before the v2
  citation-linkage contract failed.
- `full-online-luna-v3-20260904` recorded 1,920 decisions before a query-fragment contradiction
  exposed ambiguous retry guidance. Its artifacts remain audit-only and must not be resumed.
- `full-online-luna-v4-20260904` recorded 128 decisions and captured 192 packets before its
  32-by-2 single-part execution was stopped for throughput remediation. Its artifacts remain
  audit-only and must not be resumed.
- `full-online-luna-v5-20260904` recorded 4,864 decisions and captured 5,888 packets while
  validating the first pipelined triage design. Its measured 307–311 decisions/minute missed the
  five-hour threshold, so its artifacts remain audit-only and must not be resumed.

Run until the fixed-cutoff population has exact decision coverage, unless the operator stops it or
a safety, quality, connection, or allowance failure requires a resumable stop. Completion ends at
a validated manifest; production mutation remains out of scope.

## Objective

Reconcile published REZICS Books whose current complete metadata-localization language set is
exactly `{zh}`. Preserve real works, merge duplicate identities, soft-delete records that are not
Books, and propose evidence-backed metadata or attribution revisions. Read sources and candidates
online from REZICS; do not retrieve external metadata or copy the complete catalog locally.

## Invariants

1. A mutation source has exactly one distinct localization language, `zh`, when its packet is read.
2. A Unit with `ja` or any non-`zh` localization is protected. It may only be a merge target.
3. Selection uses `unit_localization.language`, never `contentLanguageSupport` or title script.
4. Every decision is bound to an immutable evidence packet hash and source `updatedAt`.
5. AI text is untrusted until it passes the generated runtime schema and semantic validator.
6. A merge target must occur in the packet's REZICS-derived online candidate set.
7. Unknown evidence produces `review`, not an invented correction.
8. Duplicate identities use Unit Merge. Non-Book junk uses Unit lifecycle soft-delete. Catalog
   quality errors do not use moderation removal.
9. Production writes use REZICS domain services and governance audit records, never ad hoc SQL.
10. This repository stops after a validated, complete action manifest.

## Phase 0 — freeze the run contract

- Record the deployed server image digest, root release tag, database migration head, creation
  cutoff, operator identity, model identity, prompt revision, and repository commit in `run.json`.
- Require `decisionPolicyRevision: "evidence-claims-v3"` for every new decision-producing run.
  Runs without that field are interpreted as `legacy-v1`; `evidence-grounded-v2` and `legacy-v1`
  runs remain available for audit but cannot be resumed or used to generate a manifest. Start a
  new run rather than rewriting their JSONL.
- Require a full Luna run to pin the `full-online-luna-v6` worker protocol in `run.json`. Runs that
  omit it, or pin another model, prompt, or proposal protocol, cannot start `work`; preserve them
  and initialize a fresh full run rather than mixing decision actors.
- Require `evidenceMode: "online-batched"`. Legacy runs without this field are incompatible and
  must not be resumed.
- Prefer a dedicated database role with `CONNECT`, catalog `SELECT`, and permission to execute the
  bounded REZICS candidate-search function. The monitoring profile is the default. If it lacks
  catalog access, an operator may explicitly select the existing runtime profile only through
  this runner: require connection-startup `default_transaction_read_only=on`, issue a
  repeatable-read, read-only transaction for every batch, and prove both settings live. Never use
  `DATABASE_ADMIN_URL`.
- Run `bun run reconcile doctor`, `bun run check`, and the repository Skill validator.
- Confirm `.env` and the run directory are ignored by Git.

Stop if the live production relations, candidate-search signature, or runtime schemas differ from
the query contract in `sql/`.

## Phase 1 — online inventory

Run the one-time aggregate inventory in a read-only transaction. Record:

- public, approved, active Book count created by the cutoff;
- current exact-`zh` source count;
- Books currently containing `ja`;
- Books with no localization;
- current localization-language-set distribution;
- earliest/latest source creation timestamps.

Inventory is a planning count, not a catalog export. Stop on proof failure, schema drift, or an
exact-`zh` count of zero.

## Phase 2 — online evidence and decisions

Repeat `next` and `record` until the online source cursor is complete:

1. Return already-persisted undecided packets before touching production.
2. When none remain, select at most `onlineBatchSize` exact-`zh` sources using the indexed
   `(created_at, id)` keyset and the immutable creation cutoff.
3. In the same short transaction, use the existing bounded REZICS text search to obtain Book
   candidate IDs for each source. Batch the calls in one database round trip; never issue an
   application-level N+1 sequence.
4. Read full metadata and credit evidence only for the selected sources and candidate IDs.
5. Parse database results through `BookEvidenceSchema`, compute `evidenceHash`, close the
   transaction, and atomically write one packet-part file.
6. Let the AI decide only after the database transaction has closed. Append validated decisions
   through `record`.

For full-corpus execution, `work` owns orchestration: one coordinator performs steps 1–6 while
bounded ephemeral Luna workers evaluate disjoint packet subsets concurrently. Total work is not
count-limited. Worker concurrency never multiplies database transactions or writers.

Each packet currently contains one source and at most `maxCandidatesPerPacket` total Books. The
source is always included. Candidate ranking may prefer multilingual/`ja` records, identifiers,
richer metadata, and older stable records, but ranking never makes a decision.

There is no `snapshot` command and no `snapshot/books.jsonl`. The durable artifacts are only the
evidence packets actually presented to the model, their cursor/checkpoint, decisions, and logs.
Part files are created atomically. On resume, the runner reconstructs source count and cursor from
validated parts, so a crash between a part rename and checkpoint update does not duplicate rows.
A run-wide capture lock rejects concurrent `next` fetches.

## Phase 3 — AI decision policy

Use the repository Skill and [`docs/decision-policy.md`](./docs/decision-policy.md). For every
source choose exactly one:

- `keep`
- `merge`
- `soft_delete`
- `revise`
- `review`

The model receives only packet evidence. It must not browse or call a third-party metadata API.
Record the exact public model/version identity and prompt revision.

Quality gates:

- schema-invalid decision rate: 0%;
- every decision cites exact stored packet evidence;
- every routine action uses typed English basis codes, each linked to compatible citations;
- every `keep` cites a Book-like title plus synopsis, attribution, or identifier corroboration;
- every `merge` cites a shared identifier, an explicitly stated title variant, a matching synopsis
  excerpt of at least 64 normalized characters, matching synopsis and attribution, or title
  correspondence plus corroboration;
- every `review` records typed uncertainties linked to source and related-candidate citations;
- free-form notes occur only for an explicit `other` reason or uncertainty;
- legacy repeated or evidence-substituted explanation templates: 0;
- a complete part containing only low-confidence `insufficient_evidence` reviews pauses the run;
- decision coverage: exactly one per discovered source;
- non-`zh` mutation-source leakage: 0;
- merge target outside packet: 0;
- high-confidence canary disagreements during human review: below 2%;
- every `revise` patch names stored evidence and remains human-approved at apply time.

## Phase 4 — manifest generation

- Require the online source cursor to be complete and every discovered source to have one decision.
- Require `reports/decision-quality.json` to pass. Manifest compilation evaluates quality in the
  same streaming pass used to compile actions, so it does not add another whole-corpus scan.
- Compile decisions into typed actions with expected timestamps and deterministic idempotency keys.
- Produce no action for `keep` or `review`.
- Mark every revision proposal and medium/low-confidence mutation as requiring human approval.
- Produce counts by action, confidence, reason, protected-target use, and source creation window.

The completed manifest is the terminal output of this repository.

## Phase 5 — production apply (deliberately out of scope)

Before apply, add a release-reviewed maintenance command to the main REZICS repository. It must:

- parse these generated schemas;
- re-read each Unit and reject stale timestamps;
- re-prove exact-`zh` source eligibility at write time;
- map semantic reasons to current governance rule IDs;
- call the existing Unit Merge, revision/association, and platform soft-delete services;
- record the AI contribution Entity and all governance/audit identifiers;
- support dry-run, bounded canaries, idempotent retries, backpressure, pause, and restore;
- verify search projection convergence after each batch.

Production application requires new, explicit authorization after review of the manifest and the
REZICS-side executor. Approval of this plan is not approval to apply it.

## Rollout and rollback

1. Apply 100 reviewed actions from the 天蚕土豆 neighborhood.
2. Verify redirects, attributions, soft-delete visibility, revisions, search results, and audit.
3. Apply 1,000 actions with write concurrency at most four and a lower database-pressure limit.
4. Continue by manifest partition while monitoring error and staleness rates.
5. Pause on any invariant violation, more than 1% stale actions, or repeated service errors.

Soft-deletes are restored through Unit lifecycle. Incorrect merges require the REZICS merge
reversal/cutover procedure defined by the production executor; never repair them with manual SQL.

## Workload and capacity model

Current workload assumptions:

- roughly 100,000–150,000 exact-`zh` sources within roughly 400,000 public Books;
- one indexed source keyset scan across the run;
- one bounded PGroonga candidate lookup per source, issued in database batches rather than N+1
  client round trips;
- one bounded evidence query per batch using primary/foreign-key lookups;
- one short repeatable-read transaction per newly captured source batch;
- no database connection or transaction remains open during model inference;
- packet writes are immutable and apply backpressure naturally because only one undecided batch is
  fetched at a time.

At 500,000,000 sources, a batch size of 64 implies 7,812,500 nonempty batch transactions; at
3,000,000,000 it implies 46,875,000, plus at most one terminal empty read per partition. A single
workstation and repo-local packet directory are not
acceptable at those scales. Partition the `(created_at, id)` keyspace across independent workers,
store immutable packet parts in durable object storage, aggregate checkpoints externally, and
rate-limit candidate searches per database shard. Increase database batch size only after
representative `EXPLAIN (ANALYZE, BUFFERS)` and latency measurements; do not hold transactions open
to amortize AI latency. Packet hashes and source keysets remain compatible with that cutover.

The limiting resource at those scales is the one-candidate-search-per-source workload, followed by
model inference and packet storage. Observable thresholds are candidate-search p95 latency,
estimated-postings fallback rate, database CPU/read IOPS, transaction timeout rate, packet-store
growth, and decision backlog. Pause capture when these exceed the approved operating envelope.

For the current task, online batches keep database work bounded and eliminate the unnecessary
complete local catalog copy.

Decision execution keeps at most eight packet parts (2,048 sources maximum at the selected page,
20 candidates per packet) active in memory. Recording checks only the affected part. `audit` is an optional streaming O(N) pass
with fixed-size counters and at most 100 sampled issues; manifest generation performs the same
quality aggregation while already streaming decisions, not as a second pass. At 500,000,000 or
3,000,000,000 sources, audit and manifest work partition by packet-part range and aggregate their
fixed-size summaries alongside the packet-storage sharding described above.

The model no longer repeats natural-language explanations, source Unit IDs, and cited titles in
the same field. Full-run workers attach exact citations directly to each typed basis or uncertainty;
the coordinator deduplicates those citations and derives the persisted citation indexes. The v6
prompt renders the same basis claim contract used by deterministic validation, including required
source, target, and non-source-candidate roles. Retries receive bounded typed categories and issue
codes rather than raw validation messages or Unit IDs. Query-fragment contradictions receive a
dedicated issue code that requires semantic reconsideration when stored Book-shaped evidence is
present. This makes unlinked worker citations
structurally impossible while keeping routine output bounded and preserving the full immutable
packet and exact citation excerpts for audit.

Validated decisions completed before another worker in the same part exhausts retries are appended
before the run fails, so a resume does not recompute successful semantic work.
For citation-only model transcription failures, the coordinator may restore the source's unique
equal-length stored title selected by a keep proposal's `booklike_title` claim and propagate that
exact substitution within the same proposal; other title citations require a unique one-character
near match. Every restored citation must still pass the ordinary validator. Stored synopsis text
may support `title_variant_same_work` only when it explicitly states the alternate title.
Citation matching ignores formatting whitespace but not other content. When a model transcribes a
merge target outside the packet, the coordinator may restore it only when all non-source basis
citations identify exactly one packet candidate; the repaired proposal then passes normal binding.
If a proposal contains an invalid redundant basis, the coordinator may omit it only when a
remaining non-empty basis subset independently passes every disposition and citation validator.

The Luna coordinator defaults to at most 128 total in-flight requests, four packets per full
decision request, 20 packets per guarded classification request, and eight active packet parts. The
operator's execution host is a Fedora Threadripper 3970X with
32 cores / 64 threads and 64 GB RAM; the separate database host has 16 cores and 64 GB RAM. These
are operator-provided specifications, not measured utilization. Workers use ChatGPT authentication,
standard (non-Fast) service, medium reasoning, and an isolated tool-free Codex configuration. The
coordinator performs one startup verification and one final audit; periodic progress is
incremental rather than a repeated whole-run scan. At 500,000,000 or 3,000,000,000 sources, even
the triage/full two-stage inference workload remains a partitioned service workload rather than
an acceptable single-workstation run.
The packet-keyspace and object-storage cutover above remains required at that scale. The current
local command bounds active processes and pending packet count, while process startup overhead,
model rate limits, packet byte sizes, and candidate-search latency remain observable bottlenecks.

New runs persist the page size selected by `init --online-batch-size` (1–256, default 64). Existing
runs keep their original size. At the default candidate limit of 20, the selected 256-source page
requests at most `256 × (20 + 1) = 5,376` evidence Book IDs before deduplication; final packets
contain at most 20 Books including the source. There is one database connection and a bounded
eight-part pipeline, never an unbounded prefetch queue.
Neither the worker count nor packet batching multiplies database transactions.

The v6 worker first asks Luna for a compact five-way semantic classification in groups of 20. A
fast-path keep is accepted only when the model reports high-confidence `keep/distinct_work`, the
packet contains the source and no other candidate, the stored suspicious-signal set is empty, and
the coordinator can mechanically construct and validate booklike-title plus synopsis, author, or
identifier citations. Every other, malformed, uncertain, candidate-bearing, or unsupported result
goes through the complete v6 decision
prompt in groups of four. Full-output validation retains valid per-source proposals and retries
only rejected sources. Capture, triage, complete decisions, and recording overlap across at most
eight parts, while one shared semaphore caps all model requests at 128. With a 256-source page, the
local evidence backlog is bounded at 2,048 sources.

Four-packet requests amortize fixed prompt and process-startup overhead. Ignoring general Codex
configuration and project instructions avoids duplicating unrelated plugins, MCP tools, and
repository context. The 128 input limits of 512,000 bytes sum to 65,536,000 bytes, and the 128
output limits of 1,000,000 bytes sum to 128,000,000 bytes. These are payload boundaries, not token counts
or total RAM estimates; coordinator objects, child processes, and model-harness memory are
additional and must be measured.
Do not claim a proportional speedup: part barriers, request latency, rate limits, and database
capture time determine sustained throughput. The shared request semaphore, 64-request guarded-classification
limit, eight-part window, and mix of triage/full work determine effective concurrency.

The read-only `probe` command measures a page without storing evidence or changing checkpoints.
It runs each SELECT normally and again with EXPLAIN ANALYZE; diagnostic elapsed time includes both
executions and connection setup. Compare normal round trips separately from EXPLAIN execution,
which may have warmer caches and does not deliver the evidence result. The probe rejects scan
nodes whose observed base-table/index traversal exceeds the candidate bound, considering
filtered-out rows and per-loop rounding. This is a regression canary, not a proof of every
internal operation inside the search function.

Read-only production canary on 2026-09-04, using the existing Windows SSH-stdio path and the
next uncaptured cursor in `rehearsal-online-10000-after-1000-20260903`:

| Query version / page | Sources / evidence Books | Candidate Book traversal | Candidate Unit traversal | Candidate EXPLAIN execution |
| --- | --- | --- | --- | --- |
| Original / 20 | 20 / 78 | 412,834 index rows | — | 69.351 ms |
| Original / 64 | 64 / 194 | 418,846 index rows | — | 96.428 ms |
| Book-only lateral / 64 | 64 / 194 | 189 ID lookups | 418,803 index rows | 334.024 ms |
| Both lateral proofs / 64 | 64 / 194 | 189 ID lookups | 189 ID lookups | 46.029 ms |

Linux read-only scaling probes on 2026-09-04 used the next cursor of the preserved v4 run. A
100-source probe returned 282 evidence Books in 11.159 seconds; a 256-source probe returned 569
evidence Books in 20.762 seconds. The 256-source candidate plan used 502 Book and 503 Unit bounded
ID lookups, 0 shared-read blocks, and 0 temporary blocks; candidate EXPLAIN execution was
177.928 ms. Two 512-source attempts failed in the local postgres.js/SSH socket path before a
validated profile could be returned, so 512 is rejected and the runtime maximum remains 256.

The v5 triage was benchmarked against all 1,920 persisted v3 decisions without saving model
responses. In two full passes, it processed 1,800 successfully assigned sources at 974–1,019
sources/minute, accepted 964–1,024 routine keeps, and agreed with the historical disposition for
99.4%–99.7% of accepted keeps. Assignment-invalid batches fell back safely. This is a regression
baseline, not human ground truth; the production fast path is stricter because it also rejects
every packet with a non-source candidate. With roughly half the corpus routed to full decisions,
the measured stage capacities support a pipelined estimate above the required 455 decisions/minute
for a five-hour run. The first production parts must confirm sustained end-to-end throughput;
pause rather than claim the target if it remains below the threshold.

The v6 guarded classifier was then benchmarked over all 1,920 persisted v3 decisions, again
without saving prompts or model outputs. With 20-source requests it assigned 1,780 sources in
85.003 seconds (1,256.4 assigned sources/minute); seven malformed assignment batches fell back
safely. The deterministic fast-path guards accepted 1,086 keeps; 1,081 agreed with the historical
keep disposition, for 99.54% precision. The five disagreements are why
the classifier is not itself a decision worker: only its narrowly guarded keeps bypass the full
worker, and every other result falls back. This matches the measured 99.4%–99.7% v5 triage
precision while raising guarded acceptance from roughly 45% in the v5 production canary to about
59% in the historical benchmark. Historical decisions are a regression baseline, not human truth;
the v6 production canary must still demonstrate at least 455 end-to-end decisions/minute.

The final 64-source plan used 1,684 shared-hit blocks for candidate search, no disk-read blocks,
and no temporary spill. Source and evidence EXPLAIN execution were 0.531 and 13.468 ms. Normal
round trips were 1,250.263, 1,236.685, and 11,432.600 ms respectively; this difference includes
result delivery, serialization, transport behavior, and cache effects, not demonstrated database
CPU saturation. Total diagnostic elapsed time was 25.211 seconds. One earlier attempt failed in
the Windows postgres.js socket-write path; a retry completed, and no root cause for that transient
transport failure is established. No historical run configuration, evidence, or cursor changed.

The SQL change preserves unique-ID membership and eligibility filters, but prevents the observed
whole-index join strategies. No production indexes or server settings were changed. These samples
do not establish Fedora throughput, p95 latency, or 32-worker Luna capacity. The 500-million and
3-billion capacity estimates above remain partitioned-workload planning, not a completed benchmark.

## Completion criteria

Preparation is complete when repository checks pass, the Skill validates, fixture recovery tests
pass, and a live read-only canary creates bounded packets without a catalog export. Production
execution is complete only after the separately authorized apply and post-run verification.
