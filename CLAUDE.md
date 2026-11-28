# SigDRIFT

Original neon drift game (TypeScript, three.js, Vite). Deploys to GitHub Pages from `main` via `.github/workflows/ci.yml`.

## Commands
- `npm run typecheck`, `npm test` (Vitest), `npm run build`
- `npm run coverage`: Vitest with v8 coverage. Timing benchmarks skip themselves under coverage (`inject('coverage')`).
- `npm run e2e`: Playwright flows in `e2e/` against a dev server on port 5190, using the installed Chrome (`channel: 'chrome'`, no browser download).

## Testing rules
- Unit tests live in `tests/`, mirroring `src/`. Default environment is node; DOM tests start with `// @vitest-environment happy-dom`.
- The simulation is deterministic (fixed 120 Hz, seeded RNG). Changing stock car physics or road generation means bumping `PHYSICS_VERSION` / `GEN_VERSION` in `src/types.ts` and updating golden pins.
- `game.ts`, `hud.ts` and the renderer need WebGL: cover them with `e2e/`, not unit tests.
- Seeded "players" in e2e are localStorage contents (there are no accounts).
- Append a summary to `.lovable/test-log.md` after each feature.
