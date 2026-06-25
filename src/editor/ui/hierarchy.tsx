import { move } from '@dnd-kit/helpers';
import { DragDropProvider, DragOverlay } from '@dnd-kit/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as Icons from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../client/ui/components';
import { useEditor } from '../editor-store';
import { activeEditRoomStore, useEditRoom } from '../edit-room-store';
import { nodeMenuEntries } from './node-menu';
import { TreeItem, TreeItemOverlay } from './tree-item';
import {
    computeReorderOps,
    type FlattenedNode,
    flattenSceneGraph,
    flattenSceneGraphFiltered,
    getDescendantIds,
    getDragDepth,
    getProjection,
} from './tree-utils';

const INDENTATION = 20;
const ROW_HEIGHT = 22;

/**
 * shallow-compare two flat lists — returns true if they represent the
 * same visible tree (same ids in same order with same depth/parentId/
 * collapsed/childCount/name/persist). avoids a react re-render when
 * sceneRevision bumps but nothing the hierarchy cares about actually changed.
 */
function flatListsEqual(a: FlattenedNode[], b: FlattenedNode[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        if (
            ai.nodeId !== bi.nodeId ||
            ai.depth !== bi.depth ||
            ai.parentId !== bi.parentId ||
            ai.collapsed !== bi.collapsed ||
            ai.childCount !== bi.childCount ||
            ai.node.name !== bi.node.name ||
            ai.effectivePersist !== bi.effectivePersist ||
            ai.node.children.length !== bi.node.children.length
        )
            return false;
    }
    return true;
}

/* ── Hierarchy panel ────────────────────────────────────────────── */

export function HierarchyPanel() {
    const room = useEditor((s) => s.room);
    const selectedNodeIds = useEditRoom((s) => s.selection.nodes);
    const selectNode = useEditRoom((s) => s.selectNode);
    const addToSelection = useEditRoom((s) => s.addToSelection);
    const removeFromSelection = useEditRoom((s) => s.removeFromSelection);
    const setSelection = useEditRoom((s) => s.setSelection);
    const sceneRevision = useEditRoom((s) => s.sceneRevision);
    const destroyNode = useEditRoom((s) => s.destroyNode);
    const destroySelectedNodes = useEditRoom((s) => s.destroySelectedNodes);
    const reparentNode = useEditRoom((s) => s.reparentNode);
    const createNode = useEditRoom((s) => s.createNode);
    const focusNodeStore = useEditRoom((s) => s.focusNode);
    const copyToClipboard = useEditRoom((s) => s.copyToClipboard);
    const setName = useEditRoom((s) => s.setName);
    const bakePrefab = useEditRoom((s) => s.bakePrefab);
    const sceneGraph = room?.nodes ?? null;

    // text filter — when non-empty, the tree shows only matching nodes + their
    // ancestors, ignoring collapsed state.
    const [filter, setFilter] = useState('');
    const filterActive = filter.trim().length > 0;

    // node currently being inline-renamed (single-active rename across the tree).
    const [renamingNodeId, setRenamingNodeId] = useState<number | null>(null);

    // node id targeted by the next context menu open. set in onContextMenu of
    // the scroll container before radix opens the shared menu.
    const [contextNodeId, setContextNodeId] = useState<number | null>(null);
    const contextNode = contextNodeId !== null && sceneGraph ? sceneGraph._idToNode.get(contextNodeId) : null;

    // anchor for shift+click range select — set by plain click and cmd/ctrl+click,
    // unchanged by shift+click so a user can extend the range from a fixed anchor.
    const selectionAnchorId = useRef<number | null>(null);

    // collapsed nodes — tracked by numeric node id
    const [collapsedIds, setCollapsedIds] = useState<Set<number>>(() => new Set());

    // node ids we've already auto-collapsed (prefabs + high-fan-out nodes) —
    // guards against re-collapsing a node the user has explicitly expanded.
    const autoCollapsedSeenIds = useRef<Set<number>>(new Set());

    // flattened items state — owned by this component, rebuilt from scene graph
    const [flattenedItems, setFlattenedItems] = useState<FlattenedNode[]>([]);

    // track initial depth of dragged item
    const initialDepth = useRef(0);

    // track removed children during drag (descendants of source)
    const sourceChildren = useRef<FlattenedNode[]>([]);

    // track whether a drag is in progress
    const isDragging = useRef(false);

    // recompute flattened list from scene graph when not dragging.
    // sceneRevision is intentionally in the dep array to trigger rebuilds on
    // external scene graph mutations (e.g. node added via inspector).
    // biome-ignore lint/correctness/useExhaustiveDependencies: sceneRevision triggers rebuild on external scene graph mutations
    useEffect(() => {
        if (isDragging.current || !sceneGraph) return;

        if (filterActive) {
            // skip auto-collapse and use the filtered flatten path
            const next = flattenSceneGraphFiltered(sceneGraph, filter);
            setFlattenedItems((prev) => (flatListsEqual(prev, next) ? prev : next));
            return;
        }

        // auto-collapse every non-root node with children on first sight, so
        // the default tree shows just the top level. once a user expands a
        // node we remember it in autoCollapsedSeenIds and never re-collapse.
        const rootId = sceneGraph.root.id;
        const newlySeen: number[] = [];
        for (const node of sceneGraph._idToNode.values()) {
            if (autoCollapsedSeenIds.current.has(node.id)) continue;
            if (node.id === rootId) continue;
            if (node.children.length === 0) continue;
            autoCollapsedSeenIds.current.add(node.id);
            newlySeen.push(node.id);
        }
        if (newlySeen.length > 0) {
            setCollapsedIds((prev) => {
                const next = new Set(prev);
                for (const id of newlySeen) next.add(id);
                return next;
            });
            return; // re-runs once collapsedIds updates
        }
        const next = flattenSceneGraph(sceneGraph, collapsedIds);
        setFlattenedItems((prev) => (flatListsEqual(prev, next) ? prev : next));
    }, [sceneGraph, collapsedIds, sceneRevision, filter, filterActive]);

    const toggleCollapse = useCallback((nodeId: number) => {
        setCollapsedIds((prev) => {
            const next = new Set(prev);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setCollapsed = useCallback((nodeId: number, collapsed: boolean) => {
        setCollapsedIds((prev) => {
            if (collapsed === prev.has(nodeId)) return prev;
            const next = new Set(prev);
            if (collapsed) next.add(nodeId);
            else next.delete(nodeId);
            return next;
        });
    }, []);

    const scrollRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    const virtualizer = useVirtualizer({
        count: flattenedItems.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
        getItemKey: (i) => flattenedItems[i].id,
    });

    const focusItem = useCallback(
        (nodeId: number) => {
            // tree rows are <li data-node-id="..."> — find and focus the row so
            // subsequent arrow keys originate from the right place. with
            // virtualization the row may be unmounted, so scroll it into view
            // first and focus on the next frame once it's rendered.
            const idx = flattenedItems.findIndex((it) => it.nodeId === nodeId);
            if (idx === -1) return;
            virtualizer.scrollToIndex(idx, { align: 'auto' });
            requestAnimationFrame(() => {
                const el = listRef.current?.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
                el?.focus();
            });
        },
        [flattenedItems, virtualizer],
    );

    const handleListKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLUListElement>) => {
            if (flattenedItems.length === 0) return;
            // ignore when typing in a child input (e.g. inline rename)
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

            const focusedIdAttr = (document.activeElement as HTMLElement | null)?.dataset.nodeId;
            const currentIdx = focusedIdAttr ? flattenedItems.findIndex((it) => it.nodeId === Number(focusedIdAttr)) : -1;

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const start = currentIdx === -1 ? 0 : currentIdx;
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                const nextIdx = Math.max(0, Math.min(flattenedItems.length - 1, start + (currentIdx === -1 ? 0 : delta)));
                const next = flattenedItems[nextIdx];
                selectNode(next.nodeId);
                selectionAnchorId.current = next.nodeId;
                focusItem(next.nodeId);
            } else if (e.key === 'ArrowLeft') {
                if (currentIdx === -1) return;
                e.preventDefault();
                const item = flattenedItems[currentIdx];
                const expanded = item.node.children.length > 0 && !item.collapsed;
                if (expanded) {
                    setCollapsed(item.nodeId, true);
                } else if (item.parentId !== null) {
                    const parentNodeId = Number(item.parentId);
                    const parent = flattenedItems.find((it) => it.nodeId === parentNodeId);
                    if (parent) {
                        selectNode(parent.nodeId);
                        selectionAnchorId.current = parent.nodeId;
                        focusItem(parent.nodeId);
                    }
                }
            } else if (e.key === 'ArrowRight') {
                if (currentIdx === -1) return;
                e.preventDefault();
                const item = flattenedItems[currentIdx];
                if (item.node.children.length === 0) return;
                if (item.collapsed) {
                    setCollapsed(item.nodeId, false);
                } else {
                    const child = flattenedItems[currentIdx + 1];
                    if (child && child.parentId === item.id) {
                        selectNode(child.nodeId);
                        selectionAnchorId.current = child.nodeId;
                        focusItem(child.nodeId);
                    }
                }
            }
        },
        [flattenedItems, selectNode, setCollapsed, focusItem],
    );

    const handleSelect = useCallback(
        (nodeId: number, event: React.MouseEvent | React.KeyboardEvent) => {
            const meta = event.metaKey || event.ctrlKey;
            const shift = event.shiftKey;
            const store = activeEditRoomStore().getState();

            if (shift && selectionAnchorId.current !== null && selectionAnchorId.current !== nodeId) {
                // range-select between anchor and clicked, inclusive, in flat-list order
                const anchorIdx = flattenedItems.findIndex((it) => it.nodeId === selectionAnchorId.current);
                const targetIdx = flattenedItems.findIndex((it) => it.nodeId === nodeId);
                if (anchorIdx !== -1 && targetIdx !== -1) {
                    const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
                    const ids: number[] = [];
                    for (let i = lo; i <= hi; i++) ids.push(flattenedItems[i].nodeId);
                    setSelection(ids);
                    return;
                }
            }

            if (meta) {
                if (store.selection.nodes.has(nodeId)) removeFromSelection(nodeId);
                else addToSelection(nodeId);
                selectionAnchorId.current = nodeId;
                return;
            }

            selectNode(nodeId);
            selectionAnchorId.current = nodeId;
        },
        [flattenedItems, selectNode, addToSelection, removeFromSelection, setSelection],
    );

    const handleRemove = useCallback(
        (nodeId: number) => {
            if (!sceneGraph) return;
            const node = sceneGraph._idToNode.get(nodeId);
            if (!node || node === sceneGraph.root) return;
            destroyNode(nodeId);
            // read selection from store at call-time to avoid stale closure
            if (activeEditRoomStore().getState().selection.nodes.has(nodeId)) selectNode(null);
        },
        [sceneGraph, selectNode, destroyNode],
    );

    const handleStartRename = useCallback((nodeId: number) => {
        setRenamingNodeId(nodeId);
    }, []);

    const handleCommitRename = useCallback(
        (nodeId: number, newName: string) => {
            setRenamingNodeId(null);
            const trimmed = newName.trim();
            if (!sceneGraph) return;
            const node = sceneGraph._idToNode.get(nodeId);
            if (!node) return;
            if (trimmed && trimmed !== node.name) {
                setName(nodeId, trimmed);
            }
        },
        [sceneGraph, setName],
    );

    const handleCancelRename = useCallback(() => {
        setRenamingNodeId(null);
    }, []);

    // on right-click anywhere in the scroll container, find the row that was
    // clicked (via data-node-id) and stash its id so the shared context menu
    // can target it. also select the node if it isn't already part of the
    // current selection — preserves multi-select on right-click.
    const handleContextMenuTrigger = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const li = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
            if (!li) {
                // empty space: suppress both the native menu and Base UI opening
                // its context menu (Base UI honours preventBaseUIHandler, not
                // preventDefault, for skipping its own handler).
                e.preventDefault();
                (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                setContextNodeId(null);
                return;
            }
            const nodeId = Number(li.dataset.nodeId);
            if (Number.isNaN(nodeId)) return;
            setContextNodeId(nodeId);
            if (!activeEditRoomStore().getState().selection.nodes.has(nodeId)) {
                selectNode(nodeId);
            }
        },
        [selectNode],
    );

    const handleMenuRename = useCallback(() => {
        if (contextNodeId !== null) setRenamingNodeId(contextNodeId);
    }, [contextNodeId]);

    const handleMenuCreateChild = useCallback(() => {
        if (contextNodeId === null || !sceneGraph) return;
        const node = sceneGraph._idToNode.get(contextNodeId);
        if (!node) return;
        createNode(contextNodeId, node.children.length, 'New Node');
    }, [contextNodeId, sceneGraph, createNode]);

    // when the right-clicked node is part of a multi-selection, shared menu
    // ops (delete, focus first) act on the full selection in one undo entry;
    // single-target items (duplicate, bake, rename, create child) are hidden.
    const contextInMultiSelect = contextNodeId !== null && selectedNodeIds.has(contextNodeId) && selectedNodeIds.size > 1;
    const sharedMultiCount = contextInMultiSelect ? selectedNodeIds.size : 1;
    const sharedEntries =
        contextNode !== null
            ? nodeMenuEntries({
                  node: contextInMultiSelect ? null : (contextNode ?? null),
                  multiCount: sharedMultiCount,
                  actions: {
                      focus: () => {
                          if (contextInMultiSelect) {
                              const first = selectedNodeIds.values().next().value as number | undefined;
                              if (first !== undefined) focusNodeStore(first);
                          } else if (contextNodeId !== null) {
                              focusNodeStore(contextNodeId);
                          }
                      },
                      copy: copyToClipboard,
                      duplicate: () => {
                          if (contextNodeId === null || !sceneGraph) return;
                          const node = sceneGraph._idToNode.get(contextNodeId);
                          if (!node) return;
                          createNode(node.parent?.id ?? 0, node.parent?.children.length ?? 0, `${node.name} (copy)`);
                      },
                      bake: () => {
                          if (contextNodeId !== null) bakePrefab(contextNodeId);
                      },
                      delete: () => {
                          if (contextInMultiSelect) destroySelectedNodes();
                          else if (contextNodeId !== null) handleRemove(contextNodeId);
                      },
                  },
              })
            : [];

    if (!sceneGraph) {
        return (
            <div className="flex flex-col">
                <div className="p-2 text-[10px] text-neutral-400 font-mono">no scene loaded</div>
            </div>
        );
    }

    const totalSize = virtualizer.getTotalSize();
    const virtualRows = virtualizer.getVirtualItems();

    return (
        <div className="flex flex-col h-full">
            <div className="p-1 border-b border-neutral-200 flex items-center gap-1">
                <Icons.Search size={12} className="text-neutral-400 shrink-0" />
                <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="filter nodes…"
                    className="flex-1 min-w-0 bg-white border border-neutral-200 rounded px-1 py-0.5 text-[10px] font-mono text-neutral-700 outline-none focus:border-blue-400"
                />
                {filter.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setFilter('')}
                        className="text-neutral-400 hover:text-neutral-600 cursor-pointer bg-transparent border-none p-0.5"
                        aria-label="clear filter"
                    >
                        <Icons.X size={12} />
                    </button>
                )}
            </div>
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        ref={scrollRef}
                        className="p-1 overflow-y-auto flex-1"
                        onContextMenu={handleContextMenuTrigger}
                    >
                <DragDropProvider
                    onDragStart={(event) => {
                        const { source } = event.operation;
                        if (!source) return;

                        isDragging.current = true;

                        const item = flattenedItems.find(({ id }) => id === String(source.id));
                        if (!item) return;

                        // store the source item's initial depth
                        initialDepth.current = item.depth;

                        setFlattenedItems((items) => {
                            sourceChildren.current = [];

                            // get all descendants of the source item
                            const descendants = getDescendantIds(items, source.id);

                            return items
                                .filter((item) => {
                                    if (descendants.has(item.id)) {
                                        sourceChildren.current.push(item);
                                        return false;
                                    }
                                    return true;
                                })
                                .map((item, index) => ({ ...item, index }));
                        });
                    }}
                    onDragOver={(event, manager) => {
                        const { source, target } = event.operation;

                        event.preventDefault();

                        if (source && target && source.id !== target.id) {
                            setFlattenedItems((items) => {
                                const offsetLeft = manager.dragOperation.transform.x;
                                const dragDepth = getDragDepth(offsetLeft, INDENTATION);
                                const projectedDepth = initialDepth.current + dragDepth;

                                const { depth, parentId } = getProjection(items, target.id, projectedDepth);

                                const sortedItems = move(items, event);
                                return sortedItems.map((item, index) =>
                                    item.id === String(source.id) ? { ...item, depth, parentId, index } : { ...item, index },
                                );
                            });
                        }
                    }}
                    onDragMove={(event, manager) => {
                        if (event.defaultPrevented) return;

                        const { source, target } = event.operation;

                        if (source && target) {
                            const offsetLeft = manager.dragOperation.transform.x;
                            const dragDepth = getDragDepth(offsetLeft, INDENTATION);
                            const projectedDepth = initialDepth.current + dragDepth;

                            const { depth, parentId } = getProjection(flattenedItems, source.id, projectedDepth);

                            const currentData = source.data as { depth?: number; parentId?: string | null } | undefined;

                            if (currentData?.depth !== depth || currentData?.parentId !== parentId) {
                                setFlattenedItems((items) =>
                                    items.map((item) => (item.id === String(source.id) ? { ...item, depth, parentId } : item)),
                                );
                            }
                        }
                    }}
                    onDragEnd={(event) => {
                        isDragging.current = false;

                        if (event.canceled) {
                            // reset to scene graph state
                            setFlattenedItems(flattenSceneGraph(sceneGraph, collapsedIds));
                            return;
                        }

                        // compute reparent instructions and dispatch each one
                        const instructions = computeReorderOps(sceneGraph, flattenedItems, sourceChildren.current);
                        sourceChildren.current = [];

                        for (const instr of instructions) {
                            reparentNode(instr.nodeId, instr.parentId, instr.index);
                        }

                        // rebuild from the now-mutated scene graph
                        setFlattenedItems(flattenSceneGraph(sceneGraph, collapsedIds));
                    }}
                >
                    <ul
                        ref={listRef}
                        className="list-none m-0 p-0 relative"
                        style={{ height: totalSize }}
                        onKeyDown={handleListKeyDown}
                    >
                        {virtualRows.map((vr) => {
                            const item = flattenedItems[vr.index];
                            return (
                                <TreeItem
                                    key={item.id}
                                    item={item}
                                    virtualStart={vr.start}
                                    isRenaming={renamingNodeId === item.nodeId}
                                    onSelect={handleSelect}
                                    onToggleCollapse={toggleCollapse}
                                    onRemove={handleRemove}
                                    onCommitRename={handleCommitRename}
                                    onCancelRename={handleCancelRename}
                                    onStartRename={handleStartRename}
                                />
                            );
                        })}
                    </ul>
                    <DragOverlay>
                        {(source) => {
                            const item = flattenedItems.find(({ id }) => id === String(source.id));
                            if (!item) return null;
                            return <TreeItemOverlay item={item} childCount={sourceChildren.current.length} />;
                        }}
                    </DragOverlay>
                </DragDropProvider>
                    </div>
                </ContextMenuTrigger>
                {contextNode && (
                    <ContextMenuContent>
                        {!contextInMultiSelect && (
                            <>
                                <ContextMenuItem onSelect={handleMenuRename}>
                                    <Icons.Pencil size={12} /> Rename
                                </ContextMenuItem>
                                <ContextMenuItem onSelect={handleMenuCreateChild}>
                                    <Icons.Plus size={12} /> Create Child
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                            </>
                        )}
                        {sharedEntries.map((entry) =>
                            entry.kind === 'separator' ? (
                                <ContextMenuSeparator key={entry.id} />
                            ) : (
                                <ContextMenuItem key={entry.id} onSelect={entry.onSelect} variant={entry.variant}>
                                    <entry.Icon size={12} /> {entry.label}
                                </ContextMenuItem>
                            ),
                        )}
                    </ContextMenuContent>
                )}
            </ContextMenu>

            <div className="p-1 border-t border-neutral-200">
                <button
                    type="button"
                    onClick={() => {
                        const first = selectedNodeIds.size === 1 ? selectedNodeIds.values().next().value : null;
                        const selectedNode = first ? sceneGraph._idToNode.get(first) : null;
                        const parent = selectedNode ?? sceneGraph.root;
                        createNode(parent.id, parent.children.length, 'New Node');
                    }}
                    className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[11px] font-mono bg-neutral-50 border border-neutral-200 rounded text-neutral-600 hover:bg-neutral-100 cursor-pointer"
                >
                    <Icons.Plus size={12} /> Node
                </button>
            </div>
        </div>
    );
}
