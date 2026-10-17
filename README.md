# Isolated public blog export verification

This repository contains an already published static snapshot, deployment probes, and a test-only mobile author prototype. It contains no private blog source, draft data, or credentials.

The native Git test project validates published-manifest.json and copies only the allowlisted site files into dist. Production hosting and DNS are unchanged.

The `/author-probe/` page uses `/api/author/` Cloud Functions. Drafts, test images, and opaque sessions belong in project-managed Blob storage, never this public Git repository. GitHub sign-in requests no repository scopes. OAuth configuration is supplied through server-side project environment variables; without it, sign-in is unavailable and private endpoints reject anonymous requests.

This is a bounded verification prototype. Draft saves retain separate snapshots; sequential stale versions are rejected, but atomic concurrent editing is not claimed. Publishing explicitly freezes selected test content and its image copies in a public snapshot. The build renderer targets only `/publication-proof/`; the existing published blog snapshot stays unchanged. A project-and-branch-specific Deploy Hook is required in the test project's `PUBLICATION_DEPLOY_HOOK` environment variable. The hook URL must never be committed or sent to the browser.

Bootstrap order: first deploy the public-snapshot API, then wire the required snapshot fetch into the build. Only after both are live should the hook be configured. Missing configuration disables publishing. A hook response only acknowledges a request; the UI confirms deployment by matching the live static release marker. A failed snapshot fetch must fail the build instead of producing an empty replacement. Maximum proof snapshot size is 4 MiB. Withdrawal removes the current static copy, not historical deployments or external caches.

Session expiry preserves the current editor and offers re-login. Before leaving the page, text is stored in this tab's sessionStorage for up to 24 hours; successful save or explicit logout clears it. No token is stored in sessionStorage. Recovery does not publish automatically.

`node --test tests/publication.test.mjs` checks snapshot isolation, image remapping, deployment status, withdrawal, safe rendering, failure handling, and text recovery with explicit test doubles. It is not evidence of live cloud publication.
