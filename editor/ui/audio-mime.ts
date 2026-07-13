// editor/ui/audio-mime.ts — extension → audio mime, for the audio player app.
// Unknown → octet-stream (the <audio> element will just refuse it).

const MIME: Record<string, string> = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    weba: 'audio/webm',
};

export const AUDIO_EXTS = Object.keys(MIME);

export function audioMime(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return MIME[ext] ?? 'application/octet-stream';
}
