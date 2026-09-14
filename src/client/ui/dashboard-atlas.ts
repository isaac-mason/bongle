import type { Texture } from 'gpucat';
import type { RendererAtlases } from '../../render/backend';
import { type Container, el, hashColor, on, type TabGroup } from '../debug';

type Rect = { x: number; y: number; w: number; h: number };

/** `el` with inline css. */
function styled<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string,
    children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
    const node = el(tag, undefined, undefined, children);
    node.style.cssText = css;
    return node;
}
type Labelled = Rect & { label: string };

/** widest an atlas is drawn; the panel is ~460px. */
const DRAW_WIDTH = 420;

/** the CPU pixels behind a Texture level: level 0 is the source, the rest are
 *  the explicit mips. Null when the texture has no CPU data at that level. */
function levelPixels(texture: Texture, level: number): { data: Uint8Array; width: number; height: number } | null {
    const source = level === 0 ? texture.source : texture.mipmaps[level - 1];
    const image = source?.data as { data?: unknown; width?: number; height?: number } | null | undefined;
    if (!image || !(image.data instanceof Uint8Array) || !image.width || !image.height) return null;
    return { data: image.data, width: image.width, height: image.height };
}

/** one atlas view: a caption line, a canvas, and the rects to outline. */
function atlasView(
    container: Container,
    title: string,
    read: () => {
        pixels: { data: Uint8Array; width: number; height: number } | null;
        rects: Labelled[];
        scale: number;
        note: string;
    },
): { repaint: () => void; fingerprint: () => string } {
    const caption = styled('div', 'font: 11px/1.4 monospace; opacity: 0.8; padding: 2px 0;');
    const canvas = styled('canvas', `display:block; width:${DRAW_WIDTH}px; image-rendering: pixelated; background: #111;`);
    const hoverLine = styled('div', 'font: 11px/1.4 monospace; min-height: 1.4em; padding: 2px 0;');
    container.element(
        styled('div', 'padding: 4px 0;', [styled('div', 'font: bold 11px monospace;', [title]), caption, canvas, hoverLine]),
    );

    // native-size scratch: ImageData wants a 1:1 canvas, the display canvas scales it.
    const scratch = document.createElement('canvas');
    let hover: [number, number] | null = null;
    on(canvas, 'pointermove', (e) => {
        const p = e as PointerEvent;
        hover = [p.offsetX, p.offsetY];
        repaint();
    });
    on(canvas, 'pointerleave', () => {
        hover = null;
        repaint();
    });

    const repaint = () => {
        const { pixels, rects, scale, note } = read();
        if (!pixels) {
            caption.textContent = note || 'no atlas';
            canvas.width = DRAW_WIDTH;
            canvas.height = 16;
            hoverLine.textContent = '';
            return;
        }
        const { data, width, height } = pixels;
        caption.textContent = `${width}x${height}, ${rects.length} rects${note ? `, ${note}` : ''}`;
        if (scratch.width !== width || scratch.height !== height) {
            scratch.width = width;
            scratch.height = height;
        }
        const sg = scratch.getContext('2d')!;
        const image = sg.createImageData(width, height);
        image.data.set(data);
        sg.putImageData(image, 0, 0);

        const zoom = DRAW_WIDTH / width;
        const drawH = Math.round(height * zoom);
        if (canvas.width !== DRAW_WIDTH || canvas.height !== drawH) {
            canvas.width = DRAW_WIDTH;
            canvas.height = drawH;
            canvas.style.height = `${drawH}px`;
        }
        const g = canvas.getContext('2d')!;
        g.imageSmoothingEnabled = false;
        g.clearRect(0, 0, canvas.width, canvas.height);
        // checkerboard so transparent texels read as transparent, not as black.
        for (let y = 0; y < canvas.height; y += 8) {
            for (let x = 0; x < canvas.width; x += 8) {
                g.fillStyle = ((x + y) >> 3) % 2 === 0 ? '#2a2a2a' : '#1c1c1c';
                g.fillRect(x, y, 8, 8);
            }
        }
        g.drawImage(scratch, 0, 0, canvas.width, canvas.height);

        // rects at this level's scale, outlined; the hovered one named.
        let hovered: Labelled | null = null;
        g.lineWidth = 1;
        for (const r of rects) {
            const x = r.x * scale * zoom;
            const y = r.y * scale * zoom;
            const w = Math.max(1, r.w * scale * zoom);
            const h = Math.max(1, r.h * scale * zoom);
            const isHover = hover !== null && hover[0] >= x && hover[0] < x + w && hover[1] >= y && hover[1] < y + h;
            if (isHover) hovered = r;
            g.strokeStyle = isHover ? '#fff' : hashColor(r.label, 60);
            g.globalAlpha = isHover ? 1 : 0.6;
            g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }
        g.globalAlpha = 1;
        hoverLine.textContent = hovered
            ? `${hovered.label}  x${hovered.x} y${hovered.y}  ${hovered.w}x${hovered.h}${scale !== 1 ? `  (level rect x${hovered.x * scale} y${hovered.y * scale} ${hovered.w * scale}x${hovered.h * scale})` : ''}`
            : '';
    };

    return {
        repaint,
        fingerprint: () => {
            const { pixels, rects, note } = read();
            return `${pixels ? `${pixels.width}x${pixels.height}:${pixels.data.byteLength}` : 'none'}|${rects.length}|${note}`;
        },
    };
}

/** `atlases` is read every repaint so a swapped atlas (HMR, room change) shows
 *  without wiring; `textureNames` indexes the entries table. */
export function addAtlasTab(tabs: TabGroup, atlases: () => RendererAtlases, textureNames: () => string[]): void {
    const tab = tabs.tab('atlas');

    // entries table holds each texture's rect normalised; scaled back to level-0 texels.
    let level = 0;
    const levelRow = styled('div', 'display:flex; gap: 6px; align-items:center; font: 11px monospace; padding: 2px 0;');
    const levelSelect = styled('select', 'font: 11px monospace;');
    for (let i = 0; i <= 4; i++) levelSelect.append(el('option', undefined, { value: String(i) }, [`level ${i}`]));
    on(levelSelect, 'change', () => {
        level = Number(levelSelect.value);
        blocks.repaint();
    });
    levelRow.append('block atlas mip', levelSelect);
    tab.element(levelRow);

    const blocks = atlasView(tab, 'block atlas', () => {
        const voxel = atlases().voxel;
        if (!voxel) return { pixels: null, rects: [], scale: 1, note: 'no voxel resources' };
        const base = levelPixels(voxel.atlas, 0);
        const pixels = levelPixels(voxel.atlas, level);
        if (!base) return { pixels: null, rects: [], scale: 1, note: 'atlas not loaded' };
        if (!pixels) return { pixels: null, rects: [], scale: 1, note: `level ${level} not shipped (GPU-generated)` };
        const names = textureNames();
        const entries = voxel.entriesBuffer.array as Float32Array | null;
        const rects: Labelled[] = [];
        if (entries) {
            const stride = entries.length / Math.max(1, names.length);
            for (let i = 0; i < names.length && (i + 1) * stride <= entries.length; i++) {
                const o = i * stride;
                rects.push({
                    label: `#${i} ${names[i]!}`,
                    x: Math.round(entries[o]! * base.width),
                    y: Math.round(entries[o + 1]! * base.height),
                    w: Math.round(entries[o + 2]! * base.width),
                    h: Math.round(entries[o + 3]! * base.height),
                });
            }
        }
        // rects are level-0 texels; at level L the atlas is 2^L smaller.
        return { pixels, rects, scale: 1 / (1 << level), note: `hash ${voxel.hash?.slice(0, 8) ?? 'none'}, level ${level}` };
    });

    const sprites = atlasView(tab, 'sprite atlas', () => {
        const sprite = atlases().sprite;
        if (!sprite?.pixels || !sprite.metadata) return { pixels: null, rects: [], scale: 1, note: 'no sprite atlas' };
        const size = sprite.metadata.atlasSize;
        const rects: Labelled[] = [];
        for (const [id, entry] of Object.entries(sprite.metadata.sprites)) {
            for (let i = 0; i < entry.frames.length; i++) {
                rects.push({ label: entry.frames.length > 1 ? `${id}[${i}]` : id, ...entry.frames[i]! });
            }
        }
        return {
            pixels: { data: sprite.pixels, width: size, height: size },
            rects,
            scale: 1,
            note: `hash ${sprite.atlasHash?.slice(0, 8) ?? 'none'}`,
        };
    });

    // an inactive tab is detached from the document, which ends the loop.
    let last = '';
    let running = false;
    const loop = () => {
        if (!levelRow.isConnected) {
            running = false;
            return;
        }
        const now = `${blocks.fingerprint()}|${sprites.fingerprint()}`;
        if (now !== last) {
            last = now;
            blocks.repaint();
            sprites.repaint();
        }
        requestAnimationFrame(loop);
    };
    const start = () => {
        if (running) return;
        running = true;
        last = '';
        requestAnimationFrame(loop);
    };
    tabs.onChange((name) => {
        if (name === 'atlas') start();
    });
    if (levelRow.isConnected) start();
}
