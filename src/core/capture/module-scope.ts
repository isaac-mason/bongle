import type { DepHandle, DepKey } from './dep-graph';

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

// the bongle() vite plugin injects `__pushModule(import.meta.url)` at the top of every user file and
// `__popModule(prev)` at the bottom; the stack handles nested module evaluation under esm since child modules
// evaluate fully (push + body + pop) before the parent's body resumes.
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
 * Clears the owning-module stack back to `__prod__`, called at the top of each flush microtask.
 * `__popModule` (the injected postlude) isn't exception-safe: a module body that throws leaves its id on the
 * stack forever, which would stamp later engine-derived registrations with a stale owner. Snapshots are left
 * intact so the reload decision still sees each module's history.
 */
export function resetOwnerStack(): void {
    stack.length = 0;
}

// registries hook in here at construction time so they can clear their per-module pending set on push and
// fire `removed` for vanished ids on pop; kept as a hook array (not a direct registry.ts import) to avoid a
// circular dep, since registry.ts imports owningModule from here.
const pushHooks: Array<(moduleId: string) => void> = [];
const popHooks: Array<(moduleId: string) => void> = [];

export function onModulePush(fn: (moduleId: string) => void): void {
    pushHooks.push(fn);
}

export function onModulePop(fn: (moduleId: string) => void): void {
    popHooks.push(fn);
}

/**
 * What each module declared, for the kinds the module boundary cares about: moduleId maps to kind maps to id
 * maps to signature. This is the structure the reload decision diffs, written by `registry-store`'s `commit`
 * from the one place a declaration lands. Lives here rather than beside `commit` so the dependency stays
 * one-way: `registry-store` imports this module for the owning-module stack, and the hook arrays above exist
 * precisely to keep it from having to import back.
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
 * Start a run: the previous run's signatures become the baseline, but only if that run actually finished.
 * `__popModule` doesn't run when a module body throws, so a failed run leaves `current` half-recorded; adopting
 * that as the baseline would compare a fix-up run against the broken one and read a real change as "unchanged".
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

export type ReloadDecision = 'initial' | 'patch' | 'invalidate';

/**
 * Decides patch vs invalidate for a re-evaluated user module, mirroring React Fast Refresh's boundary rule: a
 * module may self-accept (patch its registered handles in place) only if every one of its exports is a
 * hot-swappable engine handle. Handles are patched by-reference so importers see new state through them; a
 * plain export (a helper fn, a constant) is captured by-value at import time, so any non-handle export forces
 * `invalidate` and Vite cascades to importers, each of which re-reads the fresh module and self-decides.
 * `newModule` is the freshly-evaluated module namespace, passed by the injected hot.accept callback.
 */
export function __decideReload(id: string, newModule?: Record<string, unknown>): ReloadDecision {
    const moduleId = normalizeModuleId(id);
    if (!hasPreviousRun(moduleId)) return 'initial';
    if (newModule && hasNonHandleExport(newModule)) return 'invalidate';
    return signaturesUnchanged(moduleId) ? 'patch' : 'invalidate';
}

/**
 * True if the module namespace has any export that isn't an engine handle. Every declarative handle carries a
 * DepGraph `dependency: { registry, id }` stamp, the shared brand tested for here; anything without it is
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
