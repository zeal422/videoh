# Contributing to videoh

Thanks for taking a look. videoh is an open-source, browser-based video editor. The editor runs entirely in the browser, and the project uses Bun for install, scripts, and tests.

## Before you start

- Read [AGENTS.md](AGENTS.md), the repository instructions for coding agents and human contributors.
- Read the [docs index](docs/README.md) for the architecture, structure, flows, testing, design system, and deployment notes.
- Use Bun. Do not use npm, pnpm, or yarn.

## Set up

```bash
bun install
bun run dev
```

Open <http://localhost:3000/editor> for the editor. The public site is at <http://localhost:3000/>.

## Before a pull request

Run the full gate:

```bash
bun run check
```

That runs Prettier check, ESLint, TypeScript, the Vitest suite, and the production build. For UI changes, also exercise the affected flow in a browser and keep the console clean.

## Tests and docs

- Add tests under `src/lib/editor/__tests__/`.
- A regression test must fail on the unfixed code before it counts as proof.
- Keep the test inventory, counts, and battery notes in [docs/testing.md](docs/testing.md) in sync.
- Update the owning doc and [CHANGELOG.md](CHANGELOG.md) when behavior changes.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Bugs and requests

Report reproducible bugs and focused feature requests through GitHub issues. Include the browser, the steps, and what you expected.
