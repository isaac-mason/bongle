// editor/ui/components/ImageEditor.tsx — the "paint" app: a tiny pixel-art
// editor. Loads an image into a native-resolution canvas, paints pixels with a
// handful of tools (pencil / eraser / eyedropper / bucket), and saves back to
// the project fs — which live-refreshes the image viewer. Rudimentary by
// design: one canvas is the source of truth, undo is a bounded ImageData stack.

import { Eraser, Grid3x3, type IconComponent, PaintBucket, Pencil, Pipette, Save, Undo2, ZoomIn, ZoomOut } from 'bongle/icons';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useLaunched } from '../../stores/launched';
import { imageMime } from '../image-mime';
import { ColorPicker, TRANSPARENT } from './ColorPicker';

type Tool = 'pencil' | 'eraser' | 'picker' | 'bucket';

const TOOLS: { id: Tool; Icon: IconComponent; title: string }[] = [
    { id: 'pencil', Icon: Pencil, title: 'pencil' },
    { id: 'eraser', Icon: Eraser, title: 'eraser' },
    { id: 'picker', Icon: Pipette, title: 'eyedropper' },
    { id: 'bucket', Icon: PaintBucket, title: 'fill' },
];

export function ImageEditor({ fs, path, windowId }: { fs: Filesystem; path: string; windowId: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    const [scale, setScale] = useState(16);
    const [tool, setTool] = useState<Tool>('pencil');
    const [color, setColor] = useState('#000000');
    const [grid, setGrid] = useState(true);
    const [dirty, setDirty] = useState(false);
    const painting = useRef(false);
    const undo = useRef<ImageData[]>([]);

    // load the image (or a blank 16×16) into the canvas at native resolution.
    useEffect(() => {
        let alive = true;
        void (async () => {
            let w = 16;
            let h = 16;
            let bmp: ImageBitmap | null = null;
            try {
                const data = await fs.read(path);
                bmp = await createImageBitmap(new Blob([data as BlobPart], { type: imageMime(path) }));
                w = bmp.width;
                h = bmp.height;
            } catch {
                /* new / blank file — start from an empty 16×16. */
            }
            if (!alive) {
                bmp?.close();
                return;
            }
            const c = canvasRef.current;
            const ctx = c?.getContext('2d') ?? null;
            if (c && ctx) {
                c.width = w;
                c.height = h;
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, w, h);
                if (bmp) ctx.drawImage(bmp, 0, 0);
            }
            bmp?.close();
            undo.current = [];
            setSize({ w, h });
            setScale(Math.max(1, Math.min(24, Math.floor(384 / Math.max(w, h)))));
        })();
        return () => {
            alive = false;
        };
    }, [fs, path]);

    // ⌘/ctrl + wheel (and trackpad pinch, which the browser reports as
    // ctrl+wheel) zooms; a plain wheel scrolls/pans the stage as normal. Native
    // listener so preventDefault sticks (React's onWheel is passive).
    useEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls
            e.preventDefault();
            setScale((s) => {
                const next = e.deltaY < 0 ? Math.ceil(s * 1.2) : Math.floor(s / 1.2);
                return Math.max(1, Math.min(64, next === s ? s + (e.deltaY < 0 ? 1 : -1) : next));
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // publish unsaved state to the window chrome (title-bar dot).
    useEffect(() => {
        useLaunched.getState().setDirty(windowId, dirty);
    }, [dirty, windowId]);

    const ctxOf = () => canvasRef.current?.getContext('2d') ?? null;

    const pixelAt = (e: ReactPointerEvent): { x: number; y: number } | null => {
        const c = canvasRef.current;
        if (!c || !size) return null;
        const r = c.getBoundingClientRect();
        const x = Math.floor(((e.clientX - r.left) / r.width) * size.w);
        const y = Math.floor(((e.clientY - r.top) / r.height) * size.h);
        if (x < 0 || y < 0 || x >= size.w || y >= size.h) return null;
        return { x, y };
    };

    const snapshot = () => {
        const ctx = ctxOf();
        if (!ctx || !size) return;
        undo.current.push(ctx.getImageData(0, 0, size.w, size.h));
        if (undo.current.length > 50) undo.current.shift();
    };

    const paint = (x: number, y: number) => {
        const ctx = ctxOf();
        if (!ctx) return;
        // clear first so alpha replaces rather than blends over the old pixel.
        ctx.clearRect(x, y, 1, 1);
        if (tool !== 'eraser') {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, 1, 1);
        }
        setDirty(true);
    };

    const pickColor = (x: number, y: number) => {
        const ctx = ctxOf();
        if (!ctx) return;
        const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
        setColor(a === 0 ? TRANSPARENT : `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
        setTool('pencil');
    };

    const bucketFill = (sx: number, sy: number) => {
        const ctx = ctxOf();
        if (!ctx || !size) return;
        const img = ctx.getImageData(0, 0, size.w, size.h);
        const d = img.data;
        const idx = (x: number, y: number) => (y * size.w + x) * 4;
        const start = idx(sx, sy);
        const t0 = d[start];
        const t1 = d[start + 1];
        const t2 = d[start + 2];
        const t3 = d[start + 3];
        const [f0, f1, f2, f3] = hexToRgba(color);
        if (t0 === f0 && t1 === f1 && t2 === f2 && t3 === f3) return;
        const stack: [number, number][] = [[sx, sy]];
        while (stack.length) {
            const cell = stack.pop();
            if (!cell) break;
            const [x, y] = cell;
            if (x < 0 || y < 0 || x >= size.w || y >= size.h) continue;
            const i = idx(x, y);
            if (d[i] !== t0 || d[i + 1] !== t1 || d[i + 2] !== t2 || d[i + 3] !== t3) continue;
            d[i] = f0;
            d[i + 1] = f1;
            d[i + 2] = f2;
            d[i + 3] = f3;
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        ctx.putImageData(img, 0, 0);
        setDirty(true);
    };

    const onDown = (e: ReactPointerEvent) => {
        const p = pixelAt(e);
        if (!p) return;
        rootRef.current?.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        if (tool === 'picker') {
            pickColor(p.x, p.y);
            return;
        }
        snapshot();
        if (tool === 'bucket') {
            bucketFill(p.x, p.y);
            return;
        }
        painting.current = true;
        paint(p.x, p.y);
    };

    const onMove = (e: ReactPointerEvent) => {
        if (!painting.current) return;
        const p = pixelAt(e);
        if (p) paint(p.x, p.y);
    };

    const doUndo = () => {
        const ctx = ctxOf();
        const prev = undo.current.pop();
        if (ctx && prev) {
            ctx.putImageData(prev, 0, 0);
            setDirty(true);
        }
    };

    const save = () => {
        const c = canvasRef.current;
        if (!c) return;
        const mime = imageMime(path);
        c.toBlob(
            (blob) => {
                if (!blob) return;
                void blob
                    .arrayBuffer()
                    .then((buf) => fs.write(path, new Uint8Array(buf)))
                    .then(() => setDirty(false));
            },
            mime === 'application/octet-stream' ? 'image/png' : mime,
        );
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === 's') {
            e.preventDefault();
            save();
        } else if (e.key === 'z') {
            e.preventDefault();
            doUndo();
        }
    };

    const dispW = size ? size.w * scale : 0;
    const dispH = size ? size.h * scale : 0;

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: focusable canvas surface owning the paint shortcuts.
        <div
            ref={rootRef}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: must be focusable to receive ⌘/ctrl+Z / +S.
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="flex h-full flex-col outline-none"
        >
            <div className={toolbarClass}>
                {TOOLS.map((t) => (
                    <button key={t.id} type="button" title={t.title} className={btn(tool === t.id)} onClick={() => setTool(t.id)}>
                        <t.Icon size={15} />
                    </button>
                ))}
                <span className="flex-1" />
                <button type="button" title="undo (⌘/ctrl+Z)" className={btn(false)} onClick={doUndo}>
                    <Undo2 size={15} />
                </button>
            </div>

            <div className={toolbarClass}>
                <button type="button" title="zoom out" className={btn(false)} onClick={() => setScale((v) => Math.max(1, v - 2))}>
                    <ZoomOut size={15} />
                </button>
                <span className="min-w-[30px] text-center text-fg-muted">{scale}×</span>
                <button type="button" title="zoom in" className={btn(false)} onClick={() => setScale((v) => Math.min(64, v + 2))}>
                    <ZoomIn size={15} />
                </button>
                <button type="button" title="toggle grid" className={btn(grid)} onClick={() => setGrid((g) => !g)}>
                    <Grid3x3 size={15} />
                </button>
                <span className="flex-1" />
                <span className="text-fg-muted">{size ? `${size.w}×${size.h}` : ''}</span>
                <button type="button" title="save (⌘/ctrl+S)" className={btn(false)} onClick={save}>
                    <Save size={15} />
                </button>
            </div>

            <div className="flex min-h-0 flex-1">
                <div className="w-[200px] shrink-0 overflow-auto border-r border-border bg-surface">
                    <ColorPicker value={color} onChange={setColor} />
                </div>
                <div ref={stageRef} className="grid min-h-0 flex-1 place-items-center overflow-auto bg-desktop p-4">
                    <div className="relative shadow-[0_0_0_1px_var(--color-border)]" style={{ width: dispW, height: dispH }}>
                        <div className="absolute inset-0" style={{ background: CHECKER }} />
                        <canvas
                            ref={canvasRef}
                            onPointerDown={onDown}
                            onPointerMove={onMove}
                            onPointerUp={() => {
                                painting.current = false;
                            }}
                            className="absolute inset-0 h-full w-full cursor-crosshair touch-none [image-rendering:pixelated]"
                        />
                        {grid && scale >= 6 && (
                            // pixel grid overlay; light hairlines read on the dark canvas.
                            <div
                                className="pointer-events-none absolute inset-0"
                                style={{
                                    backgroundSize: `${scale}px ${scale}px`,
                                    backgroundImage:
                                        'linear-gradient(to right, rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.12) 1px, transparent 1px)',
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function hexToRgba(hex: string): [number, number, number, number] {
    const h = hex.replace('#', '');
    const n = (s: string) => Number.parseInt(s, 16);
    if (h.length >= 8) return [n(h.slice(0, 2)), n(h.slice(2, 4)), n(h.slice(4, 6)), n(h.slice(6, 8))];
    return [n(h.slice(0, 2)), n(h.slice(2, 4)), n(h.slice(4, 6)), 255];
}

// transparency checkerboard, tinted to the dark surface.
const CHECKER = 'repeating-conic-gradient(#2a2e35 0% 25%, #202329 0% 50%) 50% / 16px 16px';

const toolbarClass = 'flex shrink-0 flex-wrap items-center gap-[5px] border-b border-border px-1.5 py-1 font-mono text-xs';

function btn(active: boolean): string {
    return `grid h-[24px] min-w-[26px] cursor-pointer place-items-center border border-border px-[5px] font-mono text-xs ${
        active ? 'bg-accent text-on-accent' : 'bg-surface text-fg'
    }`;
}
