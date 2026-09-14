// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';

import { dashboard, hashColor } from '../../../../src/client/debug';

// jsdom has no canvas 2d context, ResizeObserver, or IntersectionObserver — stub them.
// the IntersectionObserver never fires, so widgets stay "on-screen" and actually paint.
beforeAll(() => {
    const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });
    HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    globalThis.IntersectionObserver = class {
        root = null;
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
            return [];
        }
    } as unknown as typeof IntersectionObserver;
});

describe('watch widgets', () => {
    it('mounts every widget (with the full option surface) and survives ticks', () => {
        const dash = dashboard({ clock: 'manual' });
        const p = dash.panel({ title: 't' });
        const nums = { a: 1, b: 2 };
        const frame = {
            count: 3,
            duration: 16,
            key: [0, 1, 2],
            depth: [0, 1, 1],
            start: [0, 1, 6],
            end: [12, 5, 11],
        };

        p.graph(() => nums.a, { hover: true, baseline: 1.5, smooth: 0.3, thresholds: [{ at: 0, color: 'ok' }] });
        p.lines(() => nums, { stacked: true, baseline: 2, hover: true, height: 80 });
        p.lines(() => nums, { legend: true });
        p.bars(() => nums, { limit: 1, sort: true, thresholds: [{ at: 0, color: 'ok' }] });
        p.stat(() => nums.a, {
            spark: true,
            delta: true,
            stats: ['min', 'avg', 'max'],
            smooth: 0.2,
            thresholds: [{ at: 0, color: 'ok' }],
        });
        p.histogram(() => nums.a, { percentiles: [50, 95], hover: true, range: [0, 10] });
        p.gauge(() => nums.a, {
            zones: true,
            stats: ['avg', 'max'],
            min: 0,
            max: 10,
            thresholds: [
                { at: 0, color: 'ok' },
                { at: 5, color: 'danger' },
            ],
        });
        p.states(() => (nums.a > 1 ? 'hi' : 'lo'), { legend: true });
        // history-fed chart + flame: both read a caller-owned snapshot, so they are
        // driven here with the shapes a profiler ring hands them.
        p.series(() => ({ a: [1, 2, 3, 4], b: [4, 3, 2, 1] }), {
            stacked: true,
            baseline: 3,
            hover: true,
            height: 80,
            color: (key) => hashColor(key),
        });
        p.series(() => ({}), { label: 'empty' });
        p.flame(() => frame, { height: 60, name: (id) => `scope-${id}` });
        p.flame(() => null, { label: 'no capture' });

        const tiles = p.tiles('hud', { columns: 2 });
        tiles.gauge(() => nums.a, { min: 0, max: 10 });
        tiles.stat(() => nums.b, { span: 2 });

        // tabs() layout region: inactive tab detached, active shown
        const tabs = p.tabs();
        tabs.tab('one').graph(() => nums.a);
        tabs.tab('two').bars(() => nums);
        tabs.active('one');

        expect(() => {
            for (let i = 0; i < 5; i++) {
                nums.a = i;
                nums.b = i * 2;
                dash.update(i * 16);
            }
        }).not.toThrow();

        dash.destroy();
    });

    it('mounts only the active tab body, and hides/shows/closes panels', () => {
        const dash = dashboard({ clock: 'manual' });
        const p = dash.panel({ title: 'p', resizable: true });
        const t = p.tabs();
        t.tab('a').add({ x: 1 }, 'x');
        t.tab('b').add({ y: 2 }, 'y');
        const holder = p.root.querySelector('.dc-tabs-content')!;
        expect(holder.childElementCount).toBe(1); // only the active tab's body is mounted
        t.active('b');
        expect(holder.childElementCount).toBe(1);

        expect(dash.panels).toContain(p);
        p.hide();
        expect(dash.hidden).toContain(p);
        expect(dash.root.contains(p.root)).toBe(false);
        p.show();
        expect(dash.hidden).not.toContain(p);
        expect(dash.root.contains(p.root)).toBe(true);

        const tmp = dash.panel();
        const n = dash.panels.length;
        tmp.close();
        expect(dash.panels.length).toBe(n - 1);
        dash.destroy();
    });

    it('survives the very first paint on a zero-size canvas (gauge arc guard)', () => {
        const dash = dashboard({ clock: 'manual' });
        const p = dash.panel();
        p.gauge(() => 50, { min: 0, max: 100 });
        expect(() => dash.update()).not.toThrow();
        dash.destroy();
    });

    it('reset() clears a widget without throwing', () => {
        const dash = dashboard({ clock: 'manual' });
        const p = dash.panel();
        const h = p.graph(() => 1);
        dash.update();
        expect(() => h.reset()).not.toThrow();
        dash.destroy();
    });
});
