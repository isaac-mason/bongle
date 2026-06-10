# Selective icon re-render gating (prefabs + scenes)

How the offline renderer decides which icons to re-render each pass, so a single
edit re-renders only the icons it actually invalidates — including transitively —
instead of all prefab icons.

Status: **implemented.**

## The icons

One artifact per subject:

- `block-icons` → packed atlas (`voxels-icons.{png,json}`) — many tiny bounded icons.
- `scenes/<id>.icon.png` — one per scene.
- `prefabs/<id>.icon.png` — one per prefab.

Each pass the orchestrator (`orchestrator.ts`) compares freshly-computed hashes
(`icon-hashes.ts`) to in-memory `last*IconHashes` maps and dispatches
`renderSceneIcon(id)` / `renderPrefabIcon(id)` for the misses. Gating is in-memory
(no on-disk sidecar), so a cold start re-renders everything once; within a session it's
selective.

## What changed and why

Prefab icons used to share **one corpus hash** (any prefab/scene/model/block edit →
re-render all prefab icons). Scenes were per-id but **transitively stale** — a scene that
embeds a prefab (`penguin.scene.json` is just a node with `prefab: penguin_model`) didn't
re-render when that prefab's body changed, because the scene's bytes don't move.

Both are now hashed on a **transitive dependency closure**: a subject's own version/bytes
plus the versions of everything it depends on. Editing `penguin_model` re-renders exactly
`penguin_model` + the `penguin` prefab + the `penguin` scene (all depend on it), and
nothing else.

## The dependency sources (and the gap we had to fill)

A prefab's render deps come from the runtime **DepGraph** (`core/capture/dep-graph.ts`):
`setDeps` wires a prefab's declared `deps:` + AST-detected refs as `producer → consumer`
edges. But the **scenes store has no `extractDeps`** (registry.ts) — by design: the runtime
doesn't need scene→prefab edges, because an embedded prefab's anchor re-ticks at the
*instance* level via `markPrefabAnchorsDirty` when the prefab itself is dirty. So the graph
has **no scene→prefab edge**, and `getDirtyConsumers(penguin_model)` never reaches the
penguin scene.

We did **not** add `extractDeps` to the scenes store — that would fire redundant
`scene changed` dispatch (→ `applyScenePayload` re-population) on every embedded-prefab
edit, churning the live editor for no runtime benefit. Instead the scene→prefab edges are
computed **on demand**, only by the icon pipeline:

- `extractScenePrefabDeps(payload)` (`core/scene/scene-handle.ts`) — pure; walks a scene
  payload's node tree for embedded `prefabId`s. Not wired into any store; unused paths pay
  nothing. Exported via `bongle/internal`.
- `directProducersOf(consumer)` (`core/capture/dep-graph.ts`) — on-demand read of the
  reverse map (a consumer's direct producers). Exported via `bongle/internal`.

## Closure + hashing

`kit/pipeline/icon-deps.ts`:

- `iconDepClosure(internal, subject)` — interleaved transitive walk: expand **prefab**
  nodes via `directProducersOf`, **scene** nodes via `extractScenePrefabDeps`. Cycle-safe.
  Returns every producer the subject transitively depends on.
- `closureVersionDigest(internal, closure)` — stable `[registry:id, version]` list, read
  from each producer's registry handle `version` (which bumps on its own content/dep-set
  change).

`kit/pipeline/icon-hashes.ts`:

- `computePrefabIconHashes` → per prefab: `{ selfVersion, closureDigest, atlasHash,
  registrySlice, modelsSlice }`.
- `computeSceneIconHashes` → per scene: `{ bytesHash (disk, race-free self-identity),
  closureDigest, atlasHash, sceneRegistrySlice, modelsSlice }`.

`orchestrator.ts` is unchanged — it already gates per-id; the hashes are simply selective
now.

## Deliberate coarseness

- **Models** stay folded in whole (`modelsSlice` in every icon hash). A scene can reference
  a model via a `MeshTrait` with no dep edge, so closure-tracking models would miss it.
  A model edit re-renders all icons — acceptable, since model edits are rarer than logic
  edits and the alternative is walking every node tree for mesh refs.
- **Blocks / atlas** stay coarse via `atlasHash` + the block-registry slice — a block edit
  re-renders all icons.
- **Cold start** re-renders everything once (gating is in-memory only). If that startup
  cost ever matters, seed the orchestrator maps from disk on boot — a separate feature.

## Correctness note

The closure relies on the DepGraph being populated in the pipeline's `bongle/internal`
context (it is — `prefab()` / `scene()` run during codegen, calling `setDeps` / `addDeps`).
Scene→prefab edges come from the live registry payload (`_payload`), which can lag codegen
for brand-new blueprints; in that window a scene's closure is empty and its `bytesHash`
still drives its icon, so nothing is silently stale.
