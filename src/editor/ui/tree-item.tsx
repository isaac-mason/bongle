import { useSortable } from '@dnd-kit/react/sortable';
import * as Icons from 'bongle/icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from '../../client/ui/components';
import { useEditRoom } from '../edit-room-store';
import type { FlattenedNode } from './tree-utils';

const INDENTATION = 20;

const sortableConfig = {
    alignment: {
        x: 'start' as const,
        y: 'center' as const,
    },
    transition: {
        idle: true,
    },
};

export const TreeItem = memo(function TreeItem({
    item,
    virtualStart,
    isRenaming,
    onSelect,
    onToggleCollapse,
    onRemove,
    onCommitRename,
    onCancelRename,
    onStartRename,
}: {
    item: FlattenedNode;
    /** y-offset within the virtualized list. row is positioned absolute so
     * dnd-kit's drag transform can compose freely on top. */
    virtualStart: number;
    isRenaming: boolean;
    onSelect: (nodeId: number, event: React.MouseEvent | React.KeyboardEvent) => void;
    onToggleCollapse: (nodeId: number) => void;
    onRemove: (nodeId: number) => void;
    onCommitRename: (nodeId: number, newName: string) => void;
    onCancelRename: () => void;
    onStartRename: (nodeId: number) => void;
}) {
    // subscribe to a boolean so this item only rerenders when its own selection changes
    const isSelected = useEditRoom((s) => s.selection.nodes.has(item.nodeId));
    const hasChildren = item.node.children.length > 0;

    const [renameValue, setRenameValue] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // when entering rename mode, seed the value and focus the input
    useEffect(() => {
        if (isRenaming) {
            setRenameValue(item.node.name ?? `Node ${item.nodeId}`);
            // focus on next tick so the input is mounted
            requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            });
        }
    }, [isRenaming, item.node.name, item.nodeId]);

    const commitRename = useCallback(() => {
        onCommitRename(item.nodeId, renameValue);
    }, [onCommitRename, item.nodeId, renameValue]);

    const { ref, handleRef, isDragSource } = useSortable({
        ...sortableConfig,
        id: item.id,
        index: item.index,
        data: {
            depth: item.depth,
            parentId: item.parentId,
        },
    });

    const handleClick = useCallback((e: React.MouseEvent) => onSelect(item.nodeId, e), [onSelect, item.nodeId]);
    const handleDoubleClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onStartRename(item.nodeId);
        },
        [onStartRename, item.nodeId],
    );
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item.nodeId, e);
            }
        },
        [onSelect, item.nodeId],
    );
    const handleToggle = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onToggleCollapse(item.nodeId);
        },
        [onToggleCollapse, item.nodeId],
    );
    const handleRemoveClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onRemove(item.nodeId);
        },
        [onRemove, item.nodeId],
    );

    return (
        <li
            ref={ref}
            data-node-id={item.nodeId}
            className={`
                absolute left-0 right-0 flex items-center gap-1 py-0.5 pr-1 rounded select-none font-mono text-[10px] outline-none focus:ring-1 focus:ring-accent
                ${isDragSource ? 'opacity-40' : ''}
                ${isSelected ? 'bg-accent/25' : 'hover:bg-surface-muted'}
            `}
            style={{ top: virtualStart, paddingLeft: item.depth * INDENTATION + 4, contain: 'layout style paint' }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={hasChildren ? !item.collapsed : undefined}
            tabIndex={0}
        >
            {/* drag handle */}
            <span ref={handleRef} className="cursor-grab active:cursor-grabbing text-fg-muted shrink-0 select-none px-0.5">
                <Icons.GripVertical size={12} />
            </span>

            {/* expand/collapse */}
            {hasChildren ? (
                <button
                    type="button"
                    onClick={handleToggle}
                    className="w-3.5 flex items-center justify-center shrink-0 cursor-pointer text-fg-muted bg-transparent border-none p-0"
                >
                    {item.collapsed ? <Icons.ChevronRight size={12} /> : <Icons.ChevronDown size={12} />}
                </button>
            ) : (
                <span className="w-3.5 shrink-0" />
            )}

            {/* name (inline rename when isRenaming) */}
            {isRenaming ? (
                <input
                    ref={inputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            onCancelRename();
                        }
                        e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-surface border border-border rounded px-1 py-0 text-[10px] font-mono text-fg outline-none focus:border-accent"
                />
            ) : (
                <span className={`truncate ${item.effectivePersist ? 'text-fg' : 'text-fg-muted italic'}`}>
                    {item.node.name || `Node ${item.nodeId}`}
                </span>
            )}

            {/* child count badge when collapsed */}
            {item.collapsed && item.childCount > 0 && (
                <span className="text-[10px] text-fg-muted bg-surface-muted rounded px-1">{item.childCount}</span>
            )}

            {/* delete button */}
            {isSelected && (
                <IconButton variant="danger" className="ml-auto" onClick={handleRemoveClick}>
                    <Icons.X size={12} />
                </IconButton>
            )}
        </li>
    );
});

/* ── Drag overlay ───────────────────────────────────────────────── */

export function TreeItemOverlay({ item, childCount }: { item: FlattenedNode; childCount: number }) {
    return (
        <div className="relative flex items-center gap-1 py-0.5 px-2 bg-surface border border-border rounded shadow-lg font-mono text-[10px] w-max">
            <Icons.GripVertical size={12} className="text-fg-muted" />
            <span className={item.effectivePersist ? 'text-fg' : 'text-fg-muted italic'}>
                {item.node.name || `Node ${item.nodeId}`}
            </span>
            {childCount > 0 && (
                <span className="absolute -top-2 -right-2 flex items-center justify-center w-5 h-5 rounded-full bg-accent text-on-accent text-[10px] font-semibold">
                    {childCount}
                </span>
            )}
        </div>
    );
}
