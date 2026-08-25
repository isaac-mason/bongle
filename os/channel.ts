import type { Channel } from './interface';

// Wrap a MessagePort as a Channel. The message handler is wired ONCE (connect's
// onMessage / listen's onConnect return) via `wire`; the port buffers until then.
export function makeChannel(
    port: MessagePort,
    onLocalClose?: () => void,
): { conn: Channel; wire: (h: (m: unknown) => void) => void } {
    let onClosed!: () => void;
    const closed = new Promise<void>((r) => (onClosed = r));
    let open = true;
    const conn: Channel = {
        send: (data) => {
            if (open) port.postMessage(data);
        },
        close: () => {
            if (!open) return;
            open = false;
            port.close();
            onClosed();
            onLocalClose?.();
        },
        closed,
    };
    const wire = (h: (m: unknown) => void) => {
        port.onmessage = (e) => h(e.data);
    };
    return { conn, wire };
}
