// cli/realms/client/dev-host.ts, what both `bongle dev` browser realms share: the dev
// server's resource + scene endpoints and the /game socket.

/** baked client resources (atlas, model bins) are served by the dev server out of
 *  the project's resources/client/ (the serve-resources plugin); runtime-source urls
 *  (http / rooted) pass through. */
export const httpResourceLoader = {
    loadBytes: async (url: string): Promise<Uint8Array> => {
        const target = /^(https?:|\/)/.test(url) ? url : `/resources/client/${url.replace(/^\.?\//, '')}`;
        const r = await fetch(target);
        if (!r.ok) throw new Error(`fetch ${target}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
    },
};

/** the editor lists/reads scene files over HTTP from the dev server; writes flow
 *  through the editor's RPCs to the server, which owns the disk. */
export const httpSceneSource = {
    listScenes: async (): Promise<string[]> => {
        const r = await fetch('/__bongle/scenes');
        return r.ok ? ((await r.json()) as string[]) : [];
    },
    readScene: async (id: string): Promise<string | null> => {
        const r = await fetch(`/__bongle/scenes/${encodeURIComponent(id)}`);
        return r.ok ? await r.text() : null;
    },
};

/** the /game socket. opened before the engine so the driver's `send` can close
 *  over it; attach the message listener before `load` so nothing the server sends
 *  at join time is dropped, then await `opened`. */
export function dialGame(): WebSocket {
    const ws = new WebSocket(`ws://${location.host}/game`);
    ws.binaryType = 'arraybuffer';
    return ws;
}

export function opened(ws: WebSocket): Promise<void> {
    if (ws.readyState === ws.OPEN) return Promise.resolve();
    return new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));
}
