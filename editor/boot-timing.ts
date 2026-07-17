// editor/boot-timing.ts — lightweight, shared boot instrumentation.
//
// The editor boots as a serial chain (main doc: opfs → seed → bundler → bake →
// server → client; each realm worker: opfs → engine graph import → subsystem
// boot). Every phase was already breadcrumbed with `[boot]` console logs but
// had no timing. A boot timer fixes that: each mark
//   • prints "[boot:<ctx>] <label>  +<delta>ms  (<total>ms)" to the console,
//   • emits a performance.measure for the interval since the previous mark — so
//     the DevTools Performance panel shows a cross-thread flame timeline (each
//     worker's User Timing entries land under their own thread) with no plumbing,
//   • is retained so summary() can print a console.table sorted by cost.
//
// Deltas are per-context (each thread times against its own performance clock),
// which answers "which phase dominates" within a context. To line phases up
// ACROSS threads, use the DevTools timeline — the measures share the same
// absolute time base there.

type Mark = { label: string; at: number };

export type BootTimer = {
    /** record a phase boundary; returns the "+<delta>ms" string for UI reuse. */
    mark: (label: string) => string;
    /** print a console.table of phases sorted by duration (call once, at ready). */
    summary: () => void;
};

export function createBootTimer(ctx: string): BootTimer {
    // 'start' ≈ this module's eval time in its context (imported early in each).
    const marks: Mark[] = [{ label: 'start', at: performance.now() }];

    const mark = (label: string): string => {
        const at = performance.now();
        const prev = marks[marks.length - 1];
        const deltaMs = at - prev.at;
        marks.push({ label, at });
        try {
            performance.measure(`boot:${ctx} ${prev.label} → ${label}`, { start: prev.at, end: at });
        } catch {}
        const delta = `+${deltaMs.toFixed(0)}ms`;
        console.log(`[boot:${ctx}] ${label}  ${delta}  (${(at - marks[0].at).toFixed(0)}ms)`);
        return delta;
    };

    const summary = (): void => {
        if (marks.length < 2) return;
        const rows = marks.slice(1).map((m, i) => ({ phase: `${marks[i].label} → ${m.label}`, ms: +(m.at - marks[i].at).toFixed(1) }));
        const total = marks[marks.length - 1].at - marks[0].at;
        console.log(`[boot:${ctx}] total ${total.toFixed(0)}ms — phases by duration:`);
        console.table([...rows].sort((a, b) => b.ms - a.ms));
    };

    return { mark, summary };
}
