// editor/ui/image-mime.ts — extension → image mime, shared by the image apps
// (viewer blobs, editor decode/encode). Unknown → octet-stream.

const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
};

export function imageMime(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return MIME[ext] ?? 'application/octet-stream';
}
