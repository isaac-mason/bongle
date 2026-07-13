// Shared prefab-icon UI: a hook + a thumbnail box. Prefab icons are rendered
// in-browser on demand (see editor `ensurePrefabIcon`) and cached in the editor
// store; both the hook and the box trigger a render on first use and re-render
// after a registry-change invalidation clears the cache.

import { useEffect } from 'react';
import { useEditor } from '../editor-store';
import { ensurePrefabIcon } from '../index';

/** Object URL for `prefabId`'s in-browser icon, or undefined until it lands.
 *  Triggers the render on first use and after invalidation. */
export function usePrefabIcon(prefabId: string): string | undefined {
    const url = useEditor((s) => s.prefabIconUrls[prefabId]);
    useEffect(() => {
        void ensurePrefabIcon(prefabId);
    }, [prefabId, url]);
    return url;
}

/** A `size`×`size` prefab thumbnail. Renders the in-browser icon once ready,
 *  a neutral placeholder box until then. `className` styles the box (rounding). */
export function PrefabThumb({
    prefabId,
    size,
    className,
}: {
    prefabId: string;
    size: number;
    className?: string;
}) {
    const url = usePrefabIcon(prefabId);
    return (
        <div
            className={className}
            style={{
                width: size,
                height: size,
                backgroundImage: url ? `url(${url})` : undefined,
                // neutral-200 placeholder until the render lands.
                backgroundColor: url ? undefined : '#e5e5e5',
                backgroundSize: `${size}px ${size}px`,
                backgroundRepeat: 'no-repeat',
                imageRendering: 'auto',
            }}
        />
    );
}
