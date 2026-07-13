// editor/ui/components/AudioPlayer.tsx — the "audio" app: a minimalist transport
// (play/pause, seek, volume, loop) over an <audio> element. Reads the file into
// a blob url and live-reloads when it changes on disk.

import { Music, Pause, Play, Repeat, Volume2 } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { audioMime } from '../audio-mime';
import { useObjectUrl } from '../hooks/useObjectUrl';

export function AudioPlayer({ fs, path }: { fs: Filesystem; path: string }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [data, setData] = useState<Uint8Array | null>(null);
    const [missing, setMissing] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [loop, setLoop] = useState(false);
    const url = useObjectUrl(data, audioMime(path));

    useEffect(() => {
        let alive = true;
        const load = async () => {
            if (!(await fs.exists(path))) {
                if (alive) {
                    setMissing(true);
                    setData(null);
                }
                return;
            }
            const bytes = await fs.read(path);
            if (!alive) return;
            setMissing(false);
            setData(bytes);
        };
        void load();
        const w = fs.watch((changes) => {
            if (changes.some((c) => c.path === path)) void load();
        });
        return () => {
            alive = false;
            w.close();
        };
    }, [fs, path]);

    const seek = (t: number) => {
        const el = audioRef.current;
        if (el) el.currentTime = t;
        setTime(t);
    };

    const toggle = () => {
        const el = audioRef.current;
        if (!el) return;
        if (el.paused) void el.play();
        else el.pause();
    };

    const name = path.split('/').pop() ?? path;

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                padding: 12,
                gap: 10,
                font: '12px/1.4 ui-monospace, monospace',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Music size={18} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>
                    {name}
                </span>
            </div>

            {missing ? (
                <span style={{ color: '#888' }}>(file not found)</span>
            ) : (
                <>
                    {/* biome-ignore lint/a11y/useMediaCaption: user audio assets have no captions track. */}
                    <audio
                        ref={audioRef}
                        src={url ?? undefined}
                        loop={loop}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                        onEnded={() => setPlaying(false)}
                    />

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button type="button" style={playBtn} onClick={toggle} title={playing ? 'pause' : 'play'}>
                            {playing ? <Pause size={16} /> : <Play size={16} />}
                        </button>
                        <input
                            type="range"
                            min={0}
                            max={duration || 0}
                            step={0.01}
                            value={Math.min(time, duration || 0)}
                            onChange={(e) => seek(Number(e.target.value))}
                            style={{ flex: 1 }}
                            title="seek"
                        />
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#888' }}>
                        <span>
                            {fmtTime(time)} / {fmtTime(duration)}
                        </span>
                        <span style={{ flex: 1 }} />
                        <button
                            type="button"
                            style={{ ...tag, ...(loop ? tagOn : null) }}
                            onClick={() => setLoop((v) => !v)}
                            title="loop"
                        >
                            <Repeat size={13} /> loop
                        </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Volume2 size={16} style={{ color: '#888', flexShrink: 0 }} />
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={volume}
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                setVolume(v);
                                if (audioRef.current) audioRef.current.volume = v;
                            }}
                            style={{ flex: 1 }}
                            title="volume"
                        />
                    </div>
                </>
            )}
        </div>
    );
}

function fmtTime(s: number): string {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

const playBtn: CSSProperties = {
    display: 'grid',
    placeItems: 'center',
    width: 34,
    height: 30,
    border: '1px solid #000',
    background: '#fff',
    cursor: 'pointer',
    flexShrink: 0,
};

const tag: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    border: '1px solid #000',
    background: '#fff',
    color: '#000',
    cursor: 'pointer',
    font: '12px/1 ui-monospace, monospace',
    padding: '3px 6px',
};

const tagOn: CSSProperties = { background: '#000', color: '#fff' };
