/**
 * shared icon renderer for blocks and prefabs in the inventory + hotbar.
 *
 * pulls atlas data from the editor store. falls back to a placeholder square
 * when the icon hasn't been generated yet (e.g. boot in progress) or the
 * coords map doesn't include the requested key.
 */

import { memo } from 'react';
import { assetUrl } from '../../render/asset-url';
import { useEditor } from '../editor-store';
import type { InventoryItem } from '../inventory';

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
            // per-prefab PNG written by the asset-pipeline prefab-icon task.
            // missing-file (cold start, hash gate) renders as a broken img;
            // ok for now — the placeholder fallback only fires when the
            // prefabId itself is empty.
            if (!item.prefabId) return <Placeholder size={size} />;
            return (
                <div
                    style={{
                        width: size,
                        height: size,
                        backgroundImage: `url(${assetUrl(`prefabs/${item.prefabId}.icon.png`)})`,
                        backgroundSize: `${size}px ${size}px`,
                        backgroundRepeat: 'no-repeat',
                        imageRendering: 'auto',
                    }}
                />
            );
        }
        case 'blueprint': {
            // per-scene PNG written by the asset-pipeline scene-icon task.
            // missing-file (cold start, hash gate) renders as a broken img;
            // ok for now — the placeholder fallback only fires when the
            // sceneId itself is empty.
            if (!item.sceneId) return <Placeholder size={size} />;
            return (
                <div
                    style={{
                        width: size,
                        height: size,
                        backgroundImage: `url(${assetUrl(`scenes/${item.sceneId}.icon.png`)})`,
                        backgroundSize: `${size}px ${size}px`,
                        backgroundRepeat: 'no-repeat',
                        imageRendering: 'auto',
                    }}
                />
            );
        }
        default:
            return <Placeholder size={size} />;
    }
});

function Placeholder({ size }: { size: number }) {
    return <div style={{ width: size, height: size }} className="bg-neutral-200 rounded" />;
}
