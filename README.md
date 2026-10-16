# Isolated public blog export verification

This repository contains an already published static snapshot, deployment probes, and a test-only mobile author prototype. It contains no private blog source, draft data, or credentials.

The native Git test project validates published-manifest.json and copies only the allowlisted site files into dist. Production hosting and DNS are unchanged.

The `/author-probe/` page uses `/api/author/` Cloud Functions. Drafts, test images, and opaque sessions belong in project-managed Blob storage, never this public Git repository. GitHub sign-in requests no repository scopes. OAuth configuration is supplied through server-side project environment variables; without it, sign-in is unavailable and private endpoints reject anonymous requests.

This is a bounded verification prototype. Draft saves retain separate snapshots; sequential stale versions are rejected, but atomic concurrent editing is not claimed. No publish endpoint is provided, and the existing public blog snapshot stays unchanged.
