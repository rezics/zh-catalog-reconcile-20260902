# Run artifacts

Each execution writes to `runs/<run-id>/`. The directory is deliberately inside the repository so
an operator can inspect, checkpoint, and archive a run as one unit. Its contents are ignored by
Git until a human reviews and explicitly stages a sanitized subset.

Expected layout:

```text
runs/<run-id>/
├── run.json
├── events.jsonl
├── inventory.json
├── packets/
│   ├── checkpoint.json
│   └── part-*.jsonl
├── decisions/
├── manifests/
└── reports/
```

Packet parts contain only the bounded online evidence actually presented to the model. This
workflow does not create a full-catalog snapshot or database mirror.

Never publish connection strings, session material, private Units, or raw database diagnostics.
