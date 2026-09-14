import { useEffect, useState } from 'react';
import * as Icons from '../../../icons';
import type { Node } from '../../core/scene/scene-tree';
import type { TraitBase } from '../../core/scene/traits';
import { useEditRoom } from '../edit-room-store';

const LIVE_HZ = 10;
const MAX_DEPTH = 12;
const INLINE_TYPED_ARRAY = 8;
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
        case 'array':
            return `Array(${(value as unknown[]).length})`;
        case 'map':
            return `Map(${(value as Map<unknown, unknown>).size})`;
        case 'set':
            return `Set(${(value as Set<unknown>).size})`;
        case 'object': {
            const keys = Object.keys(value as object);
            return keys.length === 0 ? '{}' : `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', ...' : ''} }`;
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
    const value = get();
    const kind = kindOf(value);
    const expandable =
        depth < MAX_DEPTH &&
        (kind === 'array' ||
            kind === 'object' ||
            kind === 'map' ||
            kind === 'set' ||
            (kind === 'typed' && (value as { length: number }).length > INLINE_TYPED_ARRAY));
    const ref = kind === 'node' ? (value as Node) : kind === 'trait' ? (value as TraitBase)._node : null;
    return (
        <div>
            <div className="flex items-center gap-1 text-[10px] font-mono leading-4" style={{ paddingLeft: depth * 10 }}>
                {expandable ? (
                    <button type="button" className="w-3 text-fg-muted" onClick={() => setOpen(!open)}>
                        {open ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                    </button>
                ) : (
                    <span className="w-3" />
                )}
                <span className="text-fg-muted shrink-0">{label}:</span>
                {kind === 'primitive' ? (
                    <PrimitiveValue value={value} set={set} />
                ) : ref ? (
                    <button type="button" className="text-accent hover:underline truncate" onClick={() => selectNode(ref.id)}>
                        {summarize(value, kind)}
                    </button>
                ) : (
                    <span className="text-fg truncate">{summarize(value, kind)}</span>
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
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 1000 / LIVE_HZ);
        return () => clearInterval(id);
    }, []);
    return (
        <div className="px-1 py-1 border-t border-border">
            <Children value={root} kind={kindOf(root)} depth={0} />
        </div>
    );
}
