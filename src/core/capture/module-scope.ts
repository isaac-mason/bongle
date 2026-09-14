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
 * per-module snapshots: every declarative api (block, tile, texture, model,
 * sound, sprite, particle, prefab, scene, command, config, trait, script) records
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
    beginRun(norm);
    for (const fn of pushHooks) fn(norm);
    return prev;
}

export function __popModule(_prev: string | null): void {
    const id = stack.pop();
    if (id === undefined) return;
    endRun(id);
    for (const fn of popHooks) fn(id);
}

export function owningModule(): string {
    return stack[stack.length - 1] ?? '__prod__';
}

/**
 * Clear the owning-module stack back to the engine (`__prod__`) scope.
 *
 * Called at the top of each flush microtask. By the time a flush runs, the
 * HMR batch's module bodies have all finished, so the stack SHOULD be empty
 * and `owningModule()` SHOULD be `__prod__`. But `__popModule` (injected as
 * the POSTLUDE) is NOT exception-safe: if a module body throws between
 * `__pushModule` (PRELUDE) and the pop, its id leaks on the stack forever.
 * Every later flush would then stamp engine-derived registrations (e.g. the
 * block-dust sprites `reindexRegistry` derives) with that stale module as
 * owner, tripping the registry's redeclaration guard against the `__prod__`
 * entry created at boot. Resetting here makes flush self-healing and keeps
 * engine reconciliation at its true `__prod__` scope. Snapshots are left
 * intact so the reload decision still sees each module's history.
 */
export function resetOwnerStack(): void {
    stack.length = 0;
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

/* ── per-module declaration signatures ──────────────────────────── */

/**
 * What each module declared, for the kinds the module boundary cares about:
 * `moduleId → kind → id → signature`. This is the structure the reload decision
 * diffs — the same job the old per-kind `ModuleSnapshot` did, minus the ten
 * buckets nothing read.
 *
 * Written by `registry-store`'s `commit`, from the one place a declaration
 * lands, so no call site has an extra step to remember and no kind can end up
 * half-tracked. It lives HERE rather than beside `commit` so the dependency
 * stays one-way — `registry-store` imports this module for the owning-module
 * stack, and the hook arrays above exist precisely to keep it from having to
 * import back.
 */
type ModuleSignatures = Map<string, Map<string, string>>;

type RunRecord = {
    /** signatures recorded during the run currently in progress. */
    current: ModuleSignatures;
    /** the last run that COMPLETED, i.e. what this run is compared against. */
    previous: ModuleSignatures | null;
    /** did the in-progress run's body reach `__popModule`? */
    completed: boolean;
};

const runs = new Map<string, RunRecord>();

function runFor(moduleId: string): RunRecord {
    let record = runs.get(moduleId);
    if (!record) {
        record = { current: new Map(), previous: null, completed: false };
        runs.set(moduleId, record);
    }
    return record;
}

/**
 * Start a run: the previous run's signatures become the baseline, but ONLY if
 * that run actually finished.
 *
 * `__popModule` is the POSTLUDE and does not run when a module body throws, so
 * a failed run leaves `current` holding a half-recorded set. Adopting that as
 * the baseline would mean the developer's fix-up run gets compared against the
 * broken one — a body change made in the broken edit and kept in the fix would
 * read as "unchanged" and patch, leaving importers on stale closures.
 */
function beginRun(moduleId: string): void {
    const record = runFor(moduleId);
    if (record.completed) record.previous = record.current;
    record.current = new Map();
    record.completed = false;
}

function endRun(moduleId: string): void {
    const record = runs.get(moduleId);
    if (record) record.completed = true;
}

/** record one declaration's signature against the module that made it. */
export function recordDeclaration(owner: string, kindName: string, id: string, signature: string): void {
    const byKind = runFor(owner).current;
    let byId = byKind.get(kindName);
    if (!byId) {
        byId = new Map();
        byKind.set(kindName, byId);
    }
    byId.set(id, signature);
}

/** has this module a completed earlier run to compare against? */
function hasPreviousRun(moduleId: string): boolean {
    return runs.get(moduleId)?.previous != null;
}

/** true when this run's signatures match the previous completed run's. */
function signaturesUnchanged(moduleId: string): boolean {
    const record = runs.get(moduleId);
    if (!record?.previous) return false;
    return sameSignatures(record.previous, record.current);
}

function sameSignatures(a: ModuleSignatures, b: ModuleSignatures): boolean {
    if (a.size !== b.size) return false;
    for (const [kindName, aIds] of a) {
        const bIds = b.get(kindName);
        if (!bIds || aIds.size !== bIds.size) return false;
        for (const [id, signature] of aIds) {
            if (bIds.get(id) !== signature) return false;
        }
    }
    return true;
}

/**
 * tests only, drop the module stack + recorded signatures so the next test
 * starts with no previous run poisoning the patch/invalidate diff.
 */
export function _reset(): void {
    stack.length = 0;
    runs.clear();
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
    const moduleId = normalizeModuleId(id);
    if (!hasPreviousRun(moduleId)) return 'initial';
    if (newModule && hasNonHandleExport(newModule)) return 'invalidate';
    return signaturesUnchanged(moduleId) ? 'patch' : 'invalidate';
}

/**
 * true if the module namespace has any export that isn't an engine handle.
 * Every declarative handle (trait, block, tile, texture, model, scene, prefab,
 * sound, sprite, particle, command, script) carries a DepGraph
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
    return (
        typeof dep === 'object' &&
        dep !== null &&
        typeof (dep as DepKey).registry === 'string' &&
        typeof (dep as DepKey).id === 'string'
    );
}
