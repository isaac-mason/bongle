// viewport-context-menu.tsx — right-click menu over the 3D viewport.
//
// the inspect tool tick decides when to open the menu (raycast + select on
// empty space, gate out drags/place/grab) and writes screen-pixel coords into
// store.viewportContextMenu. this component renders a 1×1 anchor at those
// coords inside the viewport container; a controlled DropdownMenu anchors its
// content to that point. (radix ContextMenu positions from native contextmenu
// events, so it can't be opened programmatically with a known coordinate —
// hence DropdownMenu, which anchors to its trigger's bounding box.)

import { useCallback, useMemo } from 'react';
import * as Icons from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../client/ui/components';
import { useEditor } from '../editor-store';
import { useEditRoom } from '../edit-room-store';
import { activeBlockKeyOf } from '../inventory';
import { parsePattern } from '../scene/pattern';
import { nodeMenuEntries } from './node-menu';
import * as Selection from '../../core/scene/selection';

export function ViewportContextMenu() {
    const menu = useEditRoom((s) => s.viewportContextMenu);
    const selectedNodeIds = useEditRoom((s) => s.selection.nodes);
    const voxelCount = useEditRoom((s) => Selection.countVoxels(s.selection));
    const close = useEditRoom((s) => s.closeViewportContextMenu);
    const focusNode = useEditRoom((s) => s.focusNode);
    const copyToClipboard = useEditRoom((s) => s.copyToClipboard);
    const saveBlueprint = useEditRoom((s) => s.saveBlueprint);
    const destroyNode = useEditRoom((s) => s.destroyNode);
    const destroySelectedNodes = useEditRoom((s) => s.destroySelectedNodes);
    const deleteVoxels = useEditRoom((s) => s.delete);
    const fill = useEditRoom((s) => s.fill);
    const replace = useEditRoom((s) => s.replace);
    const createNode = useEditRoom((s) => s.createNode);
    const bakePrefab = useEditRoom((s) => s.bakePrefab);
    const sceneGraph = useEditor((s) => s.room?.nodes ?? null);
    const hotbar = useEditor((s) => s.hotbar);
    const activeSlotIndex = useEditRoom((s) => s.activeSlotIndex);
    const activeBlockKey = useMemo(() => activeBlockKeyOf(hotbar, activeSlotIndex), [hotbar, activeSlotIndex]);
    const onFill = useCallback(() => {
        if (activeBlockKey) fill(parsePattern(activeBlockKey));
    }, [activeBlockKey, fill]);
    const onReplace = useCallback(() => {
        if (activeBlockKey) replace(parsePattern(activeBlockKey));
    }, [activeBlockKey, replace]);

    const nodeCount = selectedNodeIds.size;
    const hasNodes = nodeCount > 0;
    const hasVoxels = voxelCount > 0;
    const open = !!menu;

    const handleOpenChange = (next: boolean) => {
        if (!next) close();
    };

    // single-node selection unlocks node-specific ops (duplicate, bake).
    // for multi-select, only `node` is null and the shared entries hide them.
    const singleNodeId = nodeCount === 1 ? (selectedNodeIds.values().next().value as number) : null;
    const singleNode = singleNodeId !== null && sceneGraph ? sceneGraph._idToNode.get(singleNodeId) ?? null : null;

    const nodeEntries = hasNodes
        ? nodeMenuEntries({
              node: singleNode,
              multiCount: nodeCount,
              actions: {
                  focus: () => {
                      const first = selectedNodeIds.values().next().value as number | undefined;
                      if (first !== undefined) focusNode(first);
                  },
                  copy: copyToClipboard,
                  duplicate: () => {
                      if (!singleNode) return;
                      createNode(
                          singleNode.parent?.id ?? 0,
                          singleNode.parent?.children.length ?? 0,
                          `${singleNode.name} (copy)`,
                      );
                  },
                  bake: () => {
                      if (singleNodeId !== null) bakePrefab(singleNodeId);
                  },
                  delete: () => {
                      if (nodeCount > 1) destroySelectedNodes();
                      else if (singleNodeId !== null) destroyNode(singleNodeId);
                  },
              },
          })
        : [];

    return (
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>
                <div
                    aria-hidden
                    style={{
                        position: 'absolute',
                        left: menu?.x ?? 0,
                        top: menu?.y ?? 0,
                        width: 1,
                        height: 1,
                        pointerEvents: 'none',
                    }}
                />
            </DropdownMenuTrigger>
            {open && (hasNodes || hasVoxels) && (
                <DropdownMenuContent align="start" sideOffset={0}>
                    {hasNodes &&
                        nodeEntries.map((entry) =>
                            entry.kind === 'separator' ? (
                                <DropdownMenuSeparator key={entry.id} />
                            ) : (
                                <DropdownMenuItem key={entry.id} onSelect={entry.onSelect} variant={entry.variant}>
                                    <entry.Icon size={12} /> {entry.label}
                                </DropdownMenuItem>
                            ),
                        )}
                    {hasVoxels && !hasNodes && (
                        <>
                            <DropdownMenuItem onSelect={copyToClipboard}>
                                <Icons.ClipboardCopy size={12} /> Copy
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => saveBlueprint()}>
                                <Icons.BookmarkPlus size={12} /> Create blueprint
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!activeBlockKey} onSelect={onFill}>
                                <Icons.Paintbrush size={12} /> Fill
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!activeBlockKey} onSelect={onReplace}>
                                <Icons.Replace size={12} /> Replace
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={deleteVoxels} variant="danger">
                                <Icons.X size={12} /> Delete
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            )}
        </DropdownMenu>
    );
}
