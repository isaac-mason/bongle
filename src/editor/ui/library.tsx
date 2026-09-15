import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from '../../../icons';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '../../client/ui/components';
import { useClient } from '../../client/ui/stores/client-store';
import { useReleasePointer } from '../../client/ui/use-release-pointer';
import { assetMatches } from '../../core/asset-meta';
import { depId, registry } from '../../core/registry';
import {
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_LIQUID,
    parseKey,
    resolveKey,
} from '../../core/voxels/block-registry';
import { MaterialType } from '../../core/voxels/blocks';
import { useEditRoom } from '../edit-room-store';
import { HOTBAR_NUMBER_KEYS } from '../editor-controls';
import { useEditor } from '../editor-store';
import { buildCatalog, type InventoryItem, inventoryItemDisplay, inventoryItemKey, inventoryItemsEqual } from '../inventory';
import { switchRoom } from '../session';
import { useEngineClient } from './engine-client-context';
import { InventoryItemIcon } from './inventory-icon';
import { Kbd } from './kbd';

type Tab = 'inventory' | 'scenes';
type Filter = 'all' | 'bongle' | 'prefabs' | 'blueprints';

const ITEM_SIZE = 56;
const ICON_SIZE = 40;

export function LibraryOverlay() {
    const open = useEditRoom((s) => s.libraryOpen);
    const close = useEditRoom((s) => s.setLibraryOpen);
    const [tab, setTab] = useState<Tab>('inventory');

    // otherwise fly/character controllers re-grab pointer lock on canvas click while this is open.
    useReleasePointer('editor:library', open);

    // drops carry implicitly via setLibraryOpen.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                close(false);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, close]);

    if (!open) return null;

    return (
        // no full-screen backdrop, so canvas + hotbar remain interactive while this is open.
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
            <div className="bg-surface shadow-xl border border-border w-[640px] max-w-[90vw] max-h-[70vh] flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                    <span className="text-sm font-mono text-fg flex-1">library</span>
                    <button
                        type="button"
                        onClick={() => close(false)}
                        className="p-1 hover:bg-surface-muted text-fg-muted cursor-pointer"
                        title="close (esc)"
                    >
                        <Icons.X size={12} />
                    </button>
                </div>

                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle">
                    <TopTab label="inventory" active={tab === 'inventory'} onClick={() => setTab('inventory')} />
                    <TopTab label="scenes" active={tab === 'scenes'} onClick={() => setTab('scenes')} />
                </div>

                {tab === 'inventory' ? <InventoryTab /> : <ScenesTab />}
            </div>
        </div>
    );
}

function TopTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`text-[12px] font-mono px-3 py-1 cursor-pointer ${
                active ? 'bg-accent text-on-accent' : 'bg-surface text-fg hover:bg-surface-muted'
            }`}
        >
            {label}
        </button>
    );
}

function InventoryTab() {
    const room = useEditor((s) => s.room);
    const sceneList = useEditor((s) => s.sceneList);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [tags, setTags] = useState<readonly string[]>([]);

    // handled at the DOM layer (not the per-frame shortcut loop) so 1-9 binds a hovered tile to
    // that hotbar slot even while the search box has focus, which the engine's own loop ignores.
    const hovered = useEditRoom((s) => s.hoveredInventoryItem);
    useEffect(() => {
        if (!hovered) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
            const slot = HOTBAR_NUMBER_KEYS.indexOf(e.code as (typeof HOTBAR_NUMBER_KEYS)[number]);
            if (slot === -1) return;
            e.preventDefault();
            e.stopPropagation();
            useEditor.getState().setHotbarSlot(slot, hovered);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [hovered]);

    const catalog = useMemo(() => (room ? buildCatalog(room, sceneList) : []), [room, sceneList]);

    // kind and search only; the tag row is built from what survives here, so a chip always has a hit.
    const byKind = useMemo(() => {
        const q = search.trim();
        return catalog.filter((item) => {
            if (filter === 'bongle' && item.kind !== 'block') return false;
            if (filter === 'prefabs' && item.kind !== 'prefab') return false;
            if (filter === 'blueprints' && item.kind !== 'blueprint') return false;
            if (!q) return true;
            const display = inventoryItemDisplay(item, room);
            return assetMatches({ id: display.id, name: display.name, tags: display.tags }, q);
        });
    }, [catalog, filter, search, room]);

    const filtered = useMemo(() => {
        if (tags.length === 0) return byKind;
        return byKind.filter((item) => {
            const itemTags = inventoryItemDisplay(item, room).tags;
            return tags.every((tag) => itemTags.includes(tag));
        });
    }, [byKind, tags, room]);

    // every tag the kind and search leave on the table, most-used first. deliberately not narrowed by what is
    // already picked: the row stays put as you click through it instead of reshuffling under the cursor.
    const tagChips = useMemo(() => {
        const counts = new Map<string, number>();
        for (const item of byKind) {
            for (const tag of inventoryItemDisplay(item, room).tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
    }, [byKind, room]);

    const toggleTag = useCallback((tag: string) => {
        setTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]));
    }, []);

    // a mouse wheel only ever reports deltaY, so a strip that scrolls sideways has to translate it itself.
    // native and non-passive because React's own wheel listener is passive, where preventDefault is a no-op.
    const tagRowRef = useRef<HTMLDivElement>(null);
    const hasTags = tagChips.length > 0;
    useEffect(() => {
        const row = tagRowRef.current;
        if (!row) return;
        const onWheel = (e: WheelEvent) => {
            if (row.scrollWidth <= row.clientWidth) return;
            const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (delta === 0) return;
            e.preventDefault();
            row.scrollLeft += delta;
        };
        row.addEventListener('wheel', onWheel, { passive: false });
        return () => row.removeEventListener('wheel', onWheel);
    }, [hasTags]);

    return (
        <>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
                <FilterTab label="all" active={filter === 'all'} onClick={() => setFilter('all')} />
                <FilterTab label="blocks" active={filter === 'bongle'} onClick={() => setFilter('bongle')} />
                <FilterTab label="prefabs" active={filter === 'prefabs'} onClick={() => setFilter('prefabs')} />
                <FilterTab label="blueprints" active={filter === 'blueprints'} onClick={() => setFilter('blueprints')} />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    placeholder="search…"
                    className="flex-1 text-[12px] font-mono text-fg bg-surface-muted border border-border px-2 py-1 outline-none focus:border-fg-muted placeholder:text-fg-muted"
                />
            </div>

            {hasTags && (
                // overflow-y-hidden is load-bearing: naming only one axis makes the other compute to auto,
                // which gave the row its own vertical scrollbar. shrink-0 keeps the flex column off its height.
                <div
                    ref={tagRowRef}
                    className="flex shrink-0 items-center gap-1 px-3 py-1.5 border-b border-border-subtle overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
                >
                    {tags.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setTags([])}
                            title="clear tags"
                            className="shrink-0 flex items-center text-[11px] font-mono px-1 py-1 cursor-pointer bg-surface-muted text-fg-muted hover:text-fg"
                        >
                            <Icons.X size={12} />
                        </button>
                    )}
                    {tagChips.map((tag) => (
                        <TagChip key={tag} tag={tag} active={tags.includes(tag)} onClick={() => toggleTag(tag)} />
                    ))}
                </div>
            )}

            <div className="overflow-y-auto p-2 flex-1">
                {filtered.length === 0 ? (
                    <div className="text-[12px] font-mono text-fg-muted px-2 py-4 text-center">no items</div>
                ) : (
                    <div
                        className="grid gap-1.5"
                        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${ITEM_SIZE}px, 1fr))` }}
                    >
                        {filtered.map((item) => (
                            <InventoryGridItem key={inventoryItemKey(item)} item={item} />
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

const InventoryGridItem = memo(function InventoryGridItem({ item }: { item: InventoryItem }) {
    const room = useEditor((s) => s.room);
    const carried = useEditRoom((s) => s.carriedItem);
    const setCarried = useEditRoom((s) => s.setCarriedItem);
    const setHovered = useEditRoom((s) => s.setHoveredInventoryItem);
    const [infoOpen, setInfoOpen] = useState(false);

    const isCarried = carried !== null && inventoryItemsEqual(carried, item);
    const display = inventoryItemDisplay(item, room);

    return (
        // wraps the tile in a plain div anchor so the hover snippet stays independent of the
        // button's click/right-click, which drive carry + the details Popover.
        <HoverCard>
            <HoverCardTrigger asChild>
                <div className="relative">
                    <Popover open={infoOpen} onOpenChange={setInfoOpen}>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                onMouseEnter={() => setHovered(item)}
                                onMouseLeave={() => setHovered(null)}
                                onClick={() => setCarried(isCarried ? null : item)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setInfoOpen((o) => !o);
                                }}
                                className={`flex w-full flex-col items-center justify-center gap-1 p-1 cursor-pointer transition-colors ${
                                    isCarried
                                        ? 'bg-accent/20 ring-2 ring-accent'
                                        : 'bg-surface-muted hover:bg-border hover:ring-1 hover:ring-fg-muted'
                                }`}
                                style={{ minHeight: ITEM_SIZE }}
                            >
                                <InventoryItemIcon item={item} size={ICON_SIZE} />
                                <span className="text-[10px] text-fg truncate max-w-full">{display.name}</span>
                                {display.id !== display.name && (
                                    <span className="text-[8px] font-mono text-fg-muted truncate max-w-full -mt-0.5">
                                        {display.id}
                                    </span>
                                )}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="center" className="w-64 p-3">
                            <InventoryItemInfo item={item} />
                        </PopoverContent>
                    </Popover>
                </div>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" className="w-52 max-w-[70vw] p-2">
                <InventoryHoverBody item={item} display={display} />
            </HoverCardContent>
        </HoverCard>
    );
});

function InventoryHoverBody({ item, display }: { item: InventoryItem; display: { name: string; id: string; title: string } }) {
    // a meaningful sub-line: the block's state suffix, or the prefab's type.
    const detail =
        item.kind === 'block'
            ? item.blockKey.includes('[')
                ? item.blockKey.slice(item.blockKey.indexOf('['))
                : null
            : item.kind === 'prefab'
              ? (registry.prefabs.byId.get(item.prefabId)?.type ?? null)
              : null;

    return (
        <>
            <div className="flex items-center gap-2">
                <InventoryItemIcon item={item} size={28} />
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[12px] text-fg">{display.name}</span>
                    <span className="truncate text-[9px] font-mono uppercase text-fg-muted">
                        {item.kind}
                        {detail ? ` · ${detail}` : ''}
                    </span>
                </div>
            </div>
            {display.id !== display.name && <div className="mt-1 truncate font-mono text-[9px] text-fg-muted">{display.id}</div>}
            <div className="my-1.5 h-px bg-border" />
            <div className="flex flex-col gap-1 text-[10px] text-fg-muted">
                <div className="flex items-center gap-1.5">
                    <Kbd size="sm">click</Kbd>
                    <span>pick up, then click a slot</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="flex items-center gap-0.5">
                        <Kbd size="sm">1</Kbd>
                        <span>-</span>
                        <Kbd size="sm">9</Kbd>
                    </span>
                    <span>bind to a hotbar slot</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <Kbd size="sm">right-click</Kbd>
                    <span>details</span>
                </div>
            </div>
        </>
    );
}

function InventoryItemInfo({ item }: { item: InventoryItem }) {
    const room = useEditor((s) => s.room);
    const display = inventoryItemDisplay(item, room);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <InventoryItemIcon item={item} size={32} />
                <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[12px] text-fg truncate">{display.name}</span>
                    <span className="text-[10px] font-mono text-fg-muted uppercase">{item.kind}</span>
                </div>
            </div>
            <InfoRow label="id" value={display.id} />
            {item.kind === 'prefab' && <PrefabInfoRows prefabId={item.prefabId} />}
            {item.kind === 'block' && <BlockInfoRows blockKey={item.blockKey} />}
        </div>
    );
}

function PrefabInfoRows({ prefabId }: { prefabId: string }) {
    const room = useEditor((s) => s.room);
    if (!room) return null;
    const def = registry.prefabs.byId.get(prefabId);
    if (!def) return null;
    // args lists parameter names, so you can tell a configurable prefab from a fixed one.
    const realm = def.node?.realm;
    const argsDefault = def.args?.default;
    const argKeys = argsDefault && typeof argsDefault === 'object' ? Object.keys(argsDefault) : [];
    return (
        <>
            <AttrRow label="type" value={def.type} />
            {realm && <AttrRow label="realm" value={String(realm)} />}
            {argKeys.length > 0 && <AttrRow label="args" value={argKeys.join(', ')} />}
            {def.deps.length > 0 && <AttrRow label="deps" value={String(def.deps.length)} />}
            {def.tags.length > 0 && <AttrRow label="tags" value={def.tags.join(', ')} />}
        </>
    );
}

function BlockInfoRows({ blockKey }: { blockKey: string }) {
    const blocks = registry.blockRegistry;
    if (!blocks) return null;
    // reads straight from the frozen per-state tables so every attribute reflects this exact variant.
    const parsed = parseKey(blockKey);
    const stateProps = parsed ? Object.entries(parsed.props) : [];
    const sid = resolveKey(blocks, blockKey);
    const flags = blocks.flags[sid] ?? 0;
    const material = blocks.material[sid] ?? MaterialType.OPAQUE;
    const emits = (blocks.lightEmission[sid] ?? 0) !== 0;
    const def = parsed ? blocks.defs.find((d) => d.id === parsed.blockId) : undefined;
    const totalStates = def?.states.totalStates ?? 1;

    const materialLabel =
        material === MaterialType.TRANSLUCENT ? 'translucent' : material === MaterialType.TRANSPARENT ? 'cutout' : 'opaque';

    return (
        <>
            {stateProps.map(([name, value]) => (
                <AttrRow key={name} label={name} value={value} />
            ))}
            <AttrRow label="material" value={materialLabel} />
            <AttrRow label="collision" value={(flags & BLOCK_FLAG_COLLISION) !== 0 ? 'solid' : 'passable'} />
            {emits && <AttrRow label="light" value="emits" />}
            {(flags & BLOCK_FLAG_LIQUID) !== 0 && <AttrRow label="liquid" value="yes" />}
            {(flags & BLOCK_FLAG_CLIMBABLE) !== 0 && <AttrRow label="climb" value="yes" />}
            {totalStates > 1 && <AttrRow label="states" value={String(totalStates)} />}
            {def && def.tags.length > 0 && <AttrRow label="tags" value={def.tags.join(', ')} />}
        </>
    );
}

// non-copyable; the copy affordance is reserved for the id row (InfoRow).
function AttrRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[9px] font-mono text-fg-muted uppercase">{label}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-fg">{value}</span>
        </div>
    );
}

function InfoRow({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch {
            // clipboard blocked, ignore
        }
    };
    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-mono text-fg-muted uppercase w-10 shrink-0">{label}</span>
            <code className="flex-1 min-w-0 text-[11px] font-mono text-fg bg-surface-muted border border-border px-1.5 py-0.5 truncate select-all">
                {value}
            </code>
            <button
                type="button"
                onClick={copy}
                title="copy"
                className="h-6 w-6 inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-surface-muted cursor-pointer"
            >
                {copied ? <Icons.Check size={12} className="text-success" /> : <Icons.Copy size={12} />}
            </button>
        </div>
    );
}

function FilterTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`text-[11px] font-mono px-2 py-1 cursor-pointer ${
                active ? 'bg-accent text-on-accent' : 'bg-surface-muted text-fg hover:bg-border'
            }`}
        >
            {label}
        </button>
    );
}

function TagChip({ tag, active, onClick }: { tag: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`shrink-0 text-[11px] font-mono px-2 py-1 cursor-pointer ${
                active ? 'bg-accent text-on-accent' : 'bg-surface-muted text-fg-muted hover:text-fg'
            }`}
        >
            {tag}
        </button>
    );
}

function nextSceneName(existing: string[]): string {
    const set = new Set(existing);
    for (let i = 1; ; i++) {
        const name = `scene${i}`;
        if (!set.has(name)) return name;
    }
}

function ScenesTab() {
    const sceneList = useEditor((s) => s.sceneList);
    const activeSceneId = useEditor((s) => s.sceneId);
    const room = useEditor((s) => s.room);
    const openScene = useEditRoom((s) => s.openScene);
    const renameScene = useEditRoom((s) => s.renameScene);
    const deleteScene = useEditRoom((s) => s.deleteScene);
    const roomList = useClient((s) => s.roomList);
    const joinedPlayers = useEditor((s) => s.joinedPlayers);
    const engine = useEngineClient();
    const [newScene, setNewScene] = useState('');

    const sortedScenes = [...sceneList].sort((a, b) => a.localeCompare(b));
    const existingNames = new Set(sceneList);

    const prefabSourceScenes = new Set<string>();
    if (room) {
        for (const h of registry.prefabs.byId.values()) {
            for (const dep of h.deps) {
                const id = depId(dep);
                if (registry.scenes.byId.has(id)) prefabSourceScenes.add(id);
            }
        }
    }

    const handleOpen = useCallback(
        (sceneId: string) => {
            const existing = roomList.find(
                (r) =>
                    r.sceneId === sceneId &&
                    r.roomMode === 'edit' &&
                    joinedPlayers.some((p) => p.roomId === r.id && p.mode === 'edit'),
            );
            if (existing) {
                switchRoom(engine, existing.id, 'edit');
            } else {
                openScene(sceneId);
            }
        },
        [roomList, joinedPlayers, engine, openScene],
    );

    const handleCreate = useCallback(() => {
        const trimmed = newScene.trim();
        const name = trimmed || nextSceneName(sceneList);
        openScene?.(name);
        setNewScene('');
    }, [newScene, openScene, sceneList]);

    return (
        <>
            <div className="overflow-y-auto py-1 flex-1">
                {sortedScenes.length === 0 ? (
                    <div className="text-[12px] font-mono text-fg-muted px-2 py-4 text-center">no scenes</div>
                ) : (
                    <div className="flex flex-col gap-px">
                        {sortedScenes.map((sceneId) => (
                            <SceneRow
                                key={sceneId}
                                sceneId={sceneId}
                                isActive={sceneId === activeSceneId}
                                isPrefabSource={prefabSourceScenes.has(sceneId)}
                                existing={existingNames}
                                onOpen={handleOpen}
                                onRename={renameScene}
                                onDelete={deleteScene}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className="px-3 py-2 border-t border-border">
                <div className="flex items-center gap-1">
                    <input
                        type="text"
                        placeholder={nextSceneName(sceneList)}
                        value={newScene}
                        onChange={(e) => setNewScene(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreate();
                        }}
                        className="flex-1 min-w-0 h-7 px-1.5 text-[11px] font-mono text-fg border border-border bg-surface outline-none focus:border-fg-muted"
                    />
                    <button
                        type="button"
                        onClick={handleCreate}
                        className="h-7 w-7 inline-flex items-center justify-center border border-border text-fg-muted hover:bg-surface-muted hover:text-fg cursor-pointer"
                        title="create scene"
                    >
                        <Icons.Plus size={12} />
                    </button>
                </div>
            </div>
        </>
    );
}

function SceneRow({
    sceneId,
    isActive,
    isPrefabSource,
    existing,
    onOpen,
    onRename,
    onDelete,
}: {
    sceneId: string;
    isActive: boolean;
    isPrefabSource: boolean;
    existing: Set<string>;
    onOpen: (sceneId: string) => void;
    onRename: (oldId: string, newId: string) => void;
    onDelete: (sceneId: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(sceneId);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);

    const commit = () => {
        setEditing(false);
        const trimmed = draft.trim();
        if (!trimmed) {
            setDraft(sceneId);
            return;
        }
        if (trimmed !== sceneId && existing.has(trimmed)) {
            setDraft(sceneId);
            return;
        }
        if (trimmed !== sceneId) {
            onRename(sceneId, trimmed);
        } else {
            setDraft(sceneId);
        }
    };

    return (
        <div
            className={`group relative flex items-center gap-1 h-7 px-2 cursor-pointer transition-colors ${
                isActive ? 'bg-accent' : 'bg-surface-muted hover:bg-border'
            }`}
        >
            {/* scenes have no icon, so this is a plain text row */}
            {editing ? (
                <input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        if (e.key === 'Escape') {
                            setDraft(sceneId);
                            setEditing(false);
                        }
                    }}
                    className="flex-1 min-w-0 px-1 py-0.5 text-[11px] font-mono text-fg bg-surface border border-accent outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={() => onOpen(sceneId)}
                    className={`flex-1 min-w-0 text-[11px] font-mono text-left truncate cursor-pointer ${
                        isActive ? 'text-on-accent' : 'text-fg'
                    }`}
                    title={sceneId}
                >
                    {sceneId}
                </button>
            )}

            {!editing && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    {isPrefabSource && (
                        <span
                            className={`inline-flex items-center px-1 py-0.5 text-[9px] font-mono ${
                                isActive ? 'text-cyan-100 bg-cyan-500/30' : 'text-cyan-300 bg-cyan-500/15'
                            }`}
                            title="referenced by prefab()"
                        >
                            <Icons.Tags size={12} />
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setDraft(sceneId);
                            setEditing(true);
                        }}
                        className={`h-5 w-5 inline-flex items-center justify-center cursor-pointer ${
                            isActive
                                ? 'bg-surface/20 text-on-accent hover:text-on-accent'
                                : 'bg-surface border border-border text-fg-muted hover:text-fg'
                        }`}
                        title="rename"
                    >
                        <Icons.Pencil size={12} />
                    </button>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`delete scene "${sceneId}"?`)) onDelete(sceneId);
                        }}
                        className={`h-5 w-5 inline-flex items-center justify-center cursor-pointer ${
                            isActive
                                ? 'bg-surface/20 text-on-accent hover:text-danger'
                                : 'bg-surface border border-border text-fg-muted hover:text-danger'
                        }`}
                        title="delete"
                    >
                        <Icons.Trash2 size={12} />
                    </button>
                </div>
            )}
        </div>
    );
}
