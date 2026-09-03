# Decision template

Use one object per source Unit. `record` accepts a JSON array, one JSON object, or NDJSON.

## Common fields

```json
{
  "schemaVersion": 1,
  "runId": "prod-20260902",
  "part": 12,
  "packetId": "<64 lowercase hex>",
  "inputHash": "<64 lowercase hex>",
  "sourceUnitId": "<UUID>",
  "decidedAt": "2026-09-02T16:10:00.000Z",
  "actor": {
    "kind": "codex",
    "model": "<exact public model identity>",
    "promptRevision": "decision-policy-v2"
  },
  "confidence": "high",
  "reason": "duplicate_identity",
  "explanation": "The stored title '<exact excerpt>' matches the target title '<exact excerpt>'.",
  "evidenceUnitIds": ["<source UUID>", "<target UUID>"],
  "citations": [
    {
      "unitId": "<source UUID>",
      "field": "localization_title",
      "excerpt": "<exact stored source title>"
    },
    {
      "unitId": "<target UUID>",
      "field": "localization_title",
      "excerpt": "<exact stored target title>"
    }
  ]
}
```

Add exactly one disposition shape:

```json
{ "disposition": "keep" }
```

```json
{ "disposition": "merge", "targetUnitId": "<candidate Book UUID>" }
```

```json
{ "disposition": "soft_delete" }
```

```json
{
  "disposition": "revise",
  "patches": [
    {
      "kind": "credit_replacement",
      "role": "author",
      "removeAttributionId": "<stored attribution UUID or null>",
      "creditedUnitId": "<credited Unit UUID visible in packet>",
      "evidenceUnitIds": ["<Book or credited Unit UUID>"]
    }
  ]
}
```

```json
{
  "disposition": "review",
  "uncertainties": [
    {
      "kind": "candidate_identity_ambiguous",
      "detail": "The stored titles match, but the stored author credits conflict.",
      "relatedUnitIds": ["<candidate UUID>"]
    }
  ]
}
```

Allowed reasons are defined in `schemas/source-decision.schema.json`. Copy packet identity fields;
never retype them from memory. Citation excerpts must occur in their named stored fields, and the
explanation must mention at least one excerpt. A revision value must be directly supported by
stored packet evidence. The validator checks structure, grounding, and evidence membership;
semantic truth remains the reviewer and canary evaluation's responsibility.
