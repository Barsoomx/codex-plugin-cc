# Fork / issue audit — 2026-09-13

Upstream and Barsoomx `main` both started at `db52e28`. Independent agents inspected all nine forks and upstream issues. WSL Claude memory and the supplied handoff provided local incident evidence.

| Fork | Relevant work / decision |
|---|---|
| [ALV0612](https://github.com/ALV0612/codex-plugin-cc) | [Publish queued job before worker](https://github.com/ALV0612/codex-plugin-cc/commit/2a1d6f4f005d0d0c32685fd7a5e1a8a2a4ee0001), [terminal errors](https://github.com/ALV0612/codex-plugin-cc/commit/2db7ca82e1d56854f55ce2be760d6dcb7134d2fe). Adopted focused equivalents. Most fixes are on nondefault branches. |
| [vertiman](https://github.com/vertiman/codex-plugin-cc) | [Astra aliases and efforts](https://github.com/vertiman/codex-plugin-cc/commit/07f4009b8aafbe5c00f12c70092880563effb68d), cross-workspace lookup and Windows shell fixes. Did not import the broader product rewrite. |
| [badigit](https://github.com/badigit/codex-plugin-cc) | Bounded transport, dead-worker reconciliation, [explicit wait/result contract](https://github.com/badigit/codex-plugin-cc/commit/e36b3c33dcc650e12a784a8a936e03b624ab59f8), [retain results](https://github.com/badigit/codex-plugin-cc/commit/46fe60cd643ec3f505e808e93dfabed971426f62). Valuable lifecycle ideas; short timeout defaults were unsuitable. |
| [sddamico](https://github.com/sddamico/codex-plugin-cc) | [Generic agent and background reviews](https://github.com/sddamico/codex-plugin-cc/commit/bfc2dc2569baa8623dc8374dc5bd425961e973f3). No durable process fix; did not adopt renames or ignoring explicit wait. |
| [Luizdetec](https://github.com/Luizdetec/codex-plugin-cc) | [Astra, capability validation and locks](https://github.com/Luizdetec/codex-plugin-cc/commit/50d495ba47baa9553237f4f6ff5c345c7c7036fd). Useful validation concept; avoided broad command expansion and stale mkdir locks. |
| [eytanyariv-jpg](https://github.com/eytanyariv-jpg/codex-plugin-cc) | [Pairing coordinator design](https://github.com/eytanyariv-jpg/codex-plugin-cc/commit/09181fc33cc14b772c9e6f5d94e261841ee7607f). Documentation only; no executable fix. |
| [ErneG](https://github.com/ErneG/codex-plugin-cc) | [Model discovery and effort plumbing](https://github.com/ErneG/codex-plugin-cc/commit/30e06137f890a199f02f0ebde5e8f5c3e86c0fae). Useful validation design; catalog should not exclude custom providers. |
| [prashantkamani](https://github.com/prashantkamani/codex-plugin-cc) | [Sandbox controls](https://github.com/prashantkamani/codex-plugin-cc/commit/602e7c5b450c166be6f76b2c35a068d84a6b3016). Kept hard read-only reviews rather than importing unrestricted review modes. |
| [y-cruce](https://github.com/y-cruce/codex-plugin-cc) | [Explicit resume](https://github.com/y-cruce/codex-plugin-cc/commit/7067e2d1237855bb771fd207fba4e10bc7f17b0d), [atomic state and broker ownership](https://github.com/y-cruce/codex-plugin-cc/commit/251ef06f8959405b03b6d19272ea3ed53531b482). Stable IDs and records adopted; multiplexed director protocol omitted. |

None of these forks passed context-window overrides or supplied Windows-to-WSL transport. This fork targets Claude already running inside WSL.

| Issue evidence | Baseline defect / remedy |
|---|---|
| [#751](https://github.com/openai/codex-plugin-cc/issues/751), [#616](https://github.com/openai/codex-plugin-cc/pull/616) | Local rejection of max/ultra; added effort and Astra support. |
| [#746](https://github.com/openai/codex-plugin-cc/pull/746) | Review effort becomes prompt text; parse and propagate consistently. |
| [#615](https://github.com/openai/codex-plugin-cc/issues/615) | Review background flag does not detach; durable review worker. |
| [#698](https://github.com/openai/codex-plugin-cc/issues/698), [#391](https://github.com/openai/codex-plugin-cc/issues/391) | Errors/disconnects leave pending turns; complete with failure. |
| [#517](https://github.com/openai/codex-plugin-cc/issues/517), [#520](https://github.com/openai/codex-plugin-cc/issues/520) | Dead worker remains running; reconcile PID and preserve evidence. |
| [#542](https://github.com/openai/codex-plugin-cc/issues/542), [#634](https://github.com/openai/codex-plugin-cc/issues/634) | Claude shell lifetime kills work; independent worker, disposable waiter. |
| [#397](https://github.com/openai/codex-plugin-cc/issues/397) | Missing plugin root in subagent; exported root and concrete forwarded path. |
| [#236](https://github.com/openai/codex-plugin-cc/issues/236) | Arbitrary SHELL breaks transport; native executable discovery. |
| [#757](https://github.com/openai/codex-plugin-cc/issues/757) | Failed result omits status error; persist returned error and runtime metadata. |

Local evidence: uncommitted WSL source edits raised a timeout but the installed cache still used old limits. A live broker served Codex 0.153.4 after native CLI had updated to 0.154.0. The new install preserves that checkout and uses a fresh versioned cache; direct processes avoid keeping an old binary across jobs.

The historical Engram hook is excluded at the user's request. SQLite databases, auth files and active old sessions are not modified by these fixes.
