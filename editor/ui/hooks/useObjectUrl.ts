// editor/ui/hooks/useObjectUrl.ts — turn bytes into a blob object URL that is
// revoked on change / unmount, so image previews don't leak blobs. Null bytes
// (nothing to show) → null url.

import { useEffect, useState } from 'react';

export function useObjectUrl(bytes: Uint8Array | null, type: string): string | null {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!bytes) {
            setUrl(null);
            return;
        }
        const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [bytes, type]);
    return url;
}
