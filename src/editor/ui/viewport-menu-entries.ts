import * as Icons from '../../../icons';
import * as Selection from '../../core/scene/selection';
import { findNodeShape } from '../actions';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';
import { parsePattern } from '../scene/pattern';
import { type NodeMenuEntry, nodeMenuEntries } from './node-menu';

/**
 * the viewport context menu's entries, as plain data — a pure function of the store snapshot, not
 * a hook. this is the single content source for BOTH the click-triggered dropdown
 * (`viewport-context-menu.tsx`, cursor visible) and the hold-RMB radial menu (`radial-menu.tsx`,
 * pointer-locked), so what a wedge shows and what it does can never drift apart. call it fresh
 * wherever the current entries are needed — it's cheap and this menu is rarely open.
 */
export function buildViewportMenuEntries(store: EditRoomStoreApi): NodeMenuEntry[] {
    const s = store.getState();
    const menu = s.viewportContextMenu;
    if (!menu) return [];

    const editor = useEditor.getState();
    const sceneGraph = editor.room?.scene ?? null;
    const hotbar = editor.hotbar;
    const activeBlockKey = activeBlockKeyOf(hotbar, s.activeSlotIndex);

    const selectedNodeIds = s.selection.nodes;
    const nodeCount = selectedNodeIds.size;
    const hasNodes = nodeCount > 0;
    const voxelCount = Selection.countVoxels(s.selection);
    const hasVoxels = voxelCount > 0;

    if (hasNodes) {
        const singleNodeId = nodeCount === 1 ? (selectedNodeIds.values().next().value as number) : null;
        const singleNode = singleNodeId !== null && sceneGraph ? (sceneGraph.idToNode.get(singleNodeId) ?? null) : null;
        const singleNodeHasShape = singleNode !== null && findNodeShape(singleNode) !== null;

        return nodeMenuEntries({
            node: singleNode,
            multiCount: nodeCount,
            actions: {
                focus: () => {
                    const first = selectedNodeIds.values().next().value as number | undefined;
                    if (first !== undefined) s.focusNode(first);
                },
                copy: s.copyToClipboard,
                duplicate: () => {
                    if (!singleNode) return;
                    s.createNode(
                        singleNode.parent?.id ?? 0,
                        singleNode.parent?.children.length ?? 0,
                        `${singleNode.name} (copy)`,
                    );
                },
                bake: () => {
                    if (singleNodeId !== null) s.bakePrefab(singleNodeId);
                },
                delete: () => {
                    if (nodeCount > 1) s.destroySelectedNodes();
                    else if (singleNodeId !== null) s.destroyNode(singleNodeId);
                },
                fitToSelection: singleNodeHasShape && hasVoxels ? () => s.fitToSelection(singleNodeId!) : undefined,
                selectInside: singleNodeHasShape ? () => s.selectInside(singleNodeId!) : undefined,
                addTrait:
                    singleNodeId !== null
                        ? () => s.setTraitPicker({ nodeId: singleNodeId, clientX: menu.x, clientY: menu.y })
                        : undefined,
            },
        });
    }

    if (hasVoxels) {
        const onFill = () => {
            if (activeBlockKey) s.fill(parsePattern(activeBlockKey));
        };
        const onReplace = () => {
            if (activeBlockKey) s.replace(parsePattern(activeBlockKey));
        };
        const entries: NodeMenuEntry[] = [
            { kind: 'item', id: 'copy', Icon: Icons.ClipboardCopy, label: 'Copy', onSelect: s.copyToClipboard },
            {
                kind: 'item',
                id: 'blueprint',
                Icon: Icons.BookmarkPlus,
                label: 'Create blueprint',
                onSelect: () => s.saveBlueprint(),
            },
        ];
        if (activeBlockKey) {
            entries.push({ kind: 'item', id: 'fill', Icon: Icons.Paintbrush, label: 'Fill', onSelect: onFill });
            entries.push({ kind: 'item', id: 'replace', Icon: Icons.Replace, label: 'Replace', onSelect: onReplace });
        }
        entries.push({ kind: 'separator', id: 'sep-destroy' });
        entries.push({ kind: 'item', id: 'delete', Icon: Icons.X, label: 'Delete', variant: 'danger', onSelect: s.delete });
        return entries;
    }

    if (menu.block) {
        const block = menu.block;
        const world = menu.world;
        return [
            {
                kind: 'item',
                id: 'pick-block',
                Icon: Icons.Crosshair,
                label: 'Pick block',
                onSelect: () => useEditor.getState().setHotbarSlot(s.activeSlotIndex, { kind: 'block', blockKey: block.key }),
            },
            {
                kind: 'item',
                id: 'new-node-here',
                Icon: Icons.Plus,
                label: 'New node here',
                onSelect: () => {
                    if (world) s.createNodeAt(world);
                },
            },
        ];
    }

    return [];
}
