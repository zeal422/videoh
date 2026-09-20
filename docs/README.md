# Documentation — Web Video Editor

Start with the [README](../README.md) for the product overview and quick start. These docs are the
deeper references, and they cross-link to each other so you can move between them without guessing.

| Doc                                  | Read it when you want…                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)   | the module-by-module reference, data flow, undo/redo, A/V links, audio graph, invariants   |
| [structure.md](structure.md)         | a filesystem map — what every folder and file is responsible for                           |
| [flows.md](flows.md)                 | the behavior contracts for each user flow (import, edit, link, export, save/refresh)       |
| [testing.md](testing.md)             | how to run tests, the test inventory, conventions, the mocked harness, and the E2E battery |
| [design-system.md](design-system.md) | design tokens, theming, layout conventions, and UI/a11y rules                              |
| [deployment.md](deployment.md)       | build, run, the standalone output, and the verification gate                               |

Project-level files:

- [README.md](../README.md) — product overview, features, keyboard map, quick start.
- [CHANGELOG.md](../CHANGELOG.md) — released and unreleased changes ([Keep a Changelog][kac]).
- [AGENTS.md](../AGENTS.md) — instructions for AI coding agents working in this repo.

How the docs stay honest: every doc claims something about the code in `src/`, and the code links
back. When behavior changes, update the doc that owns it — [architecture.md](architecture.md) owns
invariants and the module table, [flows.md](flows.md) owns interaction contracts,
[testing.md](testing.md) owns the test inventory and counts, and [design-system.md](design-system.md)
owns tokens and UI rules.

[kac]: https://keepachangelog.com/en/1.1.0/
