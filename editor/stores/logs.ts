// editor/stores/logs.ts — log streams the log windows render.
//
// A stream per source (build, server, …). The editor wiring appends;
// a LogView subscribes to one stream. Capped so a long session doesn't
// grow unbounded.

import { create } from 'zustand';

// 'build' carries the bundler (transform) errors + the asset-bake pipeline log.
export type LogStream = 'build' | 'server' | 'client';

const MAX_LINES = 500;

type LogStore = {
    lines: Record<LogStream, string[]>;
    appendMany: (stream: LogStream, msgs: string[]) => void;
    clear: (stream: LogStream) => void;
};

export const useLogs = create<LogStore>((set) => ({
    lines: { build: [], server: [], client: [] },
    appendMany: (stream, msgs) =>
        set((s) => {
            if (msgs.length === 0) return s;
            const next = [...s.lines[stream], ...msgs];
            if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
            return { lines: { ...s.lines, [stream]: next } };
        }),
    clear: (stream) => set((s) => ({ lines: { ...s.lines, [stream]: [] } })),
}));

/** convenience appender bound to a stream, batched via rAF. */
export function logger(stream: LogStream): (msg: string) => void {
    let pending: string[] = [];
    let rafId = 0;
    const flush = () => {
        rafId = 0;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        useLogs.getState().appendMany(stream, batch);
    };
    return (msg: string) => {
        pending.push(msg);
        if (!rafId) rafId = requestAnimationFrame(flush);
    };
}
