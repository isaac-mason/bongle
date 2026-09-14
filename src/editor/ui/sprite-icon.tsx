import { useEffect } from 'react';
import { useEditor } from '../editor-store';
import { ensureSpriteAtlasUrl } from '../icons';

/** draws the first frame of a kit sprite from the baked atlas; an empty box until the atlas is published. */
export function SpriteIcon({ id, size = 12, className }: { id: string; size?: number; className?: string }) {
    const atlasUrl = useEditor((s) => s.spriteAtlasUrl);
    const atlasHash = useEditor((s) => s.spriteAtlasHash);
    const meta = useEditor((s) => s.resources?.spriteAtlas ?? null);
    useEffect(() => {
        ensureSpriteAtlasUrl();
    });
    const frame = meta && meta.hash === atlasHash ? meta.sprites[id]?.frames[0] : undefined;
    if (!atlasUrl || !meta || !frame) {
        return <span className={`inline-block shrink-0 ${className ?? ''}`} style={{ width: size, height: size }} />;
    }
    const scale = size / frame.w;
    return (
        <span
            className={`inline-block shrink-0 ${className ?? ''}`}
            title={id}
            style={{
                width: frame.w * scale,
                height: frame.h * scale,
                backgroundImage: `url(${atlasUrl})`,
                backgroundPosition: `-${frame.x * scale}px -${frame.y * scale}px`,
                backgroundSize: `${meta.atlasSize * scale}px ${meta.atlasSize * scale}px`,
                imageRendering: 'pixelated',
            }}
        />
    );
}
