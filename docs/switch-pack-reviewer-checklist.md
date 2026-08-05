# Pack reviewer switch checklist

Use this checklist for a persistent reviewer change.

## 1. Inspect

```bash
npm run --silent pack-reviewer-config -- status
```

Confirm the preference path, saved reviewer, effective reviewer, and any
legacy `PACK_REVIEWER` value.

## 2. Persist

```bash
npm run --silent pack-reviewer-config -- set <gpt|codex|claude>
```

The command validates and verifies the persistent user preference. It does not
set a temporary environment override or restart a runtime.

## 3. Verify

```bash
npm run --silent pack-reviewer-config -- status --expect <gpt|codex|claude>
```

Require `[PASS]` before starting a review.

## 4. Confirm the boundary

- The saved preference is global to the user, not repository state.
- `PACK_REVIEW_BOUND_REVIEWER` is reserved for one-shot invocation binding.
- A saved preference wins over stale `PACK_REVIEWER`.
- Runtime selection is handled separately by the configured runtime adapter.
- Do not invoke a reviewer wrapper directly.
