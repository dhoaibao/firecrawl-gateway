# Phase 1 verification baseline

Captured before the repository move:

- Backend typecheck: green (`gateway`, `npm run typecheck`).
- Backend tests: green (19 files, 203 tests).
- Admin UI lint and build: green (`apps/web`, `npm run lint && npm run build`).

The required post-move verification is the root workspace sequence:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
docker build -f deploy/Dockerfile .
```
