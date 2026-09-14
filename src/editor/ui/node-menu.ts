import * as Icons from '../../../icons';
import type { Node } from '../../core/scene/scene-tree';

export type NodeMenuItem = {
    kind: 'item';
    id: string;
    Icon: Icons.IconComponent;
    label: string;
    onSelect: () => void;
    variant?: 'danger';
};

export type NodeMenuSeparator = { kind: 'separator'; id: string };

export type NodeMenuEntry = NodeMenuItem | NodeMenuSeparator;

export type NodeMenuActions = {
    focus: () => void;
    copy: () => void;
    duplicate: () => void;
    bake: () => void;
    delete: () => void;
    /** present when the node has a shape field; `fitToSelection` only while a voxel selection exists. */
    fitToSelection?: () => void;
    selectInside?: () => void;
    /** opens the trait picker at the menu. */
    addTrait?: () => void;
};

export type NodeMenuOptions = {
    /** the right-clicked node when the menu targets one specific node. null for multi-select. */
    node: Node | null;
    /** number of nodes the menu acts on, drives label pluralization. */
    multiCount: number;
    actions: NodeMenuActions;
};

/** shared node-menu entries in render order. `Bake Prefab` only appears for
 *  single-node menus on a prefab wrapper; multi-select hides single-target ops. */
export function nodeMenuEntries(opts: NodeMenuOptions): NodeMenuEntry[] {
    const { node, multiCount, actions } = opts;
    const isMulti = multiCount > 1;
    const entries: NodeMenuEntry[] = [];

    entries.push({
        kind: 'item',
        id: 'focus',
        Icon: Icons.Focus,
        label: isMulti ? 'Focus First' : 'Focus',
        onSelect: actions.focus,
    });
    entries.push({ kind: 'item', id: 'copy', Icon: Icons.ClipboardCopy, label: 'Copy', onSelect: actions.copy });
    if (!isMulti) {
        if (actions.addTrait) {
            entries.push({ kind: 'item', id: 'add-trait', Icon: Icons.Plus, label: 'Add Trait', onSelect: actions.addTrait });
        }
        entries.push({ kind: 'item', id: 'duplicate', Icon: Icons.Copy, label: 'Duplicate', onSelect: actions.duplicate });
        if (node?.prefab) {
            entries.push({ kind: 'item', id: 'bake', Icon: Icons.Hammer, label: 'Bake Prefab', onSelect: actions.bake });
        }
        if (actions.fitToSelection) {
            entries.push({
                kind: 'item',
                id: 'fit',
                Icon: Icons.BoxSelect,
                label: 'Fit to Selection',
                onSelect: actions.fitToSelection,
            });
        }
        if (actions.selectInside) {
            entries.push({
                kind: 'item',
                id: 'select-inside',
                Icon: Icons.BoxSelect,
                label: 'Select Inside',
                onSelect: actions.selectInside,
            });
        }
    }
    entries.push({ kind: 'separator', id: 'sep-destroy' });
    entries.push({
        kind: 'item',
        id: 'delete',
        Icon: Icons.X,
        label: isMulti ? `Delete ${multiCount} items` : 'Delete',
        variant: 'danger',
        onSelect: actions.delete,
    });

    return entries;
}
