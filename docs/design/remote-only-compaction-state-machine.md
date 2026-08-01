# OpenAI compaction state machine

Status: design pointer to the executable contract.

The semantic machine is now owned by
[`src/state-machine.mjs`](../../src/state-machine.mjs). It exports the three
state names, the complete transition projection, the fixed Blackmagic marker,
pure continuation classification, and pure compaction decisions. The
controller and focused tests consume that module.

The interactive
[`compaction-state-machine.html`](compaction-state-machine.html) is generated
output from
[`compaction-state-machine.template.html`](compaction-state-machine.template.html).
Run `npm run generate:state-machine` after code changes; do not edit the
rendered HTML as a second authority.

For the current remote-first behavior, including Route authorization, Pi native
summary delegation, supported failure cancellation, mismatch freedom, and
legacy-record support, read [`docs/current/README.md`](../current/README.md).
The published `0.1.0-rc.3` is the last release. The current working-tree
contract is unreleased and has no assigned release version.
