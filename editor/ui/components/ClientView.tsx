// editor/ui/components/ClientView.tsx — mounts a client connection's iframe
// into a window body. The iframe element is owned by the ClientHost (created up
// front so the handshake can start); this just parents it into the DOM.

import { useEffect, useRef } from 'react';
import type { ClientConnection } from '../../client-host';

export function ClientView({ connection }: { connection: ClientConnection }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (el && connection.iframe.parentElement !== el) el.appendChild(connection.iframe);
    }, [connection]);
    return <div ref={ref} style={{ width: '100%', height: '100%', background: '#000' }} />;
}
