# game-wizards — combat core plan

A wizard combat example, loosely inspired by `~/Development/wizard-game` but
free to diverge in gameplay. This plan covers the **core combat loop only**:
cast → projectile → collision → damage → death → VFX. Spellcrafting is
deliberately deferred; the seams are left open so it can land later without a
rewrite.

## Status (2026-06-13)

Core slice **implemented** in `src/index.ts` (all in one file, ~340 lines
appended after the existing wizard setup):

- ✅ Cast on left-click → `Cast{dir}` (camera forward) → server spawns one bolt.
- ✅ Server-authoritative projectile: analytic per-tick movement (no physics
  body — tunnel-proof), terrain-hit via `getBlock`, entity-hit via sphere check.
- ✅ `handleHit`: carves a voxel sphere (`setBlock` → air) + splash-damages all
  health entities in range; broadcasts `Impact` / `Damage`.
- ✅ Health / death / respawn (regen after delay, `Alive` marker, respawn at
  home/spawn) for players **and** NPCs. PvP works (players carry health).
- ✅ NPC dummy wizards via `addCharacter` (synchronous rig mount) + hat/staff,
  reusing the existing client hat-tint path. Now also `CharacterControllerTrait`
  — the server runs the sim for these ownerless nodes (gravity grounds them;
  respawn teleports cleanly since the sim reads the transform each tick). AI
  steers later via `input.move` / `input.look`; idle stands. No AI yet.
- ✅ Client VFX: trail (per-frame from each projectile), impact burst, death
  burst, muzzle flash, damage pop — starter sprites, self-lit.

**Deferred / not built:** elements / stats / tint, knockback, floating damage
numbers (digit atlas — currently a particle pop), NPC AI / return-fire, status
effects.

**Runtime-tuning unknowns to watch when running `./dev.sh`** (couldn't verify
statically — engine source typecheck OOMs): projectile model scale/orientation,
and whether the default player controller's left-click/pointer-lock interaction
conflicts with casting (cast gates on `document.pointerLockElement`).

## Decisions (locked)

- **Scope:** start with **one projectile, full stop**. No elements, no stat
  table, no tint variation — a single hardcoded bolt cast on click that flies,
  collides with terrain + entities, deals damage + terrain damage, with full
  VFX. Elements / stats / crafting / other directions layer in *after* the core
  loop works. Gameplay may diverge from the original — we just need the core
  bits solid and extensible.
- **Authority:** server-authoritative. Server owns spawn, movement, collision,
  damage, death/respawn, and terrain edits; it broadcasts events; clients only
  render VFX and read replicated state.
- **Targets:** PvP **and** NPCs. NPC wizards are killable dummies that respawn
  (AI is a stub for now). PvP falls out for free once players carry health.

## What already exists (do not rebuild)

`examples/game-wizards/src/index.ts` already has:
- Wizard rig + **hat** (`RIG_6BONE_HEAD`) + **staff** (`RIG_6BONE_HAND_RIGHT`)
  attachment via `cloneModel(wizardModels.nodes.<x>)` + `addChild`.
- Per-player `WizardTrait { color }`, synced (`rate: 'dirty'`), with hat tint
  applied client-side via `setMeshTint`.
- First-person viewmodel staff with walk-bob.
- Environment setup (`ENVIRONMENT_OVERWORLD`, time 14).

**The model asset now has a `projectile` node** alongside `staff` / `hat`, so
`wizardModels.nodes.projectile` is available to `cloneModel` — same pattern as
the hat. Used as-is for now (no tint); `setMeshTint` is the seam for per-element
tint once elements arrive.

## Engine primitives this relies on (all verified)

- `model()` + `cloneModel(node)` + `setMeshTint(meshTrait, Vec4)` — projectile
  visual + element tint seam. `[0,0,0,0]` tint = untinted.
- `particle(id, { sprite, playback, update })` + `spawnParticle(ctx, type, pos,
  opts)` + `particleUpdate.*` (gravity/drag/integrate/collide* primitives,
  dust/smoke/spark presets). **Client-only** — `spawnParticle` returns `null`
  on the server. Stable emission via a per-second accumulator (see `sprites`
  example).
- `AabbBodyTrait` — `halfExtents`, `linearVelocity`, `gravityFactor`, `sensor`,
  `collisionGroups`/`collisionMask`, `voxelFlagsMask`. Lightweight bodies for
  projectiles.
- `ContactsTrait` — per-step `.added` / `.persisted` / `.removed`; each contact
  carries `nodeId`, `type` (`'rigidBody'` vs voxel), `position`, `normal`.
  Populated on whichever side runs physics (the server, here). Index target
  nodes by `nodeId` to resolve hits (pattern from `persistent-data` example).
- Networked scene graph — server-created nodes + their traits replicate to
  clients automatically; transform syncs at movement rate. So a server-spawned
  projectile node renders on every client with no manual packet.
- `send` / `broadcast` / `listen` — typed client↔server messages for events
  (Cast / Impact / Damage / Death).
- `setBlock(voxels, x, y, z, BLOCK_AIR)` — carve terrain. `block()` auto-derives
  break dust, so terrain-hit VFX is largely free (confirm + supplement).
- Input: `isMouseJustDown(mk, 'left')`, camera via `resolveCamera(ctx)`.

## Architecture

```
client click ──Cast{dir}──▶ server cast handler (cooldown gate)
                            └─ spawnProjectile(): create node (auto-replicates)
server tick (per projectile):
  integrate via AabbBody velocity + gravityFactor
  read ContactsTrait.added:
    voxel contact     → terrain hit
    rigidBody+nodeId  → entity hit (skip owner)
  on first hit → handleHit() → destroy projectile
  on lifetime expiry → fizzle → destroy

handleHit():
  terrain: carve voxel sphere (radius = element.terrainRadius)
  entity:  damage all HealthTrait within element.splashRadius (skip owner),
           knockback the direct-hit target via its body velocity
  broadcast Impact{pos, element}      → client: impact burst
  broadcast Damage{target, amt, elem} → client: floating number
  health<=0 → remove AliveTrait, broadcast Death{node,pos,respawnAt}
              → client: death burst; schedule respawn

client every frame:
  query replicated ProjectileTrait nodes → emit trail particles at each
```

## File layout — everything in `index.ts`

The slice is small enough to live in the **existing `src/index.ts`**, appended
after the current wizard setup. No `combat/` dir, no extra files. Keep it flat
and minimal: a handful of trait/message decls at the top, then `script(...)`
blocks for each concern, server/client split with the usual `if (!env.server)`
/ `if (!env.client)` guards.

Rough order within the file (all additive to what's already there):
```
existing: model(), WizardTrait + color sync, environment, join, viewmodel, wizard-visuals
add:
  consts        SPEED / DAMAGE / SPLASH_RADIUS / TERRAIN_RADIUS / LIFETIME / COOLDOWN
  traits        ProjectileTrait, HealthTrait, AliveTrait, NpcTrait (+ syncs)
  messages      Cast / Impact / Damage / Death
  spawnProjectile()  small server helper fn (not a script)
  script 'cast'        client input → Cast ; server listen(Cast) → spawnProjectile
  script 'projectiles' server: integrate + contacts + handleHit (inline)
  script 'health'      server: regen + death + respawn
  script 'npcs'        server: spawn dummies + respawn (AI stub)
  script 'vfx'         client: particle decls + trail/impact/death emitters + damage numbers
  join (extend)        add HealthTrait + AliveTrait to the player
```

If it grows past comfortable (elements, status effects, AI), *then* split into a
`combat/` dir — not before. Later: an elements table + an `element` field on
`ProjectileTrait` slot in without touching the loop (hardcoded consts become row
lookups).

## Implementation steps

### 1. Projectile — the core (one bolt, hardcoded)
File-level constants for the single bolt: `SPEED`, `DAMAGE`, `SPLASH_RADIUS`,
`TERRAIN_RADIUS`, `LIFETIME`. No elements / stat table / tint yet.
- `ProjectileTrait { ownerNodeId, spawnTime }` — synced for replication.
- `spawnProjectile(ctx, ownerNode, origin, dir)` (server): `createNode` →
  `TransformTrait` at `eye + dir*1.2` → child
  `cloneModel(wizardModels.nodes.projectile)` (used as-is, no tint) →
  `AabbBodyTrait { halfExtents ~0.2, sensor: true, gravityFactor: 0,
  linearVelocity: dir*SPEED, collisionMask: terrain|characters }` →
  `ContactsTrait` → `ProjectileTrait`. Auto-replicates.
- Server `onTick`: lifetime expiry → fizzle (Impact with `fizzle` flag) +
  destroy; else read `ContactsTrait.added` → first voxel/entity hit (index
  character nodes by `nodeId`, skip owner) → `handleHit()` → destroy.
- **Movement risk to validate in the slice:** fast bolts (~0.5 m/tick) vs the
  AABB sweep may tunnel thin walls/characters. Prototype the body path first;
  fall back to an analytic prev→pos voxel+AABB sweep per tick (the original's
  approach; engine particle `sweepSolid` is the reference) only if needed.

### 2. `handleHit()` — inline server helper
- **Terrain:** sphere of `TERRAIN_RADIUS` around hit → `setBlock(..., BLOCK_AIR)`.
  Block-break dust auto-derived; confirm and supplement.
- **Entity:** query `[HealthTrait, TransformTrait]`, damage all within
  `SPLASH_RADIUS` of hit, skip owner, `applyDamage(health, DAMAGE, attacker)`.
  Direct-hit target gets a knockback impulse on its body velocity.
- Broadcast `Impact{pos}` and per-target `Damage{targetNodeId, amount}`.

### 3. Health & death
- `HealthTrait { current, max, lastDamageTime, lastAttacker }` synced (dirty);
  `AliveTrait` marker.
- `applyDamage(health, dmg, attacker, now)` — cap, stamp `lastDamageTime`/
  `lastAttacker`.
- Server system: regen 1hp/s after 3s idle; death (`current<=0` → remove
  `AliveTrait`, broadcast `Death`, schedule respawn after 3s). Player respawn =
  reset transform + refill; NPC respawn = same at spawn point.
- Extend the existing `onJoin`: add `HealthTrait` + `AliveTrait` to the player.

### 4. Cast — input → server
- Client `onFrame`: `isMouseJustDown(mk, 'left')` → aim `dir` from
  `resolveCamera` → `send(Cast{dir})`; local cooldown for feel; spawn cast-flash
  at staff tip.
- Server `listen(Cast)`: cooldown gate (mana deferred) → `spawnProjectile` from
  the caster's eye along `dir`.

### 5. NPC targets
- Server spawns 2–3 NPC wizards (reuse `CharacterTrait` rig + hat/staff, distinct
  tint) carrying `HealthTrait` + `AliveTrait` + `NpcTrait`. Killable dummies that
  respawn. **AI = stub** (idle / slow wander); "cast back" is a marked later
  hook. PvP works for free since players also carry `HealthTrait`.

### 6. VFX — client particles (faithful feel)
- `particle()` decls over a soft round sprite: **trail** (`stretch`, emissive,
  short life, drag), **impact burst**, **death burst** (gold, 40–60 count),
  **fizzle** (3 wisps). Single fixed color set per effect for now (element-driven
  colors come with the elements layer).
- **Trail:** client `onFrame` queries replicated `ProjectileTrait` nodes,
  per-second accumulator → `spawnParticle` at each projectile transform.
- **Impact / Death:** `listen(Impact)` / `listen(Death)` → burst at `pos`.
- **Damage numbers:** start simple — short-lived billboard `SpriteTrait` digit /
  colored pop on `listen(Damage)`. Full digit-atlas version is polish, not
  slice-critical.

## Milestones (vertical slice first)

1. **Slice:** click → one bolt spawns server-side, replicates, flies, hits
   terrain → carves voxels + impact burst. *(projectile + cast + minimal vfx)*
2. **Damage loop:** bolt hits an NPC dummy → damage → death burst → respawn;
   damage numbers. *(health + npc)*
3. **Feel & PvP:** trails, knockback, cast flash, splash radius, PvP, tune
   numbers (speed ~15–18, damage, splash, regen).
4. **Deferred seams (not built now):** elements / stats / tint (the first layer
   on top), crafting, status effects (wet/burning/frozen), spell forms
   (ball/spray), NPC return-fire AI.

## Open question resolved during the slice
Projectile movement via **AABB body + contacts** (idiomatic, auto-replicating)
vs **analytic per-tick sweep** (tunnel-proof, matches original). Prototype the
body path first; switch only if fast bolts tunnel.
