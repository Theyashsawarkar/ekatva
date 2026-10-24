# Contributing

Thanks for helping. Before a pull request:

1. `pnpm install`, then `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
2. A new feature is a capability (see the README's "Adding a feature"):
   its contract in `packages/protocol`, off until granted.
3. Anything touching the link, pairing or root: read SECURITY.md first and
   say in the PR how the rules there still hold.
4. Add a CHANGELOG.md entry under "Unreleased", and update the docs in
   `apps/site` when behaviour changes.

Be kind; see the [Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
