/**
 * library overlay, floating panel for browsing and managing project content.
 *
 * shown when `libraryOpen` is true (toggled with E). top-level tabs:
 *   - inventory: catalog of blocks, prefabs, blueprints. click an item to
 *     pick it up (minecraft-style carry), then click a hotbar slot to bind
 *     it. while an item is hovered, 1-9 binds it directly to that slot.
 *   - scenes:    thumbnail grid of every scene on disk. click to open
 *     (switches to an existing edit room if one's already open). row hover
 *     surfaces rename + delete; a "create new" input is pinned at the
 *     bottom.
 *
 * esc or E again closes.
 */

import * as Icons from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../../client/ui/components';
import { useReleasePointer } from '../../client/ui/use-release-pointer';
import { depId, registry } from '../../core/registry';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { buildCatalog, type InventoryItem, inventoryItemDisplay, inventoryItemKey, inventoryItemsEqual } from '../inventory';
import { InventoryItemIcon } from './inventory-icon';

type Tab = 'inventory' | 'scenes';
type Filter = 'all' | 'bongle' | 'prefabs' | 'blueprints';

const ITEM_SIZE = 56;
const ICON_SIZE = 40;
const SCENE_TILE_SIZE = 96;
const SCENE_THUMB_SIZE = 72;

export function LibraryOverlay() {
    const open = useEditRoom((s) => s.libraryOpen);
    const close = useEditRoom((s) => s.setLibraryOpen);
    const [tab, setTab] = useState<Tab>('inventory');

    // free the cursor while open so the user can interact with the overlay;
    // otherwise fly/character controllers re-grab pointer lock on canvas click.
    // the engine re-locks on the next canvas click after this closes.
    useReleasePointer('editor:library', open);

    // close on Esc (and drop carry implicitly via setLibraryOpen).
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
        // floating panel, positioned, no full-screen backdrop, doesn't block
        // clicks on the rest of the editor (canvas + hotbar remain interactive).
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
            <div className="bg-white shadow-xl border border-neutral-200 w-[640px] max-w-[90vw] max-h-[70vh] flex flex-col">
                {/* header */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200">
                    <span className="text-sm font-mono text-neutral-700 flex-1">library</span>
                    <button
                        type="button"
                        onClick={() => close(false)}
                        className="p-1 hover:bg-neutral-100 text-neutral-500 cursor-pointer"
                        title="close (esc)"
                    >
                        <Icons.X size={14} />
                    </button>
                </div>

                {/* top-level tab strip */}
                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-100">
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
                active ? 'bg-neutral-800 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-100'
            }`}
        >
            {label}
        </button>
    );
}

/* ── inventory tab ───────────────────────────────────────────────── */

function InventoryTab() {
    const room = useEditor((s) => s.room);
    const sceneList = useEditor((s) => s.sceneList);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<Filter>('all');

    const catalog = useMemo(() => (room ? buildCatalog(room, sceneList) : []), [room, sceneList]);
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return catalog.filter((item) => {
            if (filter === 'bongle' && item.kind !== 'block') return false;
            if (filter === 'prefabs' && item.kind !== 'prefab') return false;
            if (filter === 'blueprints' && item.kind !== 'blueprint') return false;
            if (!q) return true;
            const { name, id } = inventoryItemDisplay(item, room);
            return name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
        });
    }, [catalog, filter, search, room]);

    return (
        <>
            {/* filter + search */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-100">
                <FilterTab label="all" active={filter === 'all'} onClick={() => setFilter('all')} />
                <FilterTab label="blocks" active={filter === 'bongle'} onClick={() => setFilter('bongle')} />
                <FilterTab label="prefabs" active={filter === 'prefabs'} onClick={() => setFilter('prefabs')} />
                <FilterTab label="blueprints" active={filter === 'blueprints'} onClick={() => setFilter('blueprints')} />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    placeholder="search…"
                    className="flex-1 text-[12px] font-mono bg-neutral-50 border border-neutral-200 px-2 py-1 outline-none focus:border-neutral-400 placeholder:text-neutral-300"
                />
            </div>

            {/* grid */}
            <div className="overflow-y-auto p-2 flex-1">
                {filtered.length === 0 ? (
                    <div className="text-[12px] font-mono text-neutral-400 px-2 py-4 text-center">no items</div>
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
        <Popover open={infoOpen} onOpenChange={setInfoOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    onMouseEnter={() => setHovered(item)}
                    onMouseLeave={() => setHovered(null) /* simple: clearing on leave is fine, the next enter sets it again */}
                    onClick={() => setCarried(isCarried ? null : item)}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setInfoOpen((o) => !o);
                    }}
                    className={`flex flex-col items-center justify-center gap-1 p-1 cursor-pointer transition-colors ${
                        isCarried
                            ? 'bg-blue-100 ring-2 ring-blue-400'
                            : 'bg-neutral-50 hover:bg-neutral-100 hover:ring-1 hover:ring-neutral-300'
                    }`}
                    title={`${display.title}${carried ? '' : ' — left-click pick up, right-click info'}`}
                    style={{ minHeight: ITEM_SIZE }}
                >
                    <InventoryItemIcon item={item} size={ICON_SIZE} />
                    <span className="text-[10px] text-neutral-700 truncate max-w-full">{display.name}</span>
                    {display.id !== display.name && (
                        <span className="text-[8px] font-mono text-neutral-400 truncate max-w-full -mt-0.5">{display.id}</span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-64 p-3">
                <InventoryItemInfo item={item} />
            </PopoverContent>
        </Popover>
    );
});

function InventoryItemInfo({ item }: { item: InventoryItem }) {
    const room = useEditor((s) => s.room);
    const display = inventoryItemDisplay(item, room);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <InventoryItemIcon item={item} size={32} />
                <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[12px] text-neutral-800 truncate">{display.name}</span>
                    <span className="text-[10px] font-mono text-neutral-400 uppercase">{item.kind}</span>
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
    const def = registry.prefabs.byId.get(prefabId)?.payload;
    if (!def) return null;
    return <InfoRow label="type" value={def.type} />;
}

function BlockInfoRows({ blockKey }: { blockKey: string }) {
    const idOnly = blockKey.split('[')[0]!;
    if (idOnly === blockKey) return null;
    return <InfoRow label="state" value={blockKey.slice(idOnly.length)} />;
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
            <span className="text-[9px] font-mono text-neutral-400 uppercase w-10 shrink-0">{label}</span>
            <code className="flex-1 min-w-0 text-[11px] font-mono text-neutral-800 bg-neutral-50 border border-neutral-200 px-1.5 py-0.5 truncate select-all">
                {value}
            </code>
            <button
                type="button"
                onClick={copy}
                title="copy"
                className="h-6 w-6 inline-flex items-center justify-center text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 cursor-pointer"
            >
                {copied ? <Icons.Check size={12} className="text-green-600" /> : <Icons.Copy size={12} />}
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
                active ? 'bg-neutral-800 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
        >
            {label}
        </button>
    );
}

/* ── scenes tab ──────────────────────────────────────────────────── */

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
    const roomList = useEditor((s) => s.roomList);
    const joinedPlayers = useEditor((s) => s.joinedPlayers);
    const switchRoom = useEditor((s) => s.switchRoom);
    const [newScene, setNewScene] = useState('');

    const sortedScenes = [...sceneList].sort((a, b) => a.localeCompare(b));
    const existingNames = new Set(sceneList);

    const prefabSourceScenes = new Set<string>();
    if (room) {
        for (const h of registry.prefabs.byId.values()) {
            for (const dep of h.payload.deps) {
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
                switchRoom(existing.id, 'edit');
            } else {
                openScene(sceneId);
            }
        },
        [roomList, joinedPlayers, switchRoom, openScene],
    );

    const handleCreate = useCallback(() => {
        const trimmed = newScene.trim();
        const name = trimmed || nextSceneName(sceneList);
        openScene?.(name);
        setNewScene('');
    }, [newScene, openScene, sceneList]);

    return (
        <>
            {/* tile grid */}
            <div className="overflow-y-auto p-2 flex-1">
                {sortedScenes.length === 0 ? (
                    <div className="text-[12px] font-mono text-neutral-400 px-2 py-4 text-center">no scenes</div>
                ) : (
                    <div
                        className="grid gap-2"
                        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${SCENE_TILE_SIZE}px, 1fr))` }}
                    >
                        {sortedScenes.map((sceneId) => (
                            <SceneTile
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

            {/* create new */}
            <div className="px-3 py-2 border-t border-neutral-200">
                <div className="flex items-center gap-1">
                    <input
                        type="text"
                        placeholder={nextSceneName(sceneList)}
                        value={newScene}
                        onChange={(e) => setNewScene(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreate();
                        }}
                        className="flex-1 min-w-0 h-7 px-1.5 text-[11px] font-mono text-neutral-700 border border-neutral-200 bg-white outline-none focus:border-neutral-400"
                    />
                    <button
                        type="button"
                        onClick={handleCreate}
                        className="h-7 w-7 inline-flex items-center justify-center border border-neutral-200 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 cursor-pointer"
                        title="create scene"
                    >
                        <Icons.Plus size={12} />
                    </button>
                </div>
            </div>
        </>
    );
}

function SceneTile({
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
            className={`group relative flex flex-col items-stretch p-1 cursor-pointer transition-colors ${
                isActive ? 'bg-neutral-800' : 'bg-neutral-50 hover:bg-neutral-100 hover:ring-1 hover:ring-neutral-300'
            }`}
        >
            {/* thumbnail */}
            <button
                type="button"
                onClick={() => onOpen(sceneId)}
                className="block w-full cursor-pointer"
                title={sceneId}
                style={{ height: SCENE_THUMB_SIZE }}
            >
                {/* scene (blueprint) icons are not rendered — neutral placeholder. */}
                <div className="bg-neutral-200" style={{ width: '100%', height: '100%' }} />
            </button>

            {/* label / rename */}
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
                    className="mt-1 w-full px-1 py-0.5 text-[10px] font-mono text-neutral-800 bg-white border border-blue-400 outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={() => onOpen(sceneId)}
                    className={`mt-1 text-[10px] font-mono text-left truncate cursor-pointer ${
                        isActive ? 'text-white' : 'text-neutral-700'
                    }`}
                    title={sceneId}
                >
                    {sceneId}
                </button>
            )}

            {/* hover-only action chips, top-right */}
            {!editing && (
                <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    {isPrefabSource && (
                        <span
                            className={`inline-flex items-center px-1 py-0.5 text-[9px] font-mono ${
                                isActive ? 'text-cyan-200 bg-cyan-900/60' : 'text-cyan-700 bg-cyan-50'
                            }`}
                            title="referenced by prefab()"
                        >
                            <Icons.Tags size={8} />
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
                                ? 'bg-neutral-700 text-neutral-300 hover:text-white'
                                : 'bg-white border border-neutral-200 text-neutral-500 hover:text-neutral-800'
                        }`}
                        title="rename"
                    >
                        <Icons.Pencil size={10} />
                    </button>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`delete scene "${sceneId}"?`)) onDelete(sceneId);
                        }}
                        className={`h-5 w-5 inline-flex items-center justify-center cursor-pointer ${
                            isActive
                                ? 'bg-neutral-700 text-neutral-300 hover:text-red-300'
                                : 'bg-white border border-neutral-200 text-neutral-500 hover:text-red-500'
                        }`}
                        title="delete"
                    >
                        <Icons.Trash2 size={10} />
                    </button>
                </div>
            )}
        </div>
    );
}
