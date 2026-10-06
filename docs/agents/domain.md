# Domain docs

## Layout

This is a single-context repository:

- `GLOSSARY.md` at the repository root
- Architecture decision records in `docs/adr/`

## Before exploring the codebase

Read `GLOSSARY.md` and the ADRs relevant to the area being explored.

If these files do not exist, proceed silently. Domain modeling creates
them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

Use glossary terms when naming domain concepts in issues, proposals,
hypotheses, and tests.

If a needed concept is missing, reconsider whether the term belongs
or note the gap for domain modeling.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and
explain why the decision is worth reopening.
