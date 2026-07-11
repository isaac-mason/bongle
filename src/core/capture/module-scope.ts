/**
 * core/capture/module-scope.ts, owning-module stack + per-module reload diff.
 *
 * the bongle() vite plugin injects `__pushModule(import.meta.url)` at the
 * top of every user file and `__popModule(prev)` at the bottom. while a
 * module's body evaluates, `owningModule()` returns its url, so `upsert`
 * calls in registry.ts can stamp each handle with its owning module.
 *
 * the stack handles nested module evaluation under esm, child modules
 * evaluate fully (push + body + pop) before the parent's body resumes.
 *
 * per-module snapshots: every declarative api (block, blockTexture, model,
 * modelHandle, prefab, scene, command, matchmaking, trait, script) records
 * into the current module's snapshot during evaluation. on a second
 * evaluation, the previous snapshot is diffed against the new one to decide
 * patch vs invalidate.
 *
 * the snapshot tracks two things:
 *   • presence, id sets for every declarative api. recorded for visibility
 *     and future introspection (debug panels, what-did-this-file-declare
 *     queries). not consulted by the diff today; wholesale consumer
 *     rebuilds via registry flush already propagate any content change.
 *   • shape, for traits, the body hash; for scripts, the set of declared
 *     keys (`${traitId}.${scriptId}`). a change here requires importer
 *     cascade: a trait body delta can change the field shape scripts
 *     destructure, and adding/removing/renaming a script key changes the
 *     binding identity that the instance map and registry are keyed on.
 *
 * `__decideReload(id, newModule)` is called by the plugin's injected
 * hot.accept callback after the module re-evaluates, with the fresh module
 * namespace. it returns 'initial' on first evaluation, 'patch' only when the
 * module's exports are all hot-swappable handles AND the trait/script shape is
 * stable, 'invalidate' otherwise (a non-handle export, or a shape change). on
 * 'invalidate' the plugin calls `import.meta.hot.invalidate()` and vite
 * cascades to importers, each of whom self-decides locally.
 */

import type { DepHandle, DepKey } from './dep-graph';

/* ── module-scope stack ─────────────────────────────────────────── */

const stack: string[] = [];

/**
 * Strip query + hash so HMR-rewritten urls (vite appends `?t=N` on every
 * update) collide with the original load's url in the snapshot map and
 * the registry's `byModule` / handle `.module` fields. Without this,
 * every re-eval looks like a *different* module redeclaring the same id
 * and the registry's ownership guard throws.
 */
function normalizeModuleId(id: string): string {
    const q = id.indexOf('?');
    const h = id.indexOf('#');
    let end = id.length;
    if (q !== -1) end = q;
    if (h !== -1 && h < end) end = h;
    return end === id.length ? id : id.slice(0, end);
}

export function __pushModule(id: string): string | null {
    const norm = normalizeModuleId(id);
    const prev = stack.length ? stack[stack.length - 1] : null;
    stack.push(norm);
    rotateSnapshot(norm);
    for (const fn of pushHooks) fn(norm);
    return prev;
}

export function __popModule(_prev: string | null): void {
    const id = stack.pop();
    if (id === undefined) return;
    for (const fn of popHooks) fn(id);
}

export function owningModule(): string {
    return stack[stack.length - 1] ?? '__prod__';
}

/* ── lifecycle hooks ────────────────────────────────────────────── */

/**
 * registries hook in here at construction time so they can clear their
 * per-module pending set on push and fire `removed` for vanished ids on
 * pop. kept as a hook array rather than a direct registry.ts import to
 * avoid a circular dep (registry.ts imports owningModule from here).
 */
const pushHooks: Array<(moduleId: string) => void> = [];
const popHooks: Array<(moduleId: string) => void> = [];

export function onModulePush(fn: (moduleId: string) => void): void {
    pushHooks.push(fn);
}

export function onModulePop(fn: (moduleId: string) => void): void {
    popHooks.push(fn);
}

/* ── per-module snapshot ────────────────────────────────────────── */

/**
 * registration record for one user module.
 *
 * the framework for what each field tracks: a resource contributes to the
 * patch-vs-invalidate diff only if user code (or engine consumers) captures
 * its content **by value** at evaluation time. resources captured by
 * **stable reference** (handle mutated in place by the engine, scenes,
 * models) or looked up **by id at use time** (prefabs, atlas) are presence-
 * only and propagate via wholesale registry flush; their stale closures
 * see new data through the same reference, or fetch fresh on next call.
 *
 *   presence-only sets, blockTextures, blocks, models, prefabs, scenes,
 *     matchmaking, commands. recorded for visibility
 *     (debug overlays, "what does this file declare?") but not read by
 *     diffSnapshots. block content edits propagate via the flush path:
 *     `applyRegistryChanges` rebuilds BlockRegistry, refreshes the atlas,
 *     repoints per-room `voxels.registry`, and `resolveAllChunks` triggers
 *     a remesh on the next tick. Stale BlockHandle references in script
 *     closures keep their old state encoder, accepted limitation, since
 *     invalidating on block edits would cascade past userSrcDir into the
 *     .bongle bootstrap entry (no self-accept there) and force a full
 *     page reload.
 *   traits, `bodyHash` over the entire trait body. scripts destructure
 *     trait params by name, capturing field shape; any body delta is an
 *     api contract change → invalidate.
 *   scripts, set of declared keys (`${traitId}.${scriptId}`). the key is a
 *     script's binding identity (instance map key + registry id); set
 *     equality means only factory bodies changed (swapped in place via the
 *     flush path), any key delta is a shape change → invalidate.
 *   commands, wire indexing is decoupled from registration order via
 *     explicit protocol negotiation (server pushes the ordered command
 *     list on connect and on registry change); `send`/`broadcast` resolve
 *     serdes by id from the live `commandsRegistry` rather than embedding
 *     it in `CommandHandle`. presence-only.
 */
export type ModuleSnapshot = {
    blockTextures: Set<string>;
    blocks: Set<string>;
    models: Set<string>;
    sounds: Set<string>;
    sprites: Set<string>;
    particles: Set<string>;
    prefabs: Set<string>;
    scenes: Set<string>;
    matchmaking: Set<string>;
    traits: Map<string, { bodyHash: string }>;
    /** declared script keys (`${traitId}.${scriptId}`); set equality ⇒ patch, see shape note above. */
    scripts: Set<string>;
    commands: Set<string>;
};

type SnapshotPair = {
    previous: ModuleSnapshot | null;
    current: ModuleSnapshot;
};

const snapshots = new Map<string, SnapshotPair>();

function emptySnapshot(): ModuleSnapshot {
    return {
        blockTextures: new Set(),
        blocks: new Set(),
        models: new Set(),
        sounds: new Set(),
        sprites: new Set(),
        particles: new Set(),
        prefabs: new Set(),
        scenes: new Set(),
        matchmaking: new Set(),
        traits: new Map(),
        scripts: new Set(),
        commands: new Set(),
    };
}

/**
 * called by __pushModule on every (re-)evaluation. rotates current →
 * previous and starts a fresh current. subsequent record* calls during
 * module-body execution populate the new current snapshot.
 */
function rotateSnapshot(id: string): void {
    const existing = snapshots.get(id);
    if (existing) {
        snapshots.set(id, { previous: existing.current, current: emptySnapshot() });
    } else {
        snapshots.set(id, { previous: null, current: emptySnapshot() });
    }
}

/**
 * read-only access to the latest snapshot. useful for debug overlays
 * that want to list what a module declared without touching registry
 * internals. returns `null` if the module hasn't evaluated yet.
 */
export function getModuleSnapshot(id: string): ModuleSnapshot | null {
    return snapshots.get(id)?.current ?? null;
}

/**
 * tests only, drop the module stack + all per-module snapshots so the
 * next test starts with no "previous" snapshot poisoning the patch/invalidate
 * diff. paired with `registry.__resetForTests` from tst/e2e/harness.ts.
 */
export function _reset(): void {
    stack.length = 0;
    snapshots.clear();
}

/* ── snapshot recorders ─────────────────────────────────────────── */

function currentSnapshot(): ModuleSnapshot | null {
    const owner = owningModule();
    const pair = snapshots.get(owner);
    return pair ? pair.current : null;
}

export function recordBlockTexture(id: string): void {
    currentSnapshot()?.blockTextures.add(id);
}

export function recordBlock(id: string): void {
    currentSnapshot()?.blocks.add(id);
}

export function recordModel(id: string): void {
    currentSnapshot()?.models.add(id);
}

export function recordSound(id: string): void {
    currentSnapshot()?.sounds.add(id);
}

export function recordSprite(id: string): void {
    currentSnapshot()?.sprites.add(id);
}

export function recordParticle(id: string): void {
    currentSnapshot()?.particles.add(id);
}

export function recordPrefab(id: string): void {
    currentSnapshot()?.prefabs.add(id);
}

export function recordScene(id: string): void {
    currentSnapshot()?.scenes.add(id);
}

/**
 * record one command registration (presence only). commands are patch-safe
 * via explicit protocol negotiation (server pushes the ordered command list)
 * + serdes-lookup-at-use (send/broadcast resolve serdes from the live
 * registry by id), so commands do not participate in diffSnapshots.
 */
export function recordCommand(id: string): void {
    currentSnapshot()?.commands.add(id);
}

export function recordMatchmaking(id: string): void {
    currentSnapshot()?.matchmaking.add(id);
}

/**
 * record one trait registration's shape. bodyHash is a structural hash over
 * the entire body (literals by value, factories by toString). any change to
 * the body, added/removed key, default value tweak, factory swap, flips
 * the hash and forces importer cascade. rationale: a default value change
 * can silently be a type change (number → string, vec3 factory → quat
 * factory), so we treat any body delta as needing fresh script closures.
 */
export function recordTrait(id: string, bodyHash: string): void {
    currentSnapshot()?.traits.set(id, { bodyHash });
}

/**
 * record one script registration by its key (`${traitId}.${scriptId}`). the
 * diff is set-based: a script's identity is its key (also the instance map
 * key and registry id), so the patch-vs-invalidate decision only cares which
 * keys exist this run, not their order or factory bodies. body changes
 * propagate via the registry flush path (`applyTraitSwap`), not the snapshot.
 */
export function recordScript(key: string): void {
    currentSnapshot()?.scripts.add(key);
}

/* ── reload decision ────────────────────────────────────────────── */

export type ReloadDecision = 'initial' | 'patch' | 'invalidate';

/**
 * decide patch vs invalidate for a re-evaluated user module. `newModule` is
 * the freshly-evaluated module namespace (passed by the injected hot.accept
 * callback); we inspect its exports to decide whether the change can be
 * self-accepted or must cascade to importers.
 *
 * This mirrors React Fast Refresh's boundary rule: a module may self-accept
 * (patch its registered handles in place) only if EVERY one of its exports is
 * a hot-swappable engine handle. Handles are patched by-reference — importers
 * hold the same handle object and see new state through it — so they stay
 * current across a patch. A plain export (a helper fn, a constant, a
 * re-exported value) is captured by-VALUE at import time; patching in place
 * would leave importers bound to the stale binding until a full reload. So the
 * moment a module exports anything that isn't a handle, we invalidate and let
 * Vite cascade to importers (each re-reads the fresh module and self-decides).
 *
 * This subsumes the pure-helper case: `games/big-hill/src/course.ts` exports a
 * `generateCourse` function and no handles, so its export is non-handle →
 * invalidate → `world.ts` re-imports the fresh generator. A module with no
 * exports at all (pure side-effect: registers systems/scripts, exports
 * nothing) is vacuously all-handle and stays surgically patchable.
 */
export function __decideReload(id: string, newModule?: Record<string, unknown>): ReloadDecision {
    const pair = snapshots.get(normalizeModuleId(id));
    if (!pair?.previous) return 'initial';
    if (newModule && hasNonHandleExport(newModule)) return 'invalidate';
    return diffSnapshots(pair.previous, pair.current) ? 'patch' : 'invalidate';
}

/**
 * true if the module namespace has any export that isn't an engine handle.
 * Every declarative handle (trait, block, blockTexture, model, scene, prefab,
 * sound, sprite, particle, command, script, matchmaking) carries a DepGraph
 * `dependency: { registry, id }` stamp — that stamp is the shared brand we
 * test for. Anything without it (functions, constants, plain objects) is
 * captured by-value by importers and forces an importer cascade.
 */
function hasNonHandleExport(mod: Record<string, unknown>): boolean {
    for (const value of Object.values(mod)) {
        if (!isHandle(value)) return true;
    }
    return false;
}

function isHandle(value: unknown): value is DepHandle {
    if (typeof value !== 'object' || value === null) return false;
    const dep = (value as { dependency?: unknown }).dependency;
    return typeof dep === 'object' && dep !== null && typeof (dep as DepKey).registry === 'string' && typeof (dep as DepKey).id === 'string';
}

/**
 * returns true if shapes are equal (→ patch is safe). false → invalidate.
 *
 *   1. trait id sets equal AND every shared trait's bodyHash identical.
 *   2. declared script-key sets equal (a script's key is its binding
 *      identity, same set means only factory bodies changed, which the
 *      registry flush path swaps in place; a key added/removed/renamed or
 *      reparented to another trait is a shape change → invalidate).
 *
 * everything else (blockTextures, blocks, models, prefabs,
 * scenes, commands, matchmaking) is presence-only and propagates via the
 * flush path, `applyRegistryChanges` does a wholesale rebuild on
 * `blocksRegistry.pendingChanges` / `blockTexturesRegistry.pendingChanges`:
 * BlockRegistry rebuilt, atlas refreshed (short-circuits on hash equality),
 * per-room `voxels.registry` repointed, `resolveAllChunks` marks every
 * chunk dirty for the next mesher tick. Stale BlockHandle references in
 * script-factory closures keep their old state encoder, which is an
 * accepted limitation (script-factory swaps are the trait/script path,
 * not the block path), invalidating on block edits would cascade past
 * the userSrcDir boundary into the .bongle bootstrap entry, which has
 * no self-accept and forces a full page reload.
 */
function diffSnapshots(prev: ModuleSnapshot, curr: ModuleSnapshot): boolean {
    if (prev.traits.size !== curr.traits.size) return false;
    for (const [id, prevShape] of prev.traits) {
        const currShape = curr.traits.get(id);
        if (!currShape) return false;
        if (prevShape.bodyHash !== currShape.bodyHash) return false;
    }

    if (prev.scripts.size !== curr.scripts.size) return false;
    for (const key of prev.scripts) {
        if (!curr.scripts.has(key)) return false;
    }

    return true;
}
