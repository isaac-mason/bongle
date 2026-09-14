import { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as Icons from '../../../icons';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../client/ui/components';
import type { Node } from '../../core/scene/scene-tree';
import type { TraitBase } from '../../core/scene/traits';
import { useEditRoom } from '../edit-room-store';

const LIVE_HZ = 10;
const MAX_DEPTH = 12;
const INLINE_TYPED_ARRAY = 8;
const INLINE_LIST = 8;
const INLINE_KEYS = 4;
const MAX_LIST_ROWS = 100;

type Kind = 'primitive' | 'node' | 'trait' | 'function' | 'typed' | 'array' | 'map' | 'set' | 'object';

function isNode(value: object): value is Node {
    return 'traits' in value && 'children' in value && 'id' in value && 'parent' in value;
}

function isTrait(value: object): value is TraitBase {
    return '_node' in value && '_def' in value;
}

function kindOf(value: unknown): Kind {
    if (value === null || typeof value !== 'object') return typeof value === 'function' ? 'function' : 'primitive';
    if (ArrayBuffer.isView(value)) return 'typed';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Map) return 'map';
    if (value instanceof Set) return 'set';
    if (isNode(value)) return 'node';
    if (isTrait(value)) return 'trait';
    return 'object';
}

function formatPrimitive(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
    return String(value);
}

// the one-line summary of a value; expandable kinds get a count, refs get an identity.
function summarize(value: unknown, kind: Kind): string {
    switch (kind) {
        case 'primitive':
            return formatPrimitive(value);
        case 'function':
            return `f ${(value as { name?: string }).name || ''}()`;
        case 'node': {
            const node = value as Node;
            return `Node#${node.id} ${JSON.stringify(node.name ?? '')}`;
        }
        case 'trait': {
            const trait = value as TraitBase;
            return `${trait._def.id}@Node#${trait._node.id}`;
        }
        case 'typed': {
            const view = value as ArrayLike<number> & { constructor: { name: string } };
            const head = Array.from({ length: Math.min(view.length, INLINE_TYPED_ARRAY) }, (_, i) => formatPrimitive(view[i]));
            return `${view.constructor.name}(${view.length}) [${head.join(', ')}${view.length > INLINE_TYPED_ARRAY ? ', ...' : ''}]`;
        }
        case 'array': {
            const list = value as unknown[];
            if (list.length <= INLINE_LIST && list.every((item) => kindOf(item) === 'primitive')) {
                return `[${list.map(formatPrimitive).join(', ')}]`;
            }
            return `Array(${list.length})`;
        }
        case 'map':
            return `Map(${(value as Map<unknown, unknown>).size})`;
        case 'set':
            return `Set(${(value as Set<unknown>).size})`;
        case 'object': {
            const record = value as Record<string, unknown>;
            const keys = Object.keys(record);
            if (keys.length === 0) return '{}';
            if (keys.length <= INLINE_KEYS && keys.every((key) => kindOf(record[key]) === 'primitive')) {
                return `{ ${keys.map((key) => `${key}: ${formatPrimitive(record[key])}`).join(', ')} }`;
            }
            return `{ ${keys.slice(0, INLINE_KEYS).join(', ')}${keys.length > INLINE_KEYS ? ', ...' : ''} }`;
        }
    }
}

type Entry = { key: string; get: () => unknown; set: ((v: unknown) => void) | null };

// `state` first (scripts read it), `_`-prefixed fields last under one fold; refs and functions never expand.
function entriesOf(value: unknown, kind: Kind): { entries: Entry[]; internals: Entry[] } {
    const entries: Entry[] = [];
    const internals: Entry[] = [];
    if (kind === 'typed' || kind === 'array') {
        const list = value as Record<number, unknown> & { length: number };
        const count = Math.min(list.length, MAX_LIST_ROWS);
        for (let i = 0; i < count; i++) {
            entries.push({
                key: String(i),
                get: () => list[i],
                set: (v) => {
                    list[i] = v;
                },
            });
        }
        return { entries, internals };
    }
    if (kind === 'map') {
        let i = 0;
        for (const [k, v] of value as Map<unknown, unknown>) {
            if (i++ >= MAX_LIST_ROWS) break;
            entries.push({ key: typeof k === 'string' ? k : summarize(k, kindOf(k)), get: () => v, set: null });
        }
        return { entries, internals };
    }
    if (kind === 'set') {
        let i = 0;
        for (const v of value as Set<unknown>) {
            if (i++ >= MAX_LIST_ROWS) break;
            entries.push({ key: String(i - 1), get: () => v, set: null });
        }
        return { entries, internals };
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a === 'state' ? -1 : b === 'state' ? 1 : 0));
    for (const key of keys) {
        const entry: Entry = {
            key,
            get: () => record[key],
            set: (v) => {
                record[key] = v;
            },
        };
        if (key.startsWith('_')) internals.push(entry);
        else entries.push(entry);
    }
    return { entries, internals };
}

// what a right-click copies: the row's key and a JSON rendering of its live value.
type CopyTarget = { label: string; get: () => unknown };
const CopyTargetContext = createContext<(target: CopyTarget) => void>(() => {});

function serialize(value: unknown): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(
        value,
        (_key, v) => {
            const kind = kindOf(v);
            if (kind === 'primitive') return v;
            if (kind === 'function') return undefined;
            if (kind === 'node' || kind === 'trait') return summarize(v, kind);
            if (seen.has(v as object)) return '[circular]';
            seen.add(v as object);
            if (kind === 'typed') return Array.from(v as ArrayLike<number>);
            if (kind === 'map') return Object.fromEntries(v as Map<string, unknown>);
            if (kind === 'set') return Array.from(v as Set<unknown>);
            return v;
        },
        2,
    );
}

function PrimitiveValue({ value, set }: { value: unknown; set: ((v: unknown) => void) | null }) {
    const [draft, setDraft] = useState<string | null>(null);
    const editable = set !== null && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean');
    if (typeof value === 'boolean' && editable) {
        return (
            <button type="button" className="text-accent hover:underline" onClick={() => set!(!value)}>
                {String(value)}
            </button>
        );
    }
    if (draft !== null) {
        const commit = () => {
            if (typeof value === 'number') {
                const parsed = Number(draft);
                if (!Number.isNaN(parsed)) set!(parsed);
            } else {
                set!(draft);
            }
            setDraft(null);
        };
        return (
            <input
                type="text"
                value={draft}
                // biome-ignore lint/a11y/noAutofocus: the field opens from the click on the value it replaces
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') setDraft(null);
                    e.stopPropagation();
                }}
                className="bg-surface border border-accent px-1 text-[10px] font-mono text-fg outline-none w-32"
            />
        );
    }
    const text = formatPrimitive(value);
    const color = typeof value === 'string' ? 'text-warn' : typeof value === 'number' ? 'text-accent' : 'text-fg-muted';
    if (!editable) return <span className={color}>{text}</span>;
    return (
        <button
            type="button"
            title="live edit: writes straight onto the instance, no history"
            className={`${color} hover:underline cursor-text`}
            onClick={() => setDraft(typeof value === 'string' ? value : text)}
        >
            {text}
        </button>
    );
}

const RAD_TO_DEG = 180 / Math.PI;

function isVector(value: unknown, kind: Kind): value is ArrayLike<number> {
    if (kind !== 'array' && kind !== 'typed') return false;
    const list = value as ArrayLike<unknown>;
    if (list.length < 2 || list.length > 4) return false;
    for (let i = 0; i < list.length; i++) if (typeof list[i] !== 'number') return false;
    return true;
}

// 2 to 4 numbers edit as one field holding the whole vector; a quaternion-named row also reads as euler degrees.
function VectorValue({ label, value }: { label: string; value: ArrayLike<number> & Record<number, number> }) {
    const [draft, setDraft] = useState<string | null>(null);
    const text = Array.from({ length: value.length }, (_, i) => formatPrimitive(value[i])).join(', ');
    let euler: string | null = null;
    if (value.length === 4 && /quat|rotation/i.test(label)) {
        const [x, y, z, w] = [value[0]!, value[1]!, value[2]!, value[3]!];
        const sinr = 2 * (w * x + y * z);
        const cosr = 1 - 2 * (x * x + y * y);
        const sinp = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
        const siny = 2 * (w * z + x * y);
        const cosy = 1 - 2 * (y * y + z * z);
        const deg = (r: number) => (r * RAD_TO_DEG).toFixed(0);
        euler = `${deg(Math.atan2(sinr, cosr))} ${deg(Math.asin(sinp))} ${deg(Math.atan2(siny, cosy))} deg`;
    }
    if (draft !== null) {
        const commit = () => {
            const parts = draft
                .replace(/[[\]]/g, '')
                .split(/[\s,]+/)
                .filter((part) => part !== '');
            const numbers = parts.map(Number);
            if (numbers.length === value.length && numbers.every((n) => !Number.isNaN(n))) {
                for (let i = 0; i < value.length; i++) value[i] = numbers[i]!;
            }
            setDraft(null);
        };
        return (
            <input
                type="text"
                value={draft}
                // biome-ignore lint/a11y/noAutofocus: the field opens from the click on the vector it replaces
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') setDraft(null);
                    e.stopPropagation();
                }}
                className="bg-surface border border-accent px-1 text-[10px] font-mono text-fg outline-none w-48"
            />
        );
    }
    return (
        <span className="flex items-center gap-1 min-w-0">
            <button
                type="button"
                title="live edit: writes straight onto the instance, no history"
                className="text-accent hover:underline cursor-text truncate"
                onClick={() => setDraft(text)}
            >
                [{text}]
            </button>
            {euler && <span className="text-fg-muted italic shrink-0">{euler}</span>}
        </span>
    );
}

function Row({
    label,
    get,
    set,
    depth,
}: {
    label: string;
    get: () => unknown;
    set: ((v: unknown) => void) | null;
    depth: number;
}) {
    const [open, setOpen] = useState(false);
    const selectNode = useEditRoom((s) => s.selectNode);
    const setCopyTarget = useContext(CopyTargetContext);
    const value = get();
    const kind = kindOf(value);
    const vector = isVector(value, kind);
    const expandable =
        !vector &&
        depth < MAX_DEPTH &&
        (kind === 'array' ||
            kind === 'object' ||
            kind === 'map' ||
            kind === 'set' ||
            (kind === 'typed' && (value as { length: number }).length > INLINE_TYPED_ARRAY));
    const ref = kind === 'node' ? (value as Node) : kind === 'trait' ? (value as TraitBase)._node : null;
    return (
        <div>
            <div
                className="flex items-center gap-1 text-[10px] font-mono leading-4"
                style={{ paddingLeft: depth * 10 }}
                onContextMenu={() => setCopyTarget({ label, get })}
            >
                {expandable ? (
                    <button type="button" className="flex items-center gap-1 min-w-0 text-left" onClick={() => setOpen(!open)}>
                        <span className="w-3 text-fg-muted">
                            {open ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                        </span>
                        <span className="text-fg-muted shrink-0">{label}:</span>
                        <span className="text-fg truncate">{summarize(value, kind)}</span>
                    </button>
                ) : (
                    <>
                        <span className="w-3" />
                        <span className="text-fg-muted shrink-0">{label}:</span>
                        {vector ? (
                            <VectorValue label={label} value={value as ArrayLike<number> & Record<number, number>} />
                        ) : kind === 'primitive' ? (
                            <PrimitiveValue value={value} set={set} />
                        ) : ref ? (
                            <button
                                type="button"
                                className="text-accent hover:underline truncate"
                                onClick={() => selectNode(ref.id)}
                            >
                                {summarize(value, kind)}
                            </button>
                        ) : (
                            <span className="text-fg truncate">{summarize(value, kind)}</span>
                        )}
                    </>
                )}
            </div>
            {open && expandable && <Children value={value} kind={kind} depth={depth + 1} />}
        </div>
    );
}

function Children({ value, kind, depth }: { value: unknown; kind: Kind; depth: number }) {
    const [internalsOpen, setInternalsOpen] = useState(false);
    const { entries, internals } = entriesOf(value, kind);
    return (
        <div>
            {entries.map((entry) => (
                <Row key={entry.key} label={entry.key} get={entry.get} set={entry.set} depth={depth} />
            ))}
            {internals.length > 0 && (
                <div>
                    <button
                        type="button"
                        className="flex items-center gap-1 text-[10px] font-mono text-fg-muted italic"
                        style={{ paddingLeft: depth * 10 }}
                        onClick={() => setInternalsOpen(!internalsOpen)}
                    >
                        {internalsOpen ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                        internals ({internals.length})
                    </button>
                    {internalsOpen &&
                        internals.map((entry) => (
                            <Row key={entry.key} label={entry.key} get={entry.get} set={entry.set} depth={depth + 1} />
                        ))}
                </div>
            )}
        </div>
    );
}

/** a live view of an object the way a devtools console shows it; primitives edit in place, refs select their node. */
export function DataTree({ root }: { root: object }) {
    const [, setTick] = useState(0);
    // one menu for the whole tree; the row under the right-click records itself just before it opens.
    const copyTarget = useRef<CopyTarget | null>(null);
    useEffect(() => {
        const id = setInterval(() => {
            if (!document.hidden) setTick((t) => t + 1);
        }, 1000 / LIVE_HZ);
        return () => clearInterval(id);
    }, []);
    const copy = (text: string) => void navigator.clipboard.writeText(text);
    return (
        <CopyTargetContext.Provider
            value={(target) => {
                copyTarget.current = target;
            }}
        >
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div className="px-1 py-1 border-t border-border">
                        <Children value={root} kind={kindOf(root)} depth={0} />
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onSelect={() => copyTarget.current && copy(serialize(copyTarget.current.get()))}>
                        <Icons.ClipboardCopy size={12} /> Copy value
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => copyTarget.current && copy(copyTarget.current.label)}>
                        <Icons.ClipboardCopy size={12} /> Copy key
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        </CopyTargetContext.Provider>
    );
}
