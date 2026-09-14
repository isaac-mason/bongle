import type { ChatClient } from '../client/chat';
import * as ClientChat from '../client/chat';
import type { ArgType, CommandHandler, CommandSpec, Suggestion } from '../core/chat-commands';
import * as ChatCommands from '../core/chat-commands';
import { registry } from '../core/registry';
import type { ScriptContext } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { fuzzyRank } from '../core/utils/fuzzy';
import { parseKey } from '../core/voxels/block-registry';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, getBlock, toChunkCoord } from '../core/voxels/voxels';
import type { EditRoomStoreApi, SelectTarget } from './edit-room-store';
import type { NodeBodies } from './node-bodies';
import { type Mask, parseMask, testMask } from './scene/mask';
import { rebuildNodeSelection } from './scene/node-selection';
import { type BrushShape, buildShape } from './scene/shapes';

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
    vert: [
        [0, 1, 0],
        [0, -1, 0],
    ],
    all: [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
    ],
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

type Vec3 = readonly [number, number, number];

// written `x,y,z` with no spaces since the tokenizer splits on spaces, so a corner is a single token.
const Vec3Arg: ArgType<Vec3> = {
    name: 'coord',
    parse: (s) => {
        // tolerate a trailing comma (`5,0,5,`) and surrounding whitespace; an
        // empty component (`5,,5`) is an error, Number('') is 0, not NaN.
        const parts = s
            .replace(/,+$/, '')
            .split(',')
            .map((p) => p.trim());
        if (parts.length !== 3 || parts.some((p) => p === '')) {
            return { ok: false, error: `expected x,y,z (got: ${s})` };
        }
        const n = parts.map(Number);
        if (n.some((v) => !Number.isFinite(v))) return { ok: false, error: `not a coordinate: ${s}` };
        return { ok: true, value: [Math.floor(n[0]!), Math.floor(n[1]!), Math.floor(n[2]!)] };
    },
    describe: () => 'x,y,z (e.g. 0,4,0)',
};

// cap on the chunk span of an explicit `/select box`, so a missing digit can't
// allocate a runaway number of chunk bitsets. ~65k chunks covers any plausible
// world; a real typo lands orders of magnitude above it.
const MAX_BOX_CHUNK_SPAN = 1 << 16;

type Target = { voxels: boolean; nodes: boolean };

/** resolve target flags against the sticky selectTarget (positive wins on conflict). */
function resolveTarget(flags: Record<string, boolean>, sticky: SelectTarget): Target {
    const voxels = flags.voxels ? true : flags['no-voxels'] ? false : sticky !== 'nodes';
    const nodes = flags.nodes ? true : flags['no-nodes'] ? false : sticky !== 'voxels';
    return { voxels, nodes };
}

// flag specs shared by every selection command, keeps suggestions uniform.
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

/** default (no flag) replaces; always returns a fresh Selection reference (callers rely on identity change for reactivity). */
function compose(
    current: Selection.Selection,
    scratch: Selection.Selection,
    flags: Record<string, boolean>,
): Selection.Selection {
    if (flags.add) {
        const next = Selection.clone(current);
        Selection.merge(next, scratch);
        return next;
    }
    if (flags.sub) {
        const next = Selection.clone(current);
        Selection.subtract(next, scratch);
        return next;
    }
    if (flags.int) {
        const next = Selection.clone(current);
        Selection.intersect(next, scratch);
        return next;
    }
    return scratch;
}

// thin variant of chat-commands.ts's MaskArg, no in-selection ranking since /count's mask
// classifies voxels rather than ranking contextually.
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

/** set-algebra composition via `--add`/`--sub`/`--int` (default replaces); voxel/node targeting
 *  via `--voxels`/`--no-voxels`/`--nodes`/`--no-nodes`, defaulting to the store's sticky
 *  `selectTarget`. nodes are recomputed after every voxel mutation via `rebuildNodeSelection`,
 *  so node selection tracks the voxel set across expand/contract/shift. */
export function installSelectionChatCommands(
    chat: ChatClient,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
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

    // the inspect/transform tools wipe selection.chunks every frame, so a voxel selection
    // committed from a chat command while one is active would vanish instantly; switch to
    // box-select first so it stays and renders.
    function ensureVoxelSelectionToolActive(): void {
        const s = store.getState();
        if (s.activeTool === 'inspect' || s.activeTool === 'transform') {
            s.setActiveTool('box-select');
        }
    }

    function commitShape(scratch: Selection.Selection, flags: Record<string, boolean>, target: Target): void {
        if (target.nodes) {
            rebuildNodeSelection(scratch, ctx, nodeBodies);
        } else {
            scratch.nodes.clear();
        }
        if (!target.voxels) scratch.chunks.clear();
        if (target.voxels) ensureVoxelSelectionToolActive();

        const next = compose(store.getState().selection, scratch, flags);
        store.getState().replaceSelection(next);
    }

    /** floored midpoint of the current selection's bounds, or the hovered voxel; null if neither is available. */
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

    function installShape(label: string, shape: BrushShape, includeHeight: boolean): void {
        const args: CommandSpec['args'] = [{ name: 'size', type: 'number', optional: true }];
        if (includeHeight) args.push({ name: 'height', type: 'number', optional: true });

        install(
            {
                name: `/shape ${label}`,
                description: `make a ${label} centred on the hovered voxel`,
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
                reportShape(`/shape ${label}`, store.getState().selection);
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
            name: '/shape chunk',
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
            reportShape('/shape chunk', store.getState().selection);
        },
    );

    install(
        {
            name: '/select box',
            description: 'select the cuboid between two corners (x,y,z each)',
            args: [
                { name: 'from', type: Vec3Arg as ArgType<unknown> },
                { name: 'to', type: Vec3Arg as ArgType<unknown> },
            ],
            flags: [...SHAPE_FLAGS],
        },
        ({ args, flags }) => {
            const from = args.from as Vec3;
            const to = args.to as Vec3;
            const minX = Math.min(from[0], to[0]);
            const minY = Math.min(from[1], to[1]);
            const minZ = Math.min(from[2], to[2]);
            const maxX = Math.max(from[0], to[0]);
            const maxY = Math.max(from[1], to[1]);
            const maxZ = Math.max(from[2], to[2]);

            const chunkSpan =
                (toChunkCoord(maxX) - toChunkCoord(minX) + 1) *
                (toChunkCoord(maxY) - toChunkCoord(minY) + 1) *
                (toChunkCoord(maxZ) - toChunkCoord(minZ) + 1);
            if (chunkSpan > MAX_BOX_CHUNK_SPAN) {
                emit(`box too large (${chunkSpan} chunks); check the coordinates`);
                return;
            }

            const target = resolveTarget(flags, store.getState().selectTarget);
            const scratch = Selection.create();
            Selection.setAABB(scratch, minX, minY, minZ, maxX, maxY, maxZ);
            commitShape(scratch, flags, target);
            reportShape('/select box', store.getState().selection);
        },
    );

    install({ name: '/desel', description: 'clear the current selection', args: [] }, () => {
        store.getState().clearSelection();
        emit('selection cleared');
    });

    // each axis is swept independently against the accumulated result, so dirs=all produces a
    // (2n+1)^3 cuboid envelope (WE semantics), not the octahedron of a 6-neighbour Minkowski dilation.
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

    // inverse of grow: a voxel v survives iff v+d, v+2d, ... v+nd are all in current, so
    // dirs=all strips n layers off each face.
    function shrink(sel: Selection.Selection, n: number, dirs: readonly DirectionVec[]): Selection.Selection {
        let current = sel;
        const scratch = Selection.create();
        for (const [dx, dy, dz] of dirs) {
            const eroded = Selection.clone(current);
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
        // about to be reverted, that lets `--nodes --no-voxels` track what
        // the transform would have selected without disturbing voxels.
        if (target.nodes) {
            rebuildNodeSelection(next, ctx, nodeBodies);
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
        store.getState().replaceSelection(next);
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
            const dirs = (args.direction as readonly DirectionVec[] | undefined) ?? DIR_TOKENS.all!;
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
            const dirs = (args.direction as readonly DirectionVec[] | undefined) ?? DIR_TOKENS.all!;
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
            const next = grow(sel, n, DIR_TOKENS.all!);
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
            const next = shrink(sel, n, DIR_TOKENS.all!);
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
            const dirs = (args.direction as readonly DirectionVec[] | undefined) ?? DIR_TOKENS.up!;
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

    install({ name: '/size', description: 'report the selection bounds + voxel/node counts', args: [] }, () => {
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
    });

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

    install({ name: '/distr', description: 'list block frequencies in the current selection', args: [] }, () => {
        const counts = new Map<string, number>();
        const sel = store.getState().selection;
        Selection.forEach(sel, (wx, wy, wz) => {
            const key = getBlock(ctx.voxels, wx, wy, wz);
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
    });
}
