import { snap } from './dom';

export type ScrubOptions = {
    get: () => number;
    set: (value: number, finished: boolean) => void;
    step?: number;
    min?: number;
    max?: number;
};

/**
 * attach horizontal drag-to-scrub to a number field (blender / after-effects
 * style). value changes by ~1 step per pixel; shift = ×5, alt = ×0.2. a click
 * without dragging focuses the field for typing instead.
 */
export function scrub(input: HTMLInputElement, opts: ScrubOptions): () => void {
    const down = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (document.activeElement === input) return; // already typing — leave the caret alone
        e.preventDefault();
        const step = opts.step && opts.step > 0 ? opts.step : 1;
        let raw = opts.get();
        let total = 0;
        let moved = false;

        const move = (ev: PointerEvent) => {
            const dx = ev.movementX || 0;
            total += dx;
            if (!moved && Math.abs(total) < 3) return;
            moved = true;
            const speed = ev.shiftKey ? 5 : ev.altKey ? 0.2 : 1;
            raw += dx * step * speed;
            let v = snap(raw, step);
            if (opts.min !== undefined) v = Math.max(opts.min, v);
            if (opts.max !== undefined) v = Math.min(opts.max, v);
            opts.set(v, false);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            document.body.style.cursor = '';
            if (moved) opts.set(opts.get(), true);
            else {
                input.focus();
                input.select();
            }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        document.body.style.cursor = 'ew-resize';
    };

    input.addEventListener('pointerdown', down);
    input.classList.add('dc-scrub');
    return () => input.removeEventListener('pointerdown', down);
}
