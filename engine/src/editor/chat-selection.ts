/**
 * WorldEdit-style selection slash commands.
 *
 * Shape selectors (`/select box`, `/select sphere`, …) rasterise a primitive
 * centred on the hovered voxel. Region modifiers (`/expand`, `/contract`,
 * `/shift`, `/outset`, `/inset`) transform the current voxel selection.
 * Introspection (`/size`, `/count`, `/distr`) reports state.
 *
 * Set-algebra composition via `--add` / `--sub` / `--int` (default replaces).
 * Voxel / node targeting via `--voxels` / `--no-voxels` / `--nodes` /
 * `--no-nodes`; defaults follow the store's sticky `selectTarget`.
 *
 * Nodes are recomputed after every voxel mutation via `rebuildNodeSelection`
 * (origin-in-region), so node selection automatically tracks the voxel set
 * across expand / contract / shift.
 */
import type { ArgType, CommandHandler, CommandSpec, Suggestion } from '../core/chat-commands';
import * as ChatCommands from '../core/chat-commands';
import * as ClientChat from '../client/chat';
import type { ChatClient } from '../client/chat';
import type { Physics } from '../core/physics/physics';
import { registry } from '../core/registry';
import * as Selection from '../core/scene/selection';
import type { ScriptContext } from '../core/scene/scripts';
import { fuzzyRank } from '../core/utils/fuzzy';
import { parseKey } from '../core/voxels/block-registry';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, getBlockKey, toChunkCoord } from '../core/voxels/voxels';
import type { EditRoomStoreApi, SelectTarget } from './edit-room-store';
import type { NodeBodies } from './node-bodies';
import { parseMask, testMask, type Mask } from './scene/mask';
import { rebuildNodeSelection } from './scene/node-selection';
import { buildShape, type BrushShape } from './scene/shapes';

// ── direction tokens ───────────────────────────────────────────────

type DirectionVec = readonly [number, number, number];

// WE convention: north = -z, south = +z, east = +x, west = -x.
const DIR_TOKENS: Record<string, readonly DirectionVec[]> = {
    up: [[0, 1, 0]],
    u: [[0, 1, 0]],
    down: [[0, -1, 0]],
    d: [[0, -1, 0]],
    north: [[0, 0, -1]],
    n: [[0, 0, -1]],
    south: [[0, 0, 1]],
    s: [[0, 0, 1]],
    east: [[1, 0, 0]],
    e: [[1, 0, 0]],
    west: [[-1, 0, 0]],
    w: [[-1, 0, 0]],
    vert: [[0, 1, 0], [0, -1, 0]],
    all: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
};

const DirectionArg: ArgType<readonly DirectionVec[]> = {
    name: 'direction',
    parse: (s) => {
        const d = DIR_TOKENS[s.toLowerCase()];
        if (!d) return { ok: false, error: `unknown direction: ${s}` };
        return { ok: true, value: d };
    },
    suggest: (partial) => {
        const p = partial.toLowerCase();
        return Object.keys(DIR_TOKENS)
            .filter((k) => k.startsWith(p))
            .map<Suggestion>((k) => ({ text: k }));
    },
    describe: () => 'up | down | n | s | e | w | all | vert',
};

// ── flag helpers ───────────────────────────────────────────────────

type Target = { voxels: boolean; nodes: boolean };

/** resolve target flags against the sticky selectTarget (positive wins on conflict). */
function resolveTarget(flags: Record<string, boolean>, sticky: SelectTarget): Target {
    const voxels = flags['voxels'] ? true : flags['no-voxels'] ? false : sticky !== 'nodes';
    const nodes = flags['nodes'] ? true : flags['no-nodes'] ? false : sticky !== 'voxels';
    return { voxels, nodes };
}

// flag specs shared by every selection command — keeps suggestions uniform.
const TARGET_FLAGS = [
    { name: 'voxels', description: 'include voxels in this op' },
    { name: 'no-voxels', description: 'exclude voxels from this op' },
    { name: 'nodes', description: 'include nodes in this op' },
    { name: 'no-nodes', description: 'exclude nodes from this op' },
] as const;

const ALGEBRA_FLAGS = [
    { name: 'add', description: 'union with current selection' },
    { name: 'sub', description: 'subtract from current selection' },
    { name: 'int', description: 'intersect with current selection' },
] as const;

const SHAPE_FLAGS = [...ALGEBRA_FLAGS, ...TARGET_FLAGS];

/**
 * Combine the freshly-built `scratch` selection with `current` per the
 * `--add` / `--sub` / `--int` flags. Default (no flag) replaces.
 * Always returns a fresh Selection reference (callers rely on identity
 * change for reactivity).
 */
function compose(current: Selection.Selection, scratch: Selection.Selection, flags: Record<string, boolean>): Selection.Selection {
    if (flags['add']) {
        const next = Selection.clone(current);
        Selection.merge(next, scratch);
        return next;
    }
    if (flags['sub']) {
        const next = Selection.clone(current);
        Selection.subtract(next, scratch);
        return next;
    }
    if (flags['int']) {
        const next = Selection.clone(current);
        Selection.intersect(next, scratch);
        return next;
    }
    // replace: use the scratch directly (already a fresh object).
    return scratch;
}

// ── mask arg (local) ───────────────────────────────────────────────
// thin variant of chat-commands.ts's MaskArg — no in-selection ranking
// because /count's mask is about classifying voxels, not contextual.
// keep it simple; if we need cross-feature consistency later, lift the
// shared closure-built version out of chat-commands.ts.

const MaskArg: ArgType<Mask> = {
    name: 'mask',
    parse: (s) => {
        try {
            return { ok: true, value: parseMask(s) };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    },
    suggest: (partial) => {
        if (partial.startsWith('#') || partial.startsWith('%')) return [];
        const defs = registry.blockRegistry.defs.filter((d) => d.id !== 'air');
        return fuzzyRank(partial, defs, (d) => d.id).map<Suggestion>(({ item: d }) => ({
            text: d.id,
            detail: d.name !== d.id ? d.name : undefined,
        }));
    },
    describe: () => 'a mask (e.g. stone, !air, stone,dirt, #existing, %50)',
};

// ── install ────────────────────────────────────────────────────────

export function installSelectionChatCommands(
    chat: ChatClient,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    physics: Physics | null,
    nodeBodies: NodeBodies | null,
    unsubs: Array<() => void>,
): void {
    function install(spec: CommandSpec, fn: CommandHandler): void {
        ChatCommands.register(chat.commands, spec);
        const off = ChatCommands.addListener(chat.commands, spec.name, fn);
        unsubs.push(() => {
            off();
            ChatCommands.unregister(chat.commands, spec.name);
        });
    }

    function emit(text: string): void {
        ClientChat.appendLine(chat, { kind: 'system', text });
    }

    /**
     * Finalise a freshly-built shape selection: query nodes if requested,
     * gate voxels/nodes by the target filter, compose with current
     * selection per the algebra flag, and commit.
     */
    function commitShape(scratch: Selection.Selection, flags: Record<string, boolean>, target: Target): void {
        if (target.nodes) {
            rebuildNodeSelection(scratch, ctx, physics, nodeBodies);
        } else {
            scratch.nodes.clear();
        }
        if (!target.voxels) scratch.chunks.clear();

        const next = compose(store.getState().selection, scratch, flags);
        store.setState({ selection: next });
    }

    /**
     * Anchor point for a new shape selection: floored midpoint of the current
     * selection's bounds if non-empty, otherwise the currently-hovered voxel.
     * Returns `null` when neither is available (caller should bail with a hint).
     */
    function anchorPoint(): [number, number, number] | null {
        const sel = store.getState().selection;
        const b = Selection.bounds(sel);
        if (b) {
            return [
                Math.floor((b.min[0] + b.max[0]) / 2),
                Math.floor((b.min[1] + b.max[1]) / 2),
                Math.floor((b.min[2] + b.max[2]) / 2),
            ];
        }
        const hv = store.getState().hoverVoxel;
        return hv ? [hv[0], hv[1], hv[2]] : null;
    }

    function reportShape(verb: string, sel: Selection.Selection): void {
        const v = Selection.countVoxels(sel);
        const n = sel.nodes.size;
        const parts: string[] = [];
        if (v) parts.push(`${v} voxel${v === 1 ? '' : 's'}`);
        if (n) parts.push(`${n} node${n === 1 ? '' : 's'}`);
        emit(parts.length ? `${verb}: ${parts.join(' + ')}` : `${verb}: nothing selected`);
    }

    // ── shape selectors ────────────────────────────────────────────

    function installShape(label: string, shape: BrushShape, includeHeight: boolean): void {
        const args: CommandSpec['args'] = [{ name: 'size', type: 'number', optional: true }];
        if (includeHeight) args.push({ name: 'height', type: 'number', optional: true });

        install(
            {
                name: `/select ${label}`,
                description: `select a ${label} centred on the hovered voxel`,
                args,
                flags: [...SHAPE_FLAGS],
            },
            ({ args, flags }) => {
                const anchor = anchorPoint();
                if (!anchor) {
                    emit('hover a voxel or make a selection to anchor the shape');
                    return;
                }
                const size = Math.max(0, Math.floor((args.size as number | undefined) ?? 4));
                const height = Math.max(1, Math.floor((args.height as number | undefined) ?? 1));
                const target = resolveTarget(flags, store.getState().selectTarget);

                const scratch = Selection.create();
                buildShape(scratch, shape, anchor[0], anchor[1], anchor[2], size, height);
                commitShape(scratch, flags, target);
                reportShape(`/select ${label}`, store.getState().selection);
            },
        );
    }

    // 'box' is the user-facing name for a cube shape (matches WorldEdit).
    installShape('box', 'cube', false);
    installShape('sphere', 'sphere', false);
    installShape('cylinder', 'cylinder', true);
    installShape('disc', 'disc', false);

    install(
        {
            name: '/select chunk',
            description: 'select the 16³ chunk containing the hovered voxel',
            args: [],
            flags: [...SHAPE_FLAGS],
        },
        ({ flags }) => {
            const anchor = anchorPoint();
            if (!anchor) {
                emit('hover a voxel or make a selection to anchor the chunk');
                return;
            }
            const cx = toChunkCoord(anchor[0]);
            const cy = toChunkCoord(anchor[1]);
            const cz = toChunkCoord(anchor[2]);
            const wxBase = cx << CHUNK_BITS;
            const wyBase = cy << CHUNK_BITS;
            const wzBase = cz << CHUNK_BITS;
            const target = resolveTarget(flags, store.getState().selectTarget);

            const scratch = Selection.create();
            Selection.setAABB(
                scratch,
                wxBase,
                wyBase,
                wzBase,
                wxBase + CHUNK_SIZE - 1,
                wyBase + CHUNK_SIZE - 1,
                wzBase + CHUNK_SIZE - 1,
            );
            commitShape(scratch, flags, target);
            reportShape('/select chunk', store.getState().selection);
        },
    );

    install(
        { name: '/desel', description: 'clear the current selection', args: [] },
        () => {
            store.setState({ selection: Selection.create() });
            emit('selection cleared');
        },
    );

    // ── region modifiers ───────────────────────────────────────────

    /**
     * Expand the voxel selection by `n` voxels along each direction in `dirs`.
     * Each axis is swept independently against the accumulated result, so
     * `dirs=all` produces a `(2n+1)³` cuboid envelope (WE semantics) — not the
     * octahedron you'd get from iterating a 6-neighbour Minkowski dilation.
     */
    function grow(sel: Selection.Selection, n: number, dirs: readonly DirectionVec[]): Selection.Selection {
        let current = sel;
        const scratch = Selection.create();
        for (const [dx, dy, dz] of dirs) {
            const accumulated = Selection.clone(current);
            for (let i = 1; i <= n; i++) {
                scratch.chunks.clear();
                scratch.nodes.clear();
                Selection.nudge(scratch, current, dx * i, dy * i, dz * i);
                Selection.merge(accumulated, scratch);
            }
            current = accumulated;
        }
        return current;
    }

    /**
     * Inverse of `grow`: Minkowski erosion by the same per-axis line segment.
     * A voxel `v` survives the sweep along `d` iff `v + d, v + 2d, … v + nd`
     * are all in `current`. Equivalent to intersecting with the inverse-shifted
     * copies; iterated per direction so `dirs=all` strips n layers off each face.
     */
    function shrink(sel: Selection.Selection, n: number, dirs: readonly DirectionVec[]): Selection.Selection {
        let current = sel;
        const scratch = Selection.create();
        for (const [dx, dy, dz] of dirs) {
            let eroded = Selection.clone(current);
            for (let i = 1; i <= n; i++) {
                scratch.chunks.clear();
                scratch.nodes.clear();
                Selection.nudge(scratch, current, -dx * i, -dy * i, -dz * i);
                Selection.intersect(eroded, scratch);
            }
            current = eroded;
        }
        return current;
    }

    function commitTransformed(next: Selection.Selection, target: Target): void {
        // node rebuild uses the *transformed* voxel set even when voxels are
        // about to be reverted — that lets `--nodes --no-voxels` track what
        // the transform would have selected without disturbing voxels.
        if (target.nodes) {
            rebuildNodeSelection(next, ctx, physics, nodeBodies);
        } else {
            const prev = store.getState().selection;
            next.nodes.clear();
            for (const id of prev.nodes) next.nodes.add(id);
        }
        if (!target.voxels) {
            const prev = store.getState().selection;
            next.chunks.clear();
            for (const [k, c] of prev.chunks) {
                next.chunks.set(k, { bits: new Uint32Array(c.bits) });
            }
        }
        store.setState({ selection: next });
    }

    install(
        {
            name: '/expand',
            description: 'grow the selection by n voxels (direction defaults to all)',
            args: [
                { name: 'n', type: 'number' },
                { name: 'direction', type: DirectionArg as ArgType<unknown>, optional: true },
            ],
            flags: [...TARGET_FLAGS],
        },
        ({ args, flags }) => {
            const n = Math.max(0, Math.floor((args.n as number | undefined) ?? 0));
            const dirs = (args.direction as readonly DirectionVec[] | undefined) ?? DIR_TOKENS['all']!;
            const target = resolveTarget(flags, store.getState().selectTarget);
            const sel = store.getState().selection;
            if (Selection.isEmpty(sel)) {
                emit('nothing to expand');
                return;
            }
            const next = grow(sel, n, dirs);
            commitTransformed(next, target);
            emit(`expanded by ${n}`);
        },
    );

    install(
        {
            name: '/contract',
            description: 'shrink the selection by n voxels (direction defaults to all)',
            args: [
                { name: 'n', type: 'number' },
                { name: 'direction', type: DirectionArg as ArgType<unknown>, optional: true },
            ],
            flags: [...TARGET_FLAGS],
        },
        ({ args, flags }) => {
            const n = Math.max(0, Math.floor((args.n as number | undefined) ?? 0));
            const dirs = (args.direction as readonly DirectionVec[] | undefined) ?? DIR_TOKENS['all']!;
            const target = resolveTarget(flags, store.getState().selectTarget);
            const sel = store.getState().selection;
            if (Selection.isEmpty(sel)) {
                emit('nothing to contract');
                return;
            }
            const next = shrink(sel, n, dirs);
            commitTransformed(next, target);
            emit(`contracted by ${n}`);
        },
    );

    install(
        {
            name: '/outset',
            description: 'expand the selection by n voxels on all sides (alias of /expand n all)',
            args: [{ name: 'n', type: 'number' }],
            flags: [...TARGET_FLAGS],
        },
        ({ args, flags }) => {
            const n = Math.max(0, Math.floor((args.n as number | undefined) ?? 0));
            const target = resolveTarget(flags, store.getState().selectTarget);
            const sel = store.getState().selection;
            if (Selection.isEmpty(sel)) {
                emit('nothing to outset');
                return;
            }
            const next = grow(sel, n, DIR_TOKENS['all']!);
            commitTransformed(next, target);
            emit(`outset by ${n}`);
        },
    );

    install(
        {
            name: '/inset',
            description: 'shrink the selection by n voxels on all sides (alias of /contract n all)',
            args: [{ name: 'n', type: 'number' }],
            flags: [...TARGET_FLAGS],
        },
        ({ args, flags }) => {
            const n = Math.max(0, Math.floor((args.n as number | undefined) ?? 0));
            const target = resolveTarget(flags, store.getState().selectTarget);
            const sel = store.getState().selection;
            if (Selection.isEmpty(sel)) {
                emit('nothing to inset');
                return;
            }
            const next = shrink(sel, n, DIR_TOKENS['all']!);
            commitTransformed(next, target);
            emit(`inset by ${n}`);
        },
    );

    install(
        {
            name: '/shift',
            description: 'translate the selection by n voxels (direction defaults to up)',
            args: [
                { name: 'n', type: 'number' },
                { name: 'direction', type: DirectionArg as ArgType<unknown>, optional: true },
            ],
            flags: [...TARGET_FLAGS],
        },
        ({ args, flags }) => {
            const n = Math.floor((args.n as number | undefined) ?? 0);
            // shift uses a single direction; collapse multi-axis dirs (all/vert)
            // by summing their first component — practically callers will use a
            // single-axis token. error if user passed a multi-axis one.
            const dirs = (args.direction as readonly DirectionVec[] | undefined) ?? DIR_TOKENS['up']!;
            if (dirs.length !== 1) {
                emit('shift requires a single-axis direction (use up/down/n/s/e/w)');
                return;
            }
            const target = resolveTarget(flags, store.getState().selectTarget);
            const sel = store.getState().selection;
            if (Selection.isEmpty(sel)) {
                emit('nothing to shift');
                return;
            }
            const [dx, dy, dz] = dirs[0]!;
            const next = Selection.create();
            Selection.nudge(next, sel, dx * n, dy * n, dz * n);
            commitTransformed(next, target);
            emit(`shifted by ${n}`);
        },
    );

    // ── introspection ──────────────────────────────────────────────

    install(
        { name: '/size', description: 'report the selection bounds + voxel/node counts', args: [] },
        () => {
            const sel = store.getState().selection;
            const b = Selection.bounds(sel);
            const v = Selection.countVoxels(sel);
            const n = sel.nodes.size;
            if (!b && n === 0) {
                emit('selection is empty');
                return;
            }
            const lines: string[] = [];
            if (b) {
                const [minX, minY, minZ] = b.min;
                const [maxX, maxY, maxZ] = b.max;
                const [dx, dy, dz] = b.dimensions;
                lines.push(`bounds: (${minX}, ${minY}, ${minZ}) → (${maxX}, ${maxY}, ${maxZ})`);
                lines.push(`size: ${dx} × ${dy} × ${dz} (${v} voxels)`);
            }
            if (n > 0) lines.push(`nodes: ${n}`);
            ClientChat.appendLine(chat, { kind: 'system', text: lines.join('\n') });
        },
    );

    install(
        {
            name: '/count',
            description: 'count voxels in the selection that match the given mask',
            args: [{ name: 'mask', type: MaskArg as ArgType<unknown> }],
        },
        ({ args }) => {
            const mask = args.mask as Mask | undefined;
            if (!mask) return;
            const sel = store.getState().selection;
            let matched = 0;
            Selection.forEach(sel, (wx, wy, wz) => {
                if (testMask(mask, ctx.voxels, wx, wy, wz)) matched++;
            });
            emit(`${matched} voxel${matched === 1 ? '' : 's'} match`);
        },
    );

    install(
        { name: '/distr', description: 'list block frequencies in the current selection', args: [] },
        () => {
            const counts = new Map<string, number>();
            const sel = store.getState().selection;
            Selection.forEach(sel, (wx, wy, wz) => {
                const key = getBlockKey(ctx.voxels, wx, wy, wz);
                if (key === BLOCK_AIR) return;
                const parsed = parseKey(key);
                if (!parsed) return;
                counts.set(parsed.blockId, (counts.get(parsed.blockId) ?? 0) + 1);
            });
            const total = [...counts.values()].reduce((a, b) => a + b, 0);
            if (total === 0) {
                emit('selection has no non-air voxels');
                return;
            }
            const lines = [...counts.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([id, n]) => `${id}: ${n} (${((n / total) * 100).toFixed(1)}%)`);
            ClientChat.appendLine(chat, { kind: 'system', text: lines.join('\n') });
        },
    );
}

