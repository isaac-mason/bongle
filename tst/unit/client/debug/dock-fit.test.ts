// @vitest-environment happy-dom
// a floating panel always fits below its own top edge: its max height is the
// room between its top and the layer's bottom, re-fitted on drag, so a tall
// tab scrolls inside the viewport instead of running off the bottom.

import { beforeAll, describe, expect, it } from 'vitest';
import { dashboard } from '../../../../src/client/debug';

beforeAll(() => {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

/** happy-dom lays nothing out, so give the panel a rect that follows its inline style. */
function measure(root: HTMLElement, width: number, height: number): void {
    root.getBoundingClientRect = () =>
        new DOMRect(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0, width, height);
}

describe('panel fit', () => {
    it('caps a tall panel to the room below its top, keeping the top it asked for', () => {
        Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
        const dash = dashboard({ clock: 'manual' });
        const panel = dash.panel({ title: 't', position: [64, 64] });
        measure(panel.root, 320, 900);
        panel.show();
        expect(panel.root.style.top).toBe('64px');
        expect(panel.root.style.maxHeight).toBe(`${600 - 64 - 4}px`);
        dash.destroy();
    });

    it('re-fits after a drag so the cap follows the new top', () => {
        Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
        const dash = dashboard({ clock: 'manual' });
        const panel = dash.panel({ title: 't', position: [64, 64] });
        measure(panel.root, 320, 300);
        const title = panel.root.querySelector('.dc-panel-title') as HTMLElement;
        title.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 70, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 470, bubbles: true }));
        expect(panel.root.style.top).toBe('464px');
        expect(panel.root.style.maxHeight).toBe(`${600 - 464 - 4}px`);
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        // the panel is 300 tall and only 132 fits: the cap holds and the
        // final fit keeps the top rather than dragging it back up
        expect(panel.root.style.top).toBe('464px');
        expect(panel.root.style.maxHeight).toBe('132px');
        dash.destroy();
    });
});
