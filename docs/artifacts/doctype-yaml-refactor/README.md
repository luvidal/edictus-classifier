# Doctype YAML Refactor Snapshot

This directory pins the pre-YAML source catalog for the parent Jogi refactor.

- Source captured: `/Users/avd/GitHub/jogi/data/doctypes.json`
- Snapshot: `doctypes.pre-yaml-20260514.json`
- Captured on: 2026-05-14
- SHA-256: `1e43edbc968819eeb5e158c62d4857b7c74aafcdb69dcaf05654b2b0b3a619bc`
- Doctype count: 25

Use `npm run doctype:regression` after the YAML refactor regenerates
`../jogi/data/doctypes.json`. The guard allows only top-level `definition` and
`classifier` changes; any drift in legacy consumer fields fails the check.

Real concern to carry into the plan: the installed `@jogi/docs.getPromptVersion()`
does not currently hash unknown doctype fields such as `classifier`, because
`getExpandedDoctypes()` projects the raw catalog through a whitelist. Fix the
classification cache key before shipping classifier-only catalog tuning.
