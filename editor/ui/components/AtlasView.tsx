// editor/ui/components/AtlasView.tsx — shows the baked voxels atlas, re-reading
// the fs whenever a bake completes (the `bake` signal bumps).

import { useEffect, useState } from 'react';
import type { Filesystem } from '../../fs';
import { usePipeline } from '../../stores/pipeline';
import { useObjectUrl } from '../hooks/useObjectUrl';

const ATLAS_PATH = 'resources/client/voxels-atlas.png';

export function AtlasView({ fs }: { fs: Filesystem }) {
    const bake = usePipeline((s) => s.bakeVersion);
    const [bytes, setBytes] = useState<Uint8Array | null>(null);
    const url = useObjectUrl(bytes, 'image/png');

    // biome-ignore lint/correctness/useExhaustiveDependencies: bake is the re-read trigger, not a read value.
    useEffect(() => {
        let alive = true;
        void (async () => {
            if (!(await fs.exists(ATLAS_PATH))) {
                if (alive) setBytes(null);
                return;
            }
            const data = await fs.read(ATLAS_PATH);
            if (alive) setBytes(data);
        })();
        return () => {
            alive = false;
        };
    }, [fs, bake]);

    return (
        <div style={{ padding: 10 }}>
            {url ? (
                <img
                    src={url}
                    alt="voxels atlas"
                    style={{
                        border: '1px solid #000',
                        imageRendering: 'pixelated',
                        width: 256,
                        height: 256,
                        background: 'repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px',
                    }}
                />
            ) : (
                <span style={{ color: '#888' }}>(not baked yet)</span>
            )}
        </div>
    );
}
