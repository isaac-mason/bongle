/**
 * shared icon renderer for blocks and prefabs in the inventory + hotbar.
 *
 * pulls atlas data from the editor store. falls back to a placeholder square
 * when the icon hasn't been generated yet (e.g. boot in progress) or the
 * coords map doesn't include the requested key.
 */

import { memo } from 'react';
import { useEditor } from '../editor-store';
import type { InventoryItem } from '../inventory';
import { PrefabThumb } from './prefab-thumb';

type Props = {
    item: InventoryItem;
    size: number;
};

export const InventoryItemIcon = memo(function InventoryItemIcon({ item, size }: Props) {
    const blockAtlasUrl = useEditor((s) => s.blockIconAtlasUrl);
    const blockCoords = useEditor((s) => s.blockIconCoords);
    const blockCols = useEditor((s) => s.blockIconCols);
    const blockRows = useEditor((s) => s.blockIconRows);

    switch (item.kind) {
        case 'block': {
            if (!blockAtlasUrl || !blockCols || !blockRows) return <Placeholder size={size} />;
            const coord = blockCoords[item.blockKey];
            if (!coord) return <Placeholder size={size} />;
            const [col, row] = coord;
            return (
                <div
                    style={{
                        width: size,
                        height: size,
                        backgroundImage: `url(${blockAtlasUrl})`,
                        backgroundSize: `${blockCols * size}px ${blockRows * size}px`,
                        backgroundPosition: `-${col * size}px -${row * size}px`,
                        backgroundRepeat: 'no-repeat',
                        imageRendering: 'auto',
                    }}
                />
            );
        }
        case 'prefab': {
            // rendered in-browser on demand (see PrefabThumb / ensurePrefabIcon).
            if (!item.prefabId) return <Placeholder size={size} />;
            return <PrefabThumb prefabId={item.prefabId} size={size} />;
        }
        case 'blueprint': {
            // scene (blueprint) icons are not rendered — placeholder only.
            return <Placeholder size={size} />;
        }
        default:
            return <Placeholder size={size} />;
    }
});

function Placeholder({ size }: { size: number }) {
    return <div style={{ width: size, height: size }} className="bg-neutral-200 rounded" />;
}
