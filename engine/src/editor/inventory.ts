/**
 * inventory + hotbar data shapes.
 *
 * an InventoryItem is a stable, identifier-only reference to either a block
 * (by state-key) or a prefab (by id). slots store these — never object refs,
 * never registry indices — so they survive project reload and registry churn.
 *
 * the catalog is computed on demand from runtime registries (blocks + prefabs),
 * not stored. it's just a flattened list for the inventory UI to render.
 */

import type { ClientRoom } from '../client/rooms';
import { registry } from '../core/registry';
import { formatKey, parseKey } from '../core/voxels/block-registry';

export type InventoryItem =
    | { kind: 'block'; blockKey: string }
    | { kind: 'prefab'; prefabId: string }
    | { kind: 'blueprint'; sceneId: string };

const BLUEPRINT_PREFIX = 'blueprints/';

export type HotbarSlot = InventoryItem | null;

export const HOTBAR_SIZE = 9;

export function emptyHotbar(): HotbarSlot[] {
    return Array.from({ length: HOTBAR_SIZE }, () => null);
}

/** stable string key for an item — usable as a react key or DnD id. */
export function inventoryItemKey(item: InventoryItem): string {
    switch (item.kind) {
        case 'block': return `block:${item.blockKey}`;
        case 'prefab': return `prefab:${item.prefabId}`;
        case 'blueprint': return `blueprint:${item.sceneId}`;
        default: return `unknown:${JSON.stringify(item)}`;
    }
}

/**
 * the block-state key for the active slot, or '' if the slot is empty or holds
 * a prefab. block-aware tools (build, paint, fill, replace) read this.
 */
export function activeBlockKeyOf(hotbar: HotbarSlot[], activeSlotIndex: number): string {
    const slot = hotbar[activeSlotIndex];
    return slot && slot.kind === 'block' ? slot.blockKey : '';
}

export function inventoryItemsEqual(a: InventoryItem | null, b: InventoryItem | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'block' && b.kind === 'block') return a.blockKey === b.blockKey;
    if (a.kind === 'prefab' && b.kind === 'prefab') return a.prefabId === b.prefabId;
    if (a.kind === 'blueprint' && b.kind === 'blueprint') return a.sceneId === b.sceneId;
    return false;
}

/**
 * resolve display strings for an inventory item — looks up the block/prefab
 * def by id and returns:
 *   - `name`: human-readable name from the def (falls back to id when none)
 *   - `id`:   the stable id string (blockKey for blocks, prefabId for prefabs)
 *   - `title`: a concise tooltip combining both
 *
 * Returns id-only fallbacks when the room or def isn't available.
 */
export function inventoryItemDisplay(
    item: InventoryItem,
    room: ClientRoom | null,
): { name: string; id: string; title: string } {
    switch (item.kind) {
        case 'block': {
            const id = item.blockKey;
            if (!room) return { name: id, id, title: id };
            const parsed = parseKey(id);
            const def = parsed ? registry.blockRegistry.defs.find((d) => d.id === parsed.blockId) : undefined;
            const name = def?.name ?? id;
            return { name, id, title: name === id ? id : `${name} (${id})` };
        }
        case 'prefab': {
            const id = item.prefabId;
            if (!room) return { name: id, id, title: id };
            const def = registry.prefabs.byId.get(id)?.payload;
            const name = def?.name ?? id;
            return { name, id, title: name === id ? id : `${name} (${id})` };
        }
        case 'blueprint': {
            const id = item.sceneId;
            // strip the `blueprints/` prefix for display — the folder is
            // implied by the inventory tab.
            const short = id.startsWith(BLUEPRINT_PREFIX) ? id.slice(BLUEPRINT_PREFIX.length) : id;
            return { name: short, id: short, title: short };
        }
        default:
            return { name: 'unknown', id: 'unknown', title: 'unknown inventory item kind' };
    }
}

/**
 * build an inventory catalog from the room's runtime registries.
 * one item per block (default state) + one per prefab. ordered: blocks first,
 * then prefabs, both alphabetical by id.
 */
export function buildCatalog(_room: ClientRoom, sceneList: string[]): InventoryItem[] {
    const items: InventoryItem[] = [];
    const blocks = [...registry.blockRegistry.defs].sort((a, b) => a.id.localeCompare(b.id));
    for (const def of blocks) {
        items.push({ kind: 'block', blockKey: formatKey(def.id, def.states, def.defaultLocalIdx ?? 0) });
    }
    const prefabIds = [...registry.prefabs.byId.keys()].sort();
    for (const id of prefabIds) {
        items.push({ kind: 'prefab', prefabId: id });
    }
    const blueprintIds = sceneList
        .filter((id) => id.startsWith(BLUEPRINT_PREFIX))
        .sort();
    for (const id of blueprintIds) {
        items.push({ kind: 'blueprint', sceneId: id });
    }
    return items;
}
