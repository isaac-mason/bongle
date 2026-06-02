// dom-ui example — showcases the variants of the two UI traits:
// HtmlTrait, CanvasTrait.
//
// Editor-only: a single persistent runner trait on the scene root spawns
// a grid of transient panels via `{ editor: true }` so they appear
// straight in the scene editor preview. Each spawned node is
// `persist: false` (transient — never baked into the .nodes.json).
//
// Layout (spread across ~20 world units wide):
//   row y=6 — HtmlTrait    (screen / screen+distance / billboard / world / y-billboard / interactive)
//   row y=0 — CanvasTrait  (billboard-animated / world-static / procedural-noise)

import {
    addChild,
    addTrait,
    CanvasTrait,
    createNode,
    env,
    HtmlTrait,
    matchmaking,
    onDispose,
    onFrame,
    onInit,
    scene,
    script,
    setPosition,
    TransformTrait,
    trait,
    use,
    type ScriptContext,
} from 'bongle';
import { blocks } from 'bongle/starter';

matchmaking({ maxPlayers: 1 });
scene('main');

// scene's voxel palette references `starter:stone` — `use()` keeps the
// declaration in the bundle so the registration fires at module-eval.
use(blocks.stone);

// ── runner ──────────────────────────────────────────────────────────

const DomUiDemoTrait = trait('dom-ui-demo', {}, { persist: true });

script(
    DomUiDemoTrait,
    'demo',
    (ctx) => {
        if (!env.client) return;
        if (ctx.mode !== 'edit') return;

        const teardown: Array<() => void> = [];

        onInit(ctx, () => {
            // HtmlTrait row
            spawnHtmlScreen(ctx, teardown);
            spawnHtmlScreenDistance(ctx, teardown);
            spawnHtmlBillboard(ctx, teardown);
            spawnHtmlWorld(ctx, teardown);
            spawnHtmlYBillboard(ctx, teardown);
            spawnHtmlInteractive(ctx, teardown);

            // CanvasTrait row
            spawnCanvasBillboard(ctx, teardown);
            spawnCanvasWorld(ctx, teardown);
            spawnCanvasNoise(ctx, teardown);
        });

        onDispose(ctx, () => {
            for (const t of teardown.splice(0)) t();
        });
    },
    { editor: true },
);

// ── shared styling helpers ──────────────────────────────────────────

const PANEL_BORDER = '2px solid #000';
const PANEL_FONT = 'ui-monospace, monospace';

function panelHtml(title: string, subtitle: string, accent = '#fff'): string {
    return `
        <div style="
            background: ${accent};
            border: ${PANEL_BORDER};
            padding: 8px 12px;
            font-family: ${PANEL_FONT};
            font-size: 12px;
            line-height: 1.4;
            white-space: nowrap;
            box-shadow: 4px 4px 0 #000;
        ">
            <div style="font-weight:700;">${title}</div>
            <div style="opacity:0.7;">${subtitle}</div>
        </div>
    `;
}

// ── HtmlTrait demos ─────────────────────────────────────────────────
// `screen`-mode anchors to projected position; size is constant CSS
// pixels (or scaled by distanceFactor). World/billboard/y-billboard use
// 3D matrix3d transforms and scale by `worldScale`.

function spawnHtmlScreen(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'html-screen', persist: false });
    setPosition(addTrait(node, TransformTrait), [-10, 6, 0]);
    const html = addTrait(node, HtmlTrait, { mode: 'screen', center: true, pointerEvents: false });
    addChild(ctx.node, node);
    html.element!.innerHTML = panelHtml('HtmlTrait', 'screen · constant size');
    teardown.push(() => { html.element!.innerHTML = ''; });
}

function spawnHtmlScreenDistance(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'html-screen-distance', persist: false });
    setPosition(addTrait(node, TransformTrait), [-6, 6, 0]);
    const html = addTrait(node, HtmlTrait, {
        mode: 'screen',
        center: true,
        pointerEvents: false,
        distanceFactor: 8,
    });
    addChild(ctx.node, node);
    html.element!.innerHTML = panelHtml('HtmlTrait', 'screen · distanceFactor=8', '#ffe');
    teardown.push(() => { html.element!.innerHTML = ''; });
}

function spawnHtmlBillboard(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'html-billboard', persist: false });
    setPosition(addTrait(node, TransformTrait), [-2, 6, 0]);
    const html = addTrait(node, HtmlTrait, {
        mode: 'billboard',
        center: true,
        pointerEvents: false,
        worldScale: 1 / 220,
    });
    addChild(ctx.node, node);
    html.element!.innerHTML = panelHtml('HtmlTrait', 'billboard · faces camera', '#eef');
    teardown.push(() => { html.element!.innerHTML = ''; });
}

function spawnHtmlWorld(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'html-world', persist: false });
    setPosition(addTrait(node, TransformTrait), [2, 6, 0]);
    const html = addTrait(node, HtmlTrait, {
        mode: 'world',
        center: true,
        pointerEvents: false,
        worldScale: 1 / 220,
    });
    addChild(ctx.node, node);
    html.element!.innerHTML = panelHtml('HtmlTrait', 'world · 3D rotation', '#efe');
    teardown.push(() => { html.element!.innerHTML = ''; });
}

function spawnHtmlYBillboard(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'html-y-billboard', persist: false });
    setPosition(addTrait(node, TransformTrait), [6, 6, 0]);
    const html = addTrait(node, HtmlTrait, {
        mode: 'y-billboard',
        center: true,
        pointerEvents: false,
        worldScale: 1 / 220,
    });
    addChild(ctx.node, node);
    html.element!.innerHTML = panelHtml('HtmlTrait', 'y-billboard · yaw only', '#fef');
    teardown.push(() => { html.element!.innerHTML = ''; });
}

function spawnHtmlInteractive(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'html-interactive', persist: false });
    setPosition(addTrait(node, TransformTrait), [10, 6, 0]);
    const html = addTrait(node, HtmlTrait, { mode: 'screen', center: true, pointerEvents: true });
    addChild(ctx.node, node);

    const el = html.element!;
    el.innerHTML = `
        <div style="
            background:#fff;
            border:${PANEL_BORDER};
            padding:8px 12px;
            font-family:${PANEL_FONT};
            font-size:12px;
            box-shadow:4px 4px 0 #000;
            text-align:center;
        ">
            <div style="font-weight:700;margin-bottom:4px;">HtmlTrait</div>
            <div style="opacity:0.7;margin-bottom:6px;">interactive · DOM events</div>
            <button data-role="btn" style="
                font-family:${PANEL_FONT};
                font-size:11px;
                background:#000;color:#fff;
                border:${PANEL_BORDER};
                padding:4px 10px;cursor:pointer;
            ">clicks: 0</button>
        </div>
    `;
    const btn = el.querySelector<HTMLButtonElement>('[data-role="btn"]')!;
    let n = 0;
    const onClick = () => { n++; btn.textContent = `clicks: ${n}`; };
    btn.addEventListener('click', onClick);
    teardown.push(() => { btn.removeEventListener('click', onClick); el.innerHTML = ''; });
}

// ── CanvasTrait demos ───────────────────────────────────────────────
// Bring-your-own pixels — paint directly into the OffscreenCanvas. No
// DOM, no rasterization.

function spawnCanvasBillboard(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'canvas-billboard', persist: false });
    setPosition(addTrait(node, TransformTrait), [-5, 0, 0]);
    const panel = addTrait(node, CanvasTrait, {
        width: 256, height: 128, mode: 'billboard', worldScale: 1 / 80,
    });
    addChild(ctx.node, node);

    const offscreen = panel.canvas!;
    const c = offscreen.getContext('2d')!;
    const t0 = performance.now();

    const off = onFrame(ctx, () => {
        const W = offscreen.width;
        const H = offscreen.height;
        const t = (performance.now() - t0) / 1000;

        c.fillStyle = '#fff';
        c.fillRect(0, 0, W, H);
        c.strokeStyle = '#000';
        c.lineWidth = 2;
        c.strokeRect(1, 1, W - 2, H - 2);

        c.fillStyle = '#000';
        c.font = '700 14px ui-monospace, monospace';
        c.fillText('CanvasTrait', 10, 22);
        c.font = '11px ui-monospace, monospace';
        c.fillStyle = '#666';
        c.fillText('billboard · sine wave', 10, 38);

        c.beginPath();
        c.strokeStyle = '#000';
        c.lineWidth = 1.5;
        const midY = H * 0.7;
        const amp = 18;
        for (let x = 0; x < W; x++) {
            const y = midY + Math.sin((x / W) * Math.PI * 4 + t * 2) * amp;
            if (x === 0) c.moveTo(x, y);
            else c.lineTo(x, y);
        }
        c.stroke();

        panel.needsUpdate = true;
    });
    teardown.push(off);
}

function spawnCanvasWorld(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'canvas-world', persist: false });
    setPosition(addTrait(node, TransformTrait), [0, 0, 0]);
    const panel = addTrait(node, CanvasTrait, {
        width: 256, height: 128, mode: 'world', worldScale: 1 / 80,
    });
    addChild(ctx.node, node);

    const offscreen = panel.canvas!;
    const c = offscreen.getContext('2d')!;
    const W = offscreen.width;
    const H = offscreen.height;

    // Static gradient checker, painted once.
    const grad = c.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, '#ddd');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#000';
    c.lineWidth = 2;
    c.strokeRect(1, 1, W - 2, H - 2);
    c.fillStyle = '#000';
    c.font = '700 14px ui-monospace, monospace';
    c.fillText('CanvasTrait', 10, 22);
    c.font = '11px ui-monospace, monospace';
    c.fillStyle = '#666';
    c.fillText('world · static gradient', 10, 38);
    // Tiny checker.
    const cell = 12;
    for (let y = 56; y < H - 8; y += cell) {
        for (let x = 10; x < W - 10; x += cell) {
            if (((x + y) / cell) & 1) {
                c.fillStyle = '#000';
                c.fillRect(x, y, cell, cell);
            }
        }
    }
    panel.needsUpdate = true;
}

function spawnCanvasNoise(ctx: ScriptContext, teardown: Array<() => void>): void {
    const node = createNode({ name: 'canvas-noise', persist: false });
    setPosition(addTrait(node, TransformTrait), [5, 0, 0]);
    const panel = addTrait(node, CanvasTrait, {
        width: 256, height: 128, mode: 'billboard', worldScale: 1 / 80,
    });
    addChild(ctx.node, node);

    const offscreen = panel.canvas!;
    const c = offscreen.getContext('2d')!;
    const W = offscreen.width;
    const H = offscreen.height;
    const img = c.createImageData(W, H);
    let frame = 0;

    const off = onFrame(ctx, () => {
        // Throttle — rewriting 256×128 RGBA each frame is cheap but the
        // texture upload isn't free.
        frame++;
        if (frame % 4 !== 0) return;
        const data = img.data;
        const seed = frame * 13;
        for (let i = 0; i < data.length; i += 4) {
            const v = (Math.sin(i * 0.013 + seed) * 127 + 128) | 0;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
        c.putImageData(img, 0, 0);

        c.fillStyle = '#fff';
        c.fillRect(8, 6, 130, 36);
        c.strokeStyle = '#000';
        c.lineWidth = 2;
        c.strokeRect(8, 6, 130, 36);
        c.fillStyle = '#000';
        c.font = '700 14px ui-monospace, monospace';
        c.fillText('CanvasTrait', 14, 22);
        c.font = '11px ui-monospace, monospace';
        c.fillStyle = '#666';
        c.fillText('procedural noise', 14, 36);

        panel.needsUpdate = true;
    });
    teardown.push(off);
}
