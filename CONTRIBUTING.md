# Contributing

Keep the shared rendering, streaming, navigation, and inventory contracts
independent of a dataset's visual style. Dataset configuration identifies data
and capabilities; visual themes control appearance, not row identity or saves.

Run frontend unit tests, TypeScript checks, and the production build for frontend
changes. Run pipeline tests for binary formats, pack construction, and serving
changes. Test count/range boundaries and resource ownership; use short browser
checks for rendering or interaction changes rather than a large mandatory E2E
suite. Do not treat software-rendered headless FPS as a user-GPU benchmark.

## Documentation

Repository docs describe current installation, usage, configuration, data
contracts, and deployment. Update them alongside behavior changes. Keep examples
portable; identify required external data instead of assuming a contributor's
filesystem layout.

Keep conversational reviews, provisional choices, chronological iteration
reports, private-machine URLs, and one-off benchmark receipts outside this
repository. Maintained benchmark tools and test fixtures belong with the code;
their generated run outputs do not. A current reference may summarize a measured
limit when it includes the workload, units, and relevant caveats.

Never upload credentials, caches, generated corpus packs, or source datasets in
code commits. Publish immutable data releases separately and validate row identity
before changing registry paths. The code license is not yet specified; preserve
all existing third-party notices.
