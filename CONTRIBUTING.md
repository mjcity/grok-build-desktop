# Contributing

Contributions are welcome — adapters for new CLIs most of all.

## Ground rules

1. **The E2E suite is the contract.** Before opening a PR, run and pass:
   ```powershell
   node scripts\chat-e2e.mjs
   node scripts\feed-e2e.mjs
   node scripts\tools-e2e.mjs
   ```
   All three are exit-code gated. Paste their output in the PR description.
2. **Never return a wrong-shaped 200.** The Hermes renderer catches network
   failures but crashes on 200s with unexpected JSON shapes. Unknown routes
   404 with `{"detail": ...}`. Read the header comment in `server.mjs` before
   touching any endpoint — every rule there was earned the hard way.
3. **Honest feeds only.** Everything shown in the UI must come from real
   backend data (the CLI's stream or its on-disk session logs). No fabricated
   progress, no fake status text, no invented reasoning.
4. **No credential handling.** PRs that collect, store, or transmit API keys
   or tokens will be declined. The design principle is: the user's CLI holds
   the auth; we only drive it locally.
5. **Keep the stock apps stock.** No patches to Hermes binaries or the Grok
   CLI. The bridge adapts to them, not the other way around.

## Adding a model adapter

The Grok-specific surface is intentionally small — three things:

1. **Spawn:** the headless command line (`grok -p ... --output-format
   streaming-json --resume <sid>` equivalent for your CLI).
2. **Stream mapping:** your CLI's stdout events → `message.delta` /
   `reasoning.delta` / turn end (see `runGrokTurn` in `server.mjs`).
3. **Activity source (optional but loved):** wherever your CLI records live
   tool activity (an event log, a session file) → `tool.start` /
   `tool.complete` (see `startToolFeed`).

Open an issue first describing your CLI's headless interface; we'll agree on
the adapter seam before you build.

## Legal bits

- By contributing you agree your contribution is licensed under the repo's
  MIT license and that you have the right to submit it.
- Don't paste other projects' code unless its license allows it and you say
  so in the PR.

## Conduct

Be decent. Reviews critique code, not people.
