# Working agreements

- **Never merge without explicit approval.** No PR merges by any mechanism unless the user approves that merge in the current conversation. Approval to implement is not approval to merge. Stop at green and hand over.
- **Checks are one `&&` chain.** `pnpm check` runs `@effect/tsgo` (`tsc --noEmit`), `oxlint` (`@gdp-ts/core` strict + `anti-slop` + `@interfere/landmines`), `oxfmt --check`, `fallow`, `fallow architecture`, `vitest run`, and `git diff HEAD --check`. CI runs the same chain on every PR and push to `main`.
- **Boundaries live in `.fallowrc.json`.** `domain -> []`, `ports -> [domain]`, `control -> [domain, ports]`, `adapters -> [domain, ports]`, `main -> [adapters, control, domain, ports]`, `testing -> all`. Fix code or imports when a boundary fails; do not weaken config.
- **Changed code keeps a 100% mutation score.** Run `pnpm mutate` after changes under `src/`. Surviving killable mutants get tests; only genuinely equivalent mutants belong in `mutation-verdicts.json` with a specific justification.
- **Shared test helpers live under `test/`.** Never put shared test helpers under `src/` so `fallow mutation` scores only product code.
- **Live data is sacred.** Never point tests at `data/bookmarks.db`, `data/orama.msp`, or `data/browser-profile`; always use `:memory:` SQLite and `mkdtempSync` temp directories.
- **Commits say why.** Write commit messages in present tense explaining why the change exists.
- **Comments and docs state what IS.** Document current rules and architecture, not history or deleted code.
- **`CONTEXT.md` is the domain glossary.** Use its terms consistently across code, tests, and docs.
