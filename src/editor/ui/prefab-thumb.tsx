import { useEffect } from 'react';
import { useEditor } from '../editor-store';
import { ensurePrefabIcon } from '../icons';

// triggers the icon render on first use and again after a registry-change invalidation.
export function usePrefabIcon(prefabId: string): string | undefined {
    const url = useEditor((s) => s.prefabIconUrls[prefabId]);
    useEffect(() => {
        void ensurePrefabIcon(prefabId);
    }, [prefabId, url]);
    return url;
}

// renders a neutral placeholder box until the in-browser icon is ready.
export function PrefabThumb({ prefabId, size, className }: { prefabId: string; size: number; className?: string }) {
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
