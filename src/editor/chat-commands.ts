/**
 * editor builtin slash commands. registered per-room on `activate()` in the
 * EditorTrait script and torn down on deactivate via `unsubs`. Each command
 * closes over the per-room `EditRoomStoreApi` so /set, undo, redo land on
 * the *room's* selection / history rather than chasing the active room.
 *
 * `/help` lists every command registered against the room's chat, including
 * any registered by game scripts via `chat.command(ctx, ...)`.
 */

import type { ChatClient } from '../client/chat';
import * as ClientChat from '../client/chat';
import type { ArgType, CommandHandler, CommandSpec, Suggestion } from '../core/chat-commands';
import * as ChatCommands from '../core/chat-commands';
import { enumType } from '../core/chat-commands';
import { registry } from '../core/registry';
import type { ScriptContext } from '../core/scene/scripts';
import { send } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { fuzzyRank } from '../core/utils/fuzzy';
import { parseKey } from '../core/voxels/block-registry';
import { BLOCK_AIR, getBlock } from '../core/voxels/voxels';
import { elevateSelection, smoothSelection, walls } from './actions';
import * as Blueprint from './blueprint';
import { SaveBlueprintCommand } from './commands';
import type { EditRoomStoreApi, ElevationMode } from './edit-room-store';
import { type Mask, parseMask } from './scene/mask';
import { type Pattern, parsePattern, splitTopLevel } from './scene/pattern';
import type { BrushShape } from './scene/shapes';

// chat tokenize splits on spaces, so a /set arg is a single space-free
// token. that's fine for patterns (`,` and `N%` are space-free) and for
// most masks (`,`, `!`, `#`, `%`). top-level space intersection like
// `!air stone` is unreachable until the tokenizer learns quoting — at
// which point this arg type still works on the un-quoted contents.

// strip a `N%` weight prefix from a pattern segment, returning the rest.
const WEIGHT_RE = /^[0-9]+(?:\.[0-9]*)?%(.+)$/;
function stripWeight(s: string): string {
    const m = WEIGHT_RE.exec(s);
    return m ? m[1]! : s;
}

// best-effort canonical serialisation so commands that *set* the brush
// pattern/mask also fill in the matching `patternText` / `maskText` for
// the brush-options UI. round-trips through parse* with the canonical
// form (whitespace and prop ordering may differ from the user's input).
function blockSpecToString(blockId: string, props?: Record<string, string>): string {
    if (!props || Object.keys(props).length === 0) return blockId;
    return `${blockId}[${Object.entries(props)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}]`;
}

function patternToString(p: Pattern): string {
    switch (p.kind) {
        case 'block':
            return blockSpecToString(p.block.blockId, p.block.props);
        case 'active':
            return '$active';
        case 'random':
            return p.choices.map((c) => (c.weight === 1 ? '' : `${c.weight}%`) + patternToString(c.pattern)).join(',');
    }
}

function maskToString(m: Mask): string {
    switch (m.kind) {
        case 'blocks':
            return m.blocks.map((b) => blockSpecToString(b.blockId, b.props)).join(',');
        case 'not':
            return `!${maskToString(m.mask)}`;
        case 'and':
            return m.masks.map(maskToString).join(' ');
        case 'existing':
            return '#existing';
        case 'noise':
            return `%${m.percent}`;
    }
}

// candidate block id + the hint shown next to it. registry defs become
// candidates, plus `air` — a valid clear/erase token for `/set` + `/replace`
// that isn't a placeable block, so it carries its own hint instead of a name.
type BlockCandidate = { id: string; detail?: string };

const airCandidate: BlockCandidate = { id: 'air', detail: 'clear / empty' };

function blockCandidates(): BlockCandidate[] {
    return [
        airCandidate,
        ...registry.blockRegistry.defs
            .filter((d) => d.id !== 'air')
            .map((d) => ({ id: d.id, detail: d.name !== d.id ? d.name : undefined })),
    ];
}

// fuzzy-match blocks against `partial`, packaged so the chat UI can swap
// them in for the full current token. ranked by fuzzy score so e.g. `oklg`
// finds `oak_log` ahead of `oak_planks`.
function blockSuggestions(prefix: string, partial: string): Suggestion[] {
    return fuzzyRank(partial, blockCandidates(), (c) => c.id).map(({ item: c }) => ({
        text: prefix + c.id,
        label: c.id,
        detail: c.detail,
    }));
}

export function installEditorChatCommands(
    chat: ChatClient,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    unsubs: Array<() => void>,
): void {
    // walk the current selection and return unique non-air block ids,
    // ordered by frequency (most-common first). drives `(in selection)`
    // mask suggestions for /replace + /set.
    function selectionBlockIds(): string[] {
        const counts = new Map<string, number>();
        Selection.forEach(store.getState().selection, (wx, wy, wz) => {
            const key = getBlock(ctx.voxels, wx, wy, wz);
            if (key === BLOCK_AIR) return;
            const parsed = parseKey(key);
            if (!parsed) return;
            counts.set(parsed.blockId, (counts.get(parsed.blockId) ?? 0) + 1);
        });
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
    }

    // pattern token: comma-split (bracket-aware) random list; each segment
    // may have a leading `N%`. suggestion targets the trailing segment.
    // for patterns, in-selection block ids surface first too — handy for
    // /set when you want to refill using what's already there.
    const PatternArg: ArgType<Pattern> = {
        name: 'pattern',
        parse: (s) => {
            try {
                return { ok: true, value: parsePattern(s) };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
        suggest: (partial) => {
            const segments = splitTopLevel(partial, ',');
            const last = segments[segments.length - 1] ?? '';
            const before = partial.slice(0, partial.length - last.length);
            const lastStripped = stripWeight(last);
            const weightPrefix = last.slice(0, last.length - lastStripped.length);
            return withSelectionFirst(before + weightPrefix, lastStripped);
        },
        describe: () => 'a block pattern (e.g. stone, oak_log, 30%stone,70%dirt)',
    };

    // mask token: same comma-OR-list shape as a single pattern segment,
    // plus optional `!` negation, `#existing`, or `%N` noise.
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
            // `#existing` / `%N` are not block suggestions — nothing useful to
            // complete inside them.
            if (partial.startsWith('#') || partial.startsWith('%')) return [];
            // unwrap leading `!` (possibly stacked) and remember it for re-prefix
            let prefix = '';
            let rest = partial;
            while (rest.startsWith('!')) {
                prefix += '!';
                rest = rest.slice(1);
            }
            const segments = splitTopLevel(rest, ',');
            const last = segments[segments.length - 1] ?? '';
            const before = rest.slice(0, rest.length - last.length);
            return withSelectionFirst(prefix + before, last);
        },
        describe: () => 'a mask (e.g. stone, !air, stone,dirt, #existing, %50)',
    };

    // prepend in-selection blocks (fuzzy-ranked) as `(in selection)`
    // suggestions, then fall back to the registry — deduped so a block
    // doesn't appear twice.
    function withSelectionFirst(prefix: string, partial: string): Suggestion[] {
        const inSel = fuzzyRank(partial, selectionBlockIds(), (id) => id).map((r) => r.item);
        const seen = new Set(inSel);
        const selSuggestions: Suggestion[] = inSel.map((id) => {
            const def = registry.blockRegistry.defs.find((d) => d.id === id);
            return {
                text: prefix + id,
                label: id,
                detail: def && def.name !== def.id ? `${def.name} · in selection` : 'in selection',
            };
        });
        const rest = blockSuggestions(prefix, partial).filter((s) => !seen.has(s.label ?? ''));
        return [...selSuggestions, ...rest];
    }

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

    function blocksWord(n: number): string {
        return n === 1 ? 'block' : 'blocks';
    }

    install(
        {
            name: '/set',
            description: 'fill the current selection with a pattern, optionally filtered by a mask',
            args: [
                { name: 'pattern', type: PatternArg as ArgType<unknown> },
                { name: 'mask', type: MaskArg as ArgType<unknown>, optional: true },
            ],
        },
        ({ args }) => {
            const pattern = args.pattern as Pattern | undefined;
            const mask = args.mask as Mask | undefined;
            if (!pattern) return;
            const n = store.getState().fill(pattern, mask);
            emit(n === 0 ? 'nothing to set' : `set ${n} ${blocksWord(n)}`);
        },
    );

    install(
        {
            name: '/overlay',
            description: 'set a block on top of blocks in the current selection',
            args: [{ name: 'pattern', type: PatternArg as ArgType<unknown> }],
        },
        ({ args }) => {
            const pattern = args.pattern as Pattern | undefined;
            if (!pattern) return;
            const n = store.getState().overlay(pattern);
            emit(n === 0 ? 'nothing to overlay' : `overlaid ${n} ${blocksWord(n)}`);
        },
    );

    install(
        {
            name: '/walls',
            description: "paint the pattern onto the selection's vertical sides (no floor or ceiling)",
            args: [{ name: 'pattern', type: PatternArg as ArgType<unknown> }],
        },
        ({ args }) => {
            const pattern = args.pattern as Pattern | undefined;
            if (!pattern) return;
            const n = walls(store.getState(), ctx, pattern);
            emit(n === 0 ? 'nothing to wall' : `walled ${n} ${blocksWord(n)}`);
        },
    );

    install(
        {
            name: '/replace',
            description:
                'replace existing voxels in the current selection with a pattern (mask = which existing blocks; default #existing)',
            args: [
                { name: 'pattern', type: PatternArg as ArgType<unknown> },
                { name: 'from', type: MaskArg as ArgType<unknown>, optional: true },
            ],
        },
        ({ args }) => {
            const pattern = args.pattern as Pattern | undefined;
            const from = args.from as Mask | undefined;
            if (!pattern) return;
            const n = store.getState().replace(pattern, from);
            emit(n === 0 ? 'nothing to replace' : `replaced ${n} ${blocksWord(n)}`);
        },
    );

    const AxisArg = enumType(['x', 'y', 'z']);

    function degreesToTurns(deg: number | undefined): number | null {
        if (deg == null) return 0;
        if (!Number.isFinite(deg) || deg % 90 !== 0) return null;
        return (deg / 90) | 0;
    }

    install(
        {
            name: '/rotate',
            description: 'rotate the clipboard (degrees, multiples of 90; positive = CW)',
            args: [
                { name: 'yaw', type: 'number' },
                { name: 'pitch', type: 'number', optional: true },
                { name: 'roll', type: 'number', optional: true },
            ],
        },
        ({ args }) => {
            const yaw = degreesToTurns(args.yaw as number | undefined);
            const pitch = degreesToTurns(args.pitch as number | undefined);
            const roll = degreesToTurns(args.roll as number | undefined);
            if (yaw === null || pitch === null || roll === null) {
                emit('angles must be multiples of 90');
                return;
            }
            const ok = store.getState().rotate(yaw ?? 0, pitch ?? 0, roll ?? 0);
            if (!ok) {
                emit('nothing to rotate');
                return;
            }
            const bp = store.getState().activeBlueprint;
            emit(bp ? `rotated clipboard (${bp.label})` : 'rotated clipboard');
        },
    );

    install(
        {
            name: '/flip',
            description: 'mirror the clipboard across an axis plane (x|y|z, default x)',
            args: [{ name: 'axis', type: AxisArg as ArgType<unknown>, optional: true }],
        },
        ({ args }) => {
            const axis = (args.axis as 'x' | 'y' | 'z' | undefined) ?? 'x';
            const ok = store.getState().flip(axis);
            if (!ok) {
                emit('nothing to flip');
                return;
            }
            const bp = store.getState().activeBlueprint;
            emit(bp ? `flipped clipboard on ${axis} (${bp.label})` : `flipped clipboard on ${axis}`);
        },
    );

    install(
        {
            name: '/cut',
            description: 'lift the current selection into the clipboard and enter placement',
            args: [],
        },
        () => {
            const s = store.getState();
            if (Selection.isEmpty(s.selection)) {
                emit('nothing selected');
                return;
            }
            s.cutMove();
        },
    );

    const BrushShapeArg = enumType<BrushShape>(['sphere', 'cube', 'cylinder', 'disc']);

    install(
        {
            name: '/brush',
            description: 'configure & activate the brush tool (shape [pattern] [size] [height])',
            args: [
                { name: 'shape', type: BrushShapeArg as ArgType<unknown> },
                { name: 'pattern', type: PatternArg as ArgType<unknown>, optional: true },
                { name: 'size', type: 'number', optional: true },
                { name: 'height', type: 'number', optional: true },
            ],
        },
        ({ args }) => {
            const shape = args.shape as BrushShape | undefined;
            if (!shape) return;
            const pattern = args.pattern as Pattern | undefined;
            const size = args.size as number | undefined;
            const height = args.height as number | undefined;

            const update: Record<string, unknown> = { shape };
            if (pattern) {
                update.pattern = pattern;
                update.patternText = patternToString(pattern);
                update.patternError = null;
            }
            if (size !== undefined) update.size = Math.max(0, Math.floor(size));
            if (height !== undefined) update.height = Math.max(1, Math.floor(height));
            store.getState().setBrushOptions(update);
            store.getState().setActiveTool('brush');
            const sz = (update.size as number | undefined) ?? store.getState().brushOptions.size;
            emit(`brush: ${shape} · size ${sz}`);
        },
    );

    install(
        {
            name: '/mask',
            description: "set the brush mask (omit to clear, e.g. '#existing', '!air', 'stone,dirt')",
            args: [{ name: 'mask', type: MaskArg as ArgType<unknown>, optional: true }],
        },
        ({ args }) => {
            const mask = args.mask as Mask | undefined;
            if (mask) {
                store.getState().setBrushOptions({ mask, maskText: maskToString(mask), maskError: null });
                emit('brush mask set');
            } else {
                store.getState().setBrushOptions({ mask: null, maskText: '', maskError: null });
                emit('brush mask cleared');
            }
        },
    );

    const ElevationModeArg = enumType<ElevationMode>(['raise', 'lower', 'flatten']);

    install(
        {
            name: '/elevation',
            description: 'raise/lower/flatten each column in the selection (mode [amount] [targetY])',
            args: [
                { name: 'mode', type: ElevationModeArg as ArgType<unknown> },
                { name: 'amount', type: 'number', optional: true },
                { name: 'targetY', type: 'number', optional: true },
            ],
        },
        ({ args }) => {
            const mode = args.mode as ElevationMode | undefined;
            if (!mode) return;
            const amount = Math.max(1, Math.floor((args.amount as number | undefined) ?? 1));
            const targetY = args.targetY as number | undefined;
            const n = elevateSelection(store.getState(), ctx, mode, amount, targetY);
            const verb = mode === 'raise' ? 'raised' : mode === 'lower' ? 'lowered' : 'flattened';
            emit(n === 0 ? 'nothing to elevate' : `${verb} ${n} ${blocksWord(n)}`);
        },
    );

    install(
        {
            name: '/smooth',
            description: 'smooth the current selection as a heightmap ([iterations] [mask])',
            args: [
                { name: 'iterations', type: 'number', optional: true },
                { name: 'mask', type: MaskArg as ArgType<unknown>, optional: true },
            ],
        },
        ({ args }) => {
            const iterations = Math.max(1, Math.floor((args.iterations as number | undefined) ?? 1));
            const mask = args.mask as Mask | undefined;
            const n = smoothSelection(store.getState(), ctx, iterations, mask);
            emit(
                n === 0
                    ? 'nothing to smooth'
                    : `smoothed ${n} ${blocksWord(n)} (${iterations} pass${iterations === 1 ? '' : 'es'})`,
            );
        },
    );

    install(
        {
            name: '/brushsize',
            description: 'set the brush size (voxel radius from the centre cell)',
            args: [{ name: 'size', type: 'number' }],
        },
        ({ args }) => {
            const size = args.size as number | undefined;
            if (size === undefined) return;
            store.getState().setBrushOptions({ size: Math.max(0, Math.floor(size)) });
            emit(`brush size ${Math.max(0, Math.floor(size))}`);
        },
    );

    install(
        {
            name: '/blueprint save',
            description: 'save the current selection as a blueprint scene',
            args: [{ name: 'name', type: 'string', optional: true }],
        },
        ({ args }) => {
            const name = (args.name as string | undefined)?.trim();
            const selection = store.getState().selection;
            const payload = Blueprint.selectionToScenePayload(ctx.voxels, ctx.nodes, selection);
            if (!payload) {
                emit('nothing selected');
                return;
            }
            send(ctx, SaveBlueprintCommand, { name, payload: JSON.stringify(payload) });
        },
    );

    install({ name: 'undo', description: 'undo the last action', args: [] }, () => store.getState().undo());

    install({ name: 'redo', description: 'redo the last undone action', args: [] }, () => store.getState().redo());
}
