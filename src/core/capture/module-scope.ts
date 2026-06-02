/**
 * core/capture/module-scope.ts — owning-module stack + per-module reload diff.
 *
 * the bongle() vite plugin injects `__pushModule(import.meta.url)` at the
 * top of every user file and `__popModule(prev)` at the bottom. while a
 * module's body evaluates, `owningModule()` returns its url, so `upsert`
 * calls in registry.ts can stamp each handle with its owning module.
 *
 * the stack handles nested module evaluation under esm — child modules
 * evaluate fully (push + body + pop) before the parent's body resumes.
 *
 * per-module snapshots: every declarative api (block, blockTexture, model,
 * modelHandle, prefab, scene, command, matchmaking, trait, script) records
 * into the current module's snapshot during evaluation. on a second
 * evaluation, the previous snapshot is diffed against the new one to decide
 * patch vs invalidate.
 *
 * the snapshot tracks two things:
 *   • presence — id sets for every declarative api. recorded for visibility
 *     and future introspection (debug panels, what-did-this-file-declare
 *     queries). not consulted by the diff today; wholesale consumer
 *     rebuilds via registry flush already propagate any content change.
 *   • shape — for traits, `paramKeys`; for scripts, the ordered list of
 *     `{traitId, hookSet, factoryHash}`. these are the only fields whose
 *     change requires importer cascade, because user call sites read them
 *     by name (trait param destructuring, script ordering by position).
 *
 * `__decideReload(id)` is called by the plugin's injected hot.accept
 * callback after the module re-evaluates. it returns 'initial' on first
 * evaluation, 'patch' if shape is stable, 'invalidate' otherwise. on
 * 'invalidate' the plugin calls `import.meta.hot.invalidate()` and vite
 * cascades to importers, each of whom self-decides locally.
 */

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
 * **stable reference** (handle mutated in place by the engine — scenes,
 * models) or looked up **by id at use time** (prefabs, atlas) are presence-
 * only and propagate via wholesale registry flush; their stale closures
 * see new data through the same reference, or fetch fresh on next call.
 *
 *   presence-only sets — blockTextures, blocks, models, prefabs, scenes,
 *     matchmaking, commands. recorded for visibility
 *     (debug overlays, "what does this file declare?") but not read by
 *     diffSnapshots. block content edits propagate via the flush path:
 *     `applyRegistryChanges` rebuilds BlockRegistry, refreshes the atlas,
 *     repoints per-room `voxels.registry`, and `resolveAllChunks` triggers
 *     a remesh on the next tick. Stale BlockHandle references in script
 *     closures keep their old state encoder — accepted limitation, since
 *     invalidating on block edits would cascade past userSrcDir into the
 *     .bongle bootstrap entry (no self-accept there) and force a full
 *     page reload.
 *   traits — `bodyHash` over the entire trait body. scripts destructure
 *     trait params by name, capturing field shape; any body delta is an
 *     api contract change → invalidate.
 *   scripts — order-bearing list of `{ traitId, factoryHash }`. ScriptDef
 *     index is assigned by call order; traitId at position is the binding
 *     contract; factoryHash is content for patch-path swaps.
 *   commands — wire indexing is decoupled from registration order via
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
    scripts: Array<{ traitId: string; factoryHash: string }>;
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
        scripts: [],
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
 * tests only — drop the module stack + all per-module snapshots so the
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
 * the body — added/removed key, default value tweak, factory swap — flips
 * the hash and forces importer cascade. rationale: a default value change
 * can silently be a type change (number → string, vec3 factory → quat
 * factory), so we treat any body delta as needing fresh script closures.
 */
export function recordTrait(id: string, bodyHash: string): void {
    currentSnapshot()?.traits.set(id, { bodyHash });
}

/**
 * record one script registration's shape. order matters — array position
 * must match the ScriptDef.index assigned in scripts.ts. scripts reload as
 * a unit (no per-hook granularity) so only traitId binding participates in
 * the diff; factoryHash is content-bearing, handled by registry flush.
 */
export function recordScript(traitId: string, factoryHash: string): void {
    currentSnapshot()?.scripts.push({ traitId, factoryHash });
}

/* ── reload decision ────────────────────────────────────────────── */

export type ReloadDecision = 'initial' | 'patch' | 'invalidate';

export function __decideReload(id: string): ReloadDecision {
    const pair = snapshots.get(normalizeModuleId(id));
    if (!pair || !pair.previous) return 'initial';
    return diffSnapshots(pair.previous, pair.current) ? 'patch' : 'invalidate';
}

/**
 * returns true if shapes are equal (→ patch is safe). false → invalidate.
 *
 *   1. trait id sets equal AND every shared trait's bodyHash identical.
 *   2. script array same length AND every position's traitId identical.
 *
 * everything else (blockTextures, blocks, models, prefabs,
 * scenes, commands, matchmaking) is presence-only and propagates via the
 * flush path — `applyRegistryChanges` does a wholesale rebuild on
 * `blocksRegistry.pendingChanges` / `blockTexturesRegistry.pendingChanges`:
 * BlockRegistry rebuilt, atlas refreshed (short-circuits on hash equality),
 * per-room `voxels.registry` repointed, `resolveAllChunks` marks every
 * chunk dirty for the next mesher tick. Stale BlockHandle references in
 * script-factory closures keep their old state encoder, which is an
 * accepted limitation (script-factory swaps are the trait/script path,
 * not the block path) — invalidating on block edits would cascade past
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

    if (prev.scripts.length !== curr.scripts.length) return false;
    for (let i = 0; i < prev.scripts.length; i++) {
        if (prev.scripts[i].traitId !== curr.scripts[i].traitId) return false;
    }

    return true;
}
