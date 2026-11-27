# SigDRIFT — game plan

Working title: **SigDRIFT** (the folder name; check the name is free before going public).

An original browser drift game: one rear-wheel-drive car, a locked isometric camera, a neon cyberpunk look, and a new generated level every week. It shares its genre and handling ideas with Absolute Drift, but the name, car design, art, sound and levels are our own.

## 1. What the research found

### How the reference game plays (mechanics only)

| Area | Finding | What we do |
|---|---|---|
| Controls | Steer, throttle, brake, separate handbrake. Controller recommended by its developer. | Same four inputs, keyboard and gamepad from day one. |
| Starting a drift | Beginner: tap handbrake while turning in. Advanced: speed, weight transfer and throttle only. A minimum speed is needed before the car slides. | Both ways must work in our physics. |
| Holding a drift | Countersteer and keep throttle on; over-correcting spins the car. | Emerges from the tyre model; tuned in a sandbox first. |
| Feel | Loose, low grip, rear-driven; finesse over speed. Hard at first, very satisfying later. | Same target, plus an optional steering assist for keyboard. |
| Camera | Fixed isometric, high and zoomed out, follows the car, never rotates. Steering is relative to the car. | Same principle. Exact angle and zoom are our own choice. |
| Scoring | Points grow with drift angle and speed; a multiplier builds across chained drifts and breaks on wall hits or spins. | Kept for the later score mode; shown as a style bonus in mode 1. |
| Tyre marks | Stay on the road as feedback on your line. | Persistent glowing skid marks. |
| Complaints | Steep learning curve, little onboarding, unclear combo-break rules. | Tutorial, clear HUD rules, instant reset key. |

Not confirmed by any source: the exact camera angle, speed-based zoom, and the restart rules. Those are our decisions.

### Tech stack (versions checked 2026-11-27)

| Part | Choice | Note |
|---|---|---|
| Language / build | TypeScript 7, Vite 8 | TypeScript 7 with this toolchain is unverified; fall back to 5.x if it fails. |
| Rendering | three `~0.187`, `WebGLRenderer` | WebGPU support is still uneven; keep rendering behind `render/` so it can be swapped later. |
| Glow | pmndrs `postprocessing` 6.39 | Its peer range ends below three 0.188, so three stays pinned. |
| Physics | Custom 2D bicycle model, no physics engine | Drift feel is tuned in our own tyre code. |
| Tests | Vitest 5 | Node 22.12+ needed; Node 26 is installed. |
| Audio | Raw WebAudio | No library. |
| Hosting | GitHub Pages via GitHub Actions | Free for public repos. |

## 2. Game design for version 1

**Mode 1 — Run.** Drive from a start pad to a destination through checkpoints. The result is your time. A drift score is shown as a secondary style number. Leaving the track or pressing reset puts you back at the last checkpoint. Best times are saved in the browser.

**Car.** One light rear-wheel-drive coupe, our own low-poly design, built from code (no model files needed at first).

**Camera.** Orthographic, fixed rotation (about 45° turn, 35–55° tilt), follows the car with a slight lag. Every player sees the same amount of world.

**Look.** Dark ground, emissive neon edges in magenta, cyan and amber, bloom, glowing skid marks, light tyre smoke. A quality toggle and a reduced-flash option.

**Controls.**

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | A / D or arrows | Left stick |
| Throttle | W or up | Right trigger |
| Brake / reverse | S or down | Left trigger |
| Handbrake | Space | A / Cross |
| Reset to checkpoint | R | Y / Triangle |

Steering is car-relative by default, with camera-relative steering as an option.

**Later modes.** Score attack (two minutes, drift points), then racing against NPC cars. Both reuse the same car, physics and generator.

## 3. Architecture

```
src/
  main.ts
  core/    loop.ts rng.ts fixedMath.ts hash.ts
  sim/     car.ts tire.ts collision.ts surface.ts world.ts replay.ts
  gen/     weeklySeed.ts trackGen.ts tiles.ts validate.ts
  render/  renderer.ts camera.ts post.ts carMesh.ts levelMesh.ts skid.ts smoke.ts palette.ts
  input/   keyboard.ts gamepad.ts actions.ts
  audio/   engine.ts tires.ts mixer.ts
  modes/   run.ts            (later: scoreAttack.ts race.ts)
  ui/      hud.ts menu.ts
tests/     sim/ gen/ replay.golden.test.ts
```

Rules that keep the later modes possible:

- `sim/` and `gen/` are pure TypeScript with no three.js or DOM imports.
- The simulation runs at a fixed 120 steps per second; rendering interpolates between steps.
- All trigonometry in `sim/` and `gen/` goes through `core/fixedMath.ts`, because `Math.sin`, `cos` and `atan2` can differ between browsers. This keeps ghosts and leaderboards possible later.
- Smoke, audio and other cosmetics stay outside the simulation.

### Car physics

A bicycle model in the car's own frame, per step:

1. Split velocity into forward and sideways parts.
2. Work out front and rear axle loads, with weight shifting under acceleration and braking.
3. Work out front and rear slip angles.
4. Sideways tyre force rises with slip angle, then saturates at a grip limit.
5. Handbrake cuts the rear grip limit; throttle also eats into rear grip (this gives power oversteer).
6. Integrate forces into speed, position, spin and heading.

Starting values for tuning (unsourced; expect to change them in the sandbox):

| Parameter | Start value |
|---|---|
| Mass | 1000 kg |
| Rotational inertia | 1100–1300 kg·m² |
| Centre of mass to front / rear axle | 1.15 / 1.25 m |
| Cornering stiffness front / rear | 5.0 / 5.4 |
| Grip limit front / rear | 2.0 / 1.9 |
| Rear grip under handbrake | 0.5–0.7 of normal |
| Rear grip lost at full throttle | 30–50% |
| Engine force | 7000–9000 N |
| Brake / handbrake force | 12000 / 5000 N |
| Max steering angle | 0.6 rad, falling to about 0.25 at top speed |

Known traps to handle: jitter near zero speed, endless spins (add spin damping), and force oscillation if stiffness is too high for the step size.

### Weekly level generator

- **Seed.** The ISO week in UTC, e.g. `sigdrift|gen-v1|2026-W48`, hashed (cyrb128) into a small seeded random generator (sfc32). No server: every player computes the same level.
- **Layout.** A grid of large cells. A self-avoiding random walk from start to goal lays the path first, so a route always exists.
- **Tiles.** Each path cell gets a hand-designed tile: straight, sweeper, hairpin, plaza, and later ramp up / down. Tile design guarantees the road is wide enough to drift.
- **Details.** Obstacles only outside a reserved clear corridor; a checkpoint every few cells; separate random streams for layout, props and cosmetics.
- **Validation.** Route check from start to goal, minimum width, slope limits. A failed level retries with `seed + attempt`.
- **Safety net.** CI generates the next 52 weeks and fails if any level is invalid.
- **Versioning.** The generator version is part of the seed. Old versions are frozen, never edited, so past weeks stay reproducible. The same applies to physics once times are recorded.

Elevation is 2.5D: the surface supplies a height and slope at each point, and the car carries its own height and airborne state. The scene is rendered in full 3D from day one; ramps and jumps arrive in M9, after flat driving feels right.

## 4. Milestones

Each one can be tested on its own.

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold, CI, Pages deploy | A blank scene is live at the Pages URL and CI is green. |
| M1 | Fixed-step loop, input, deterministic maths and random generator | Unit tests pass, including a replay hash test. |
| M2 | Car physics on a flat plane with a live tuning panel | Handbrake and power-over drifts both work; you sign off on the feel. |
| M3 | Wall collision, hand-built test track, reset | The car cannot leave the track; reset works. |
| M4 | Locked camera, neon rendering, bloom, skid marks | 60 fps on an integrated GPU. |
| M5 | Run mode: start, checkpoints, goal, timer, HUD, local bests | A full run can be completed and the best time persists. |
| M6 | Tile generator v1 with validation | 1,000-seed property tests and the 52-week check pass. |
| M7 | Weekly seed wiring, version freeze | The level changes with the ISO week; an old week reproduces exactly. |
| M8 | Audio, smoke, tutorial, settings | First-time players can finish a run unaided. |
| M9 | Elevation and ramps | Generated levels include height changes and jumps that the validator accepts. |
| Later | Score attack, ghosts, NPC race, server leaderboard | — |

The biggest risk is drift feel, so M2 comes before any level or art work.

## 5. Connecting to GitHub

Already in place on this Mac: git 2.50, GitHub CLI 2.97 signed in as `SIGALIZ3R`, Node 26.

1. **Local repository.** `git init -b main`, add a `.gitignore`, first commit.
2. **Create the GitHub repo and push.** `gh repo create sigdrift --public --source=. --remote=origin --push`. Public is needed for free Pages hosting; this publishes the code.
3. **Project board.** `gh auth refresh -s project` (opens the browser once), then `gh project create --owner @me --title "SigDRIFT Roadmap"` and `gh project link`.
4. **Milestones and issues.** One GitHub milestone per row in section 4, one issue per task, added to the board.
5. **CI and deploy.** `.github/workflows/ci.yml` runs typecheck, tests and build on every push, and deploys `dist` to Pages from `main` (actions: checkout v7, setup-node v7, upload-pages-artifact v5, deploy-pages v5).
6. **Enable Pages.** Settings → Pages → Source: GitHub Actions. Set `base: '/sigdrift/'` in `vite.config.ts` for CI builds.
7. **Protect `main`.** After the first green CI run, add a ruleset: require the `ci` check, block force pushes.

## 6. Open decisions

- Repo name and public vs private (private means no free Pages hosting).
- Licence, and a trademark check on the final game name.
- Touch / mobile support: not planned for version 1.
- Whether an archive of past weeks is playable in version 1 (planned: yes, via a week picker, since it is nearly free).
