// editor/platform/autosave.ts — editor-side autosave driver.
//
// A DRAFT is uncommitted working state; the platform persists it (local ring
// always, server when owned + dirty) keyed by the version it descends from. This
// module's job is narrow: turn genuine document edits into throttled
// `bongle:draft` hand-backs over the platform bridge. It never mints a version
// and never touches storage itself — it emits bytes + the opaque baseVersion/rev
// tokens and lets the platform decide durability.
//
// Two session kinds ride the SAME draft stream (the payload is opaque to the
// platform): a PROJECT emits its source zip; an AVATAR emits its .bbmodel source
// text (Blockbench autosaves it into the fs on a debounce — see Blockbench.tsx).
//
// Safety property (the "un-scary" half): autosave ARMS on a real fs edit only.
// Load / open-version / restore write into the fs before this module subscribes
// (or produce no genuine mutation), so browsing an old version emits zero edits
// and therefore zero autosaves — nothing older can clobber newer work.

import type { Filesystem, FsChange } from '../fs';
import { exportProjectSave } from '../project-save';
import { useAutosave } from '../stores/autosave';
import type { PlatformBridge } from './bridge';
import type { PlatformIntent, PlatformResult } from './contract';

// the avatar source the crash-net snapshots — matches main.tsx's avatar boot path.
const AVATAR_SOURCE_PATH = 'avatar.bbmodel';

/** idle window before a pending autosave fires (debounce trailing edge). */
const IDLE_MS = 10_000;
/** floor between two consecutive fires, so a steady stream of edits can't drive
 *  autosave faster than this cadence. */
const MIN_INTERVAL_MS = 10_000;

type State = {
    fs: Filesystem;
    bridge: PlatformBridge;
    /** which session this is — decides how a draft payload is built (project source
     *  zip vs avatar .bbmodel source) and which fs edits arm it. */
    kind: 'project' | 'avatar';
    /** the version the current draft descends from (opaque round-trip token).
     *  null for anonymous. Advances to the minted head on a successful save. */
    baseVersion: string | null;
    /** local monotonic edit counter. Seeded ABOVE the opened slot's stored rev so
     *  the server (which rejects writes ≤ stored rev) accepts our first fire. */
    rev: number;
    /** the setTimeout handle for the pending debounced fire, or null when idle. */
    pending: ReturnType<typeof setTimeout> | null;
    /** performance.now() of the last fire, for the min-interval floor. */
    lastFireAt: number;
};

/** wire autosave to the platform bridge + fs change stream. No-op when standalone
 *  (nothing to persist to) — the caller still calls this; it just parks. Returns a
 *  disposer that drops the fs subscription. */
export function initAutosave(fs: Filesystem, bridge: PlatformBridge, intent: PlatformIntent | null): () => void {
    // standalone (no platform) or a join-guest session: nothing to autosave into.
    if (!bridge.embedded() || (intent?.kind !== 'project' && intent?.kind !== 'avatar')) return () => {};

    const state: State = {
        fs,
        bridge,
        kind: intent.kind,
        // avatars are always anonymous local drafts for now (owned-avatar server sync
        // is a later tier); a project carries its opaque base-version token.
        baseVersion: intent.kind === 'project' ? (intent.baseVersion ?? null) : null,
        // resume ABOVE the opened slot's stored rev; fresh slots start at 0.
        rev: intent.kind === 'project' ? (intent.rev ?? 0) : 0,
        pending: null,
        lastFireAt: Number.NEGATIVE_INFINITY,
    };

    // arm on a genuine edit only. The fs watcher fires per flushed batch; the
    // first batch after load arms the debounce, each subsequent one re-arms it.
    const watch = fs.watch((changes) => onEdit(state, changes));

    // rebase on a successful manual save: adopt the minted head as the new base
    // and reset the counter, so subsequent autosaves land in draft@versionId.
    const offResult = bridge.onResult((r) => onSaveResult(state, r));

    // expose an on-demand flush for the "Save draft" button (force a snapshot now).
    useAutosave.getState().register(() => flushNow(state));

    return () => {
        watch.close();
        offResult();
        useAutosave.getState().register(null);
        if (state.pending !== null) clearTimeout(state.pending);
    };
}

/** a flushed batch of fs changes. Any real change (re)arms the debounced fire.
 *  An avatar session only cares about its .bbmodel source — ignore the derived
 *  glb writes (and everything else) so a save's glb doesn't re-emit the same source. */
function onEdit(state: State, changes: FsChange[]): void {
    const relevant = state.kind === 'avatar' ? changes.filter((c) => c.path === AVATAR_SOURCE_PATH) : changes;
    if (relevant.length === 0) return;
    state.rev += 1; // monotonic per genuine edit batch
    arm(state);
}

/** (re)schedule the trailing-edge fire, respecting the min-interval floor. */
function arm(state: State): void {
    if (state.pending !== null) clearTimeout(state.pending);
    const sinceLast = performance.now() - state.lastFireAt;
    const delay = Math.max(IDLE_MS, MIN_INTERVAL_MS - sinceLast);
    state.pending = setTimeout(() => {
        state.pending = null;
        void fire(state);
    }, delay);
}

/** force an immediate draft snapshot ("Save draft" button) — cancel any pending
 *  debounced fire and snapshot now. Bumps rev so the fire carries a fresh revision
 *  the server accepts; identical content is deduped downstream (local ring + the
 *  server's sha guard), so a no-change save is a cheap no-op. */
async function flushNow(state: State): Promise<void> {
    if (state.pending !== null) {
        clearTimeout(state.pending);
        state.pending = null;
    }
    state.rev += 1;
    await fire(state);
}

/** export the current source + hand it back as an autosave snapshot. A project
 *  ships its source zip; an avatar ships its raw .bbmodel source bytes (the
 *  platform stores the payload opaquely and reseeds it on restore). */
async function fire(state: State): Promise<void> {
    state.lastFireAt = performance.now();
    let payload: Uint8Array;
    if (state.kind === 'avatar') {
        try {
            payload = new TextEncoder().encode(await state.fs.readText(AVATAR_SOURCE_PATH));
        } catch {
            return; // source not written yet — nothing to snapshot this tick
        }
    } else {
        // exportProjectSave() is a level-0 (STORE) zip — fast enough inline at this
        // cadence. If it ever janks the editor, move it to a worker (measure first).
        payload = await exportProjectSave(state.fs);
    }
    state.bridge.send({ type: 'bongle:draft', payload, baseVersion: state.baseVersion, rev: state.rev });
}

/** a save OR a build mints a manual version the draft now descends from; adopt it as
 *  the new base and reset the counter to its rev — a clean draft@versionId slot — then
 *  keep autosaving into it. Both carry `versionId`; failed / token-less results are
 *  ignored. (A build mints a version just like a save, so it rebases the same way.) */
function onSaveResult(state: State, r: PlatformResult): void {
    if ((r.of !== 'version' && r.of !== 'build') || !r.ok || r.versionId === undefined) return;
    state.baseVersion = r.versionId;
    if (r.rev !== undefined) state.rev = r.rev;
}
