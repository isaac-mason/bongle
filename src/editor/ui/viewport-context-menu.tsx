import { useCallback, useMemo, useRef } from 'react';
import * as Icons from '../../../icons';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../../client/ui/components';
import * as Selection from '../../core/scene/selection';
import { findNodeShape } from '../actions';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';
import { parsePattern } from '../scene/pattern';
import { nodeMenuEntries } from './node-menu';

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
    const fitToSelection = useEditRoom((s) => s.fitToSelection);
    const selectInside = useEditRoom((s) => s.selectInside);
    const setPromotePicker = useEditRoom((s) => s.setPromotePicker);
    const setTraitPicker = useEditRoom((s) => s.setTraitPicker);
    const createNodeAt = useEditRoom((s) => s.createNodeAt);
    const activeSlotIndex2 = useEditRoom((s) => s.activeSlotIndex);
    const setHotbarSlot = useEditor((s) => s.setHotbarSlot);
    const anchorRef = useRef<HTMLDivElement>(null);
    const openTraitPicker = useCallback(
        (nodeId: number) => {
            const rect = anchorRef.current?.getBoundingClientRect();
            setTraitPicker({ nodeId, clientX: rect?.left ?? 0, clientY: rect?.top ?? 0 });
        },
        [setTraitPicker],
    );
    const sceneGraph = useEditor((s) => s.room?.scene ?? null);
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

    // for multi-select, node is null and the shared entries hide single-node ops (duplicate, bake).
    const singleNodeId = nodeCount === 1 ? (selectedNodeIds.values().next().value as number) : null;
    const singleNode = singleNodeId !== null && sceneGraph ? (sceneGraph.idToNode.get(singleNodeId) ?? null) : null;
    const singleNodeHasShape = singleNode !== null && findNodeShape(singleNode) !== null;

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
                  fitToSelection: singleNodeHasShape && hasVoxels ? () => fitToSelection(singleNodeId!) : undefined,
                  selectInside: singleNodeHasShape ? () => selectInside(singleNodeId!) : undefined,
                  addTrait: singleNodeId !== null ? () => openTraitPicker(singleNodeId) : undefined,
              },
          })
        : [];

    return (
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>
                <div
                    ref={anchorRef}
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
                    {!hasNodes && menu?.block && (
                        <>
                            <DropdownMenuItem
                                onSelect={() => setHotbarSlot(activeSlotIndex2, { kind: 'block', blockKey: menu.block!.key })}
                            >
                                <Icons.Crosshair size={12} /> Pick block
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!menu.world} onSelect={() => menu.world && createNodeAt(menu.world)}>
                                <Icons.Plus size={12} /> New node here
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                        </>
                    )}
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
                            <DropdownMenuItem onSelect={() => setPromotePicker({ x: menu?.x ?? 0, y: menu?.y ?? 0 })}>
                                <Icons.Box size={12} /> Create node from selection
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
