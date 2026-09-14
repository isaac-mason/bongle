import { describe, expect, it } from 'vitest';
import * as Debug from '../../../src/core/debug';
import * as Protocol from '../../../src/core/protocol';

/** record a frame of nested scopes with known-ish shape. */
function frameWith(profiler: Debug.Profiler, build: () => void): void {
    Debug.frameStart(profiler);
    build();
    Debug.frameEnd(profiler);
}

/** busy-wait so a scope has a duration the reductions can order. */
function spin(ms: number): void {
    const until = performance.now() + ms;
    while (performance.now() < until) {
        // deliberate: a timer would not be inside the scope.
    }
}

describe('profiler scopes', () => {
    it('records nothing while disabled, and holds no ring', () => {
        const profiler = Debug.createProfiler(false);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'a');
            Debug.end(profiler, 'a');
            Debug.record(profiler, 'n', 1);
        });
        expect(Debug.frameCount(profiler)).toBe(0);
        expect(profiler.ring.length).toBe(0);
    });

    it('ignores scopes opened outside a frame', () => {
        const profiler = Debug.createProfiler(true);
        Debug.begin(profiler, 'stray');
        expect(Debug.end(profiler, 'stray')).toBe(0);
        expect(Debug.frameCount(profiler)).toBe(0);
    });

    it('flattens nested scopes in preorder with depths', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'outer');
            Debug.begin(profiler, 'inner');
            Debug.end(profiler, 'inner');
            Debug.begin(profiler, 'sibling');
            Debug.end(profiler, 'sibling');
            Debug.end(profiler, 'outer');
        });
        const frame = Debug.getFrame(profiler)!;
        expect(frame.count).toBe(3);
        expect([...frame.depth.subarray(0, 3)]).toEqual([0, 1, 1]);
        expect([0, 1, 2].map((i) => Debug.keyName(profiler, frame.key[i]!))).toEqual(['outer', 'inner', 'sibling']);
    });

    it('subtracts nested time from self, keeps it in inclusive', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'outer');
            Debug.begin(profiler, 'inner');
            spin(4);
            Debug.end(profiler, 'inner');
            Debug.end(profiler, 'outer');
        });
        const self = Debug.self(profiler);
        const incl = Debug.inclusive(profiler);
        expect(incl.outer).toBeGreaterThanOrEqual(incl.inner!);
        expect(self.outer).toBeLessThan(incl.inner!);
        expect(self.inner).toBeCloseTo(incl.inner!, 5);
    });

    it('sums a scope entered more than once in a frame', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            for (let i = 0; i < 3; i++) {
                Debug.begin(profiler, 'room');
                Debug.end(profiler, 'room');
            }
        });
        const frame = Debug.getFrame(profiler)!;
        expect(frame.count).toBe(3);
        expect(Object.keys(Debug.inclusive(profiler))).toEqual(['room']);
    });

    it('returns the measured duration from end', () => {
        const profiler = Debug.createProfiler(true);
        let measured = 0;
        frameWith(profiler, () => {
            Debug.begin(profiler, 'work');
            spin(3);
            measured = Debug.end(profiler, 'work');
        });
        expect(measured).toBeGreaterThan(1);
        expect(measured).toBeCloseTo(Debug.inclusive(profiler).work!, 5);
    });

    it('names the direct children of a scope, and of the frame', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'top');
            Debug.begin(profiler, 'child-a');
            Debug.begin(profiler, 'grandchild');
            Debug.end(profiler);
            Debug.end(profiler);
            Debug.begin(profiler, 'child-b');
            Debug.end(profiler);
            Debug.end(profiler);
            Debug.begin(profiler, 'other-top');
            Debug.end(profiler);
        });
        expect(Debug.childNames(profiler, null)).toEqual(['top', 'other-top']);
        expect(Debug.childNames(profiler, 'top')).toEqual(['child-a', 'child-b']);
        expect(Debug.childNames(profiler, 'child-a')).toEqual(['grandchild']);
        expect(Debug.childNames(profiler, 'absent')).toEqual([]);
    });

    it('collects children across every occurrence of a repeated parent', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'room');
            Debug.begin(profiler, 'physics');
            Debug.end(profiler);
            Debug.end(profiler);
            Debug.begin(profiler, 'room');
            Debug.begin(profiler, 'chat');
            Debug.end(profiler);
            Debug.end(profiler);
        });
        expect(Debug.childNames(profiler, 'room')).toEqual(['physics', 'chat']);
    });
});

describe('profiler counters', () => {
    it('reads back the last value per key, with its unit', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.record(profiler, 'bodies', 3, 'count');
            Debug.record(profiler, 'bodies', 7);
        });
        expect(Debug.counter(profiler, 'bodies')).toBe(7);
        expect(Debug.unitOf(profiler, 'bodies')).toBe('count');
        expect(Debug.counter(profiler, 'never-recorded')).toBe(0);
    });

    it('does not carry a counter into a frame that did not record it', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => Debug.record(profiler, 'spike', 5));
        frameWith(profiler, () => {});
        expect(Debug.counter(profiler, 'spike', 0)).toBe(0);
        expect(Debug.counter(profiler, 'spike', 1)).toBe(5);
    });

    it('attributes a counter to the scope it was recorded in', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.record(profiler, 'global', 1);
            Debug.begin(profiler, 'room');
            Debug.record(profiler, 'scoped', 2);
            Debug.end(profiler);
        });
        const frame = Debug.getFrame(profiler)!;
        expect(frame.counterSpan[0]).toBe(-1);
        expect(frame.counterSpan[1]).toBe(0);
    });
});

describe('profiler ring', () => {
    it('reads frames newest-first and wraps at capacity', () => {
        const profiler = Debug.createProfiler(true);
        const total = Debug.RING_FRAMES + 10;
        for (let i = 0; i < total; i++) frameWith(profiler, () => Debug.record(profiler, 'i', i));
        expect(Debug.frameCount(profiler)).toBe(Debug.RING_FRAMES);
        expect(Debug.counter(profiler, 'i', 0)).toBe(total - 1);
        expect(Debug.counter(profiler, 'i', 1)).toBe(total - 2);
        expect(Debug.getFrame(profiler, Debug.RING_FRAMES)).toBeNull();
        expect(Debug.getFrame(profiler, -1)).toBeNull();
    });

    it('holds the history still while frozen, and keeps measuring', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => Debug.record(profiler, 'i', 1));
        profiler.frozen = true;
        let measured = 0;
        frameWith(profiler, () => {
            Debug.record(profiler, 'i', 2);
            Debug.begin(profiler, 'work');
            spin(2);
            measured = Debug.end(profiler);
        });
        expect(Debug.frameCount(profiler)).toBe(1);
        expect(Debug.counter(profiler, 'i', 0)).toBe(1);
        expect(measured).toBeGreaterThan(0);
    });

    it('releases the ring when disabled and starts clean when re-enabled', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => Debug.record(profiler, 'i', 1));
        Debug.setEnabled(profiler, false);
        expect(Debug.frameCount(profiler)).toBe(0);
        expect(profiler.ring.length).toBe(0);
        Debug.setEnabled(profiler, true);
        frameWith(profiler, () => Debug.record(profiler, 'i', 2));
        expect(Debug.frameCount(profiler)).toBe(1);
        expect(Debug.counter(profiler, 'i')).toBe(2);
    });
});

describe('frame slicing', () => {
    /** a server-shaped frame: two rooms plus process-wide stages. */
    function serverFrame(): Debug.Profiler {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'inbox');
            Debug.end(profiler);
            Debug.begin(profiler, 'room:a');
            Debug.record(profiler, 'bodies', 10);
            Debug.begin(profiler, 'physics');
            spin(1);
            Debug.end(profiler);
            Debug.end(profiler);
            Debug.begin(profiler, 'room:b');
            Debug.record(profiler, 'bodies', 99);
            Debug.begin(profiler, 'physics');
            spin(1);
            Debug.end(profiler);
            Debug.end(profiler);
            Debug.record(profiler, 'proc/cpu', 42);
        });
        return profiler;
    }

    it('drops another room and its subtree, keeping process-wide stages', () => {
        const profiler = serverFrame();
        const frame = Debug.getFrame(profiler)!;
        const slice = Debug.createFrameSlice();
        Debug.sliceFrame(frame, new Set([profiler.keyToId.get('room:b')!]), 0, slice);
        const names = [...slice.key.subarray(0, slice.count)].map((id) => Debug.keyName(profiler, id));
        expect(names).toEqual(['inbox', 'room:a', 'physics']);
        expect([...slice.depth.subarray(0, slice.count)]).toEqual([0, 0, 1]);
        expect(slice.duration).toBe(frame.duration);
    });

    it('drops the other room counters but keeps frame-global ones', () => {
        const profiler = serverFrame();
        const frame = Debug.getFrame(profiler)!;
        const slice = Debug.createFrameSlice();
        Debug.sliceFrame(frame, new Set([profiler.keyToId.get('room:b')!]), 0, slice);
        const counters = new Map(
            [...slice.counterKey.subarray(0, slice.counterCount)].map((id, i) => [
                Debug.keyName(profiler, id),
                slice.counterValue[i]!,
            ]),
        );
        expect(counters.get('bodies')).toBe(10);
        expect(counters.get('proc/cpu')).toBe(42);
    });

    it('drops short subtrees but keeps the scalars recorded inside them', () => {
        const profiler = Debug.createProfiler(true);
        frameWith(profiler, () => {
            Debug.begin(profiler, 'slow');
            spin(2);
            Debug.begin(profiler, 'tiny');
            Debug.record(profiler, 'bakes', 4);
            Debug.end(profiler);
            Debug.end(profiler);
        });
        const slice = Debug.createFrameSlice();
        Debug.sliceFrame(Debug.getFrame(profiler)!, new Set(), 1, slice);
        const names = [...slice.key.subarray(0, slice.count)].map((id) => Debug.keyName(profiler, id));
        expect(names).toEqual(['slow']);
        expect(slice.counterCount).toBe(1);
        expect(slice.counterValue[0]).toBe(4);
    });
});

describe('mirrored frames', () => {
    it('replays a slice into another profiler under the same names', () => {
        const source = Debug.createProfiler(true);
        frameWith(source, () => {
            Debug.begin(source, 'tick');
            Debug.begin(source, 'physics');
            spin(1);
            Debug.end(source);
            Debug.end(source);
            Debug.record(source, 'bodies', 12, 'count');
        });
        const slice = Debug.createFrameSlice();
        Debug.sliceFrame(Debug.getFrame(source)!, new Set(), 0, slice);

        // the wire hands over the interned names in id order, then the columns.
        const mirror = Debug.createProfiler(true);
        for (let i = 0; i < source.idToKey.length; i++) {
            const id = Debug.intern(mirror, source.idToKey[i]!);
            mirror.unitById[id] = source.unitById[i]!;
        }
        Debug.pushFrame(mirror, {
            duration: slice.duration,
            count: slice.count,
            key: slice.key,
            depth: slice.depth,
            start: slice.start,
            end: slice.end,
            counterCount: slice.counterCount,
            counterKey: slice.counterKey,
            counterValue: slice.counterValue,
        });

        expect(Debug.frameCount(mirror)).toBe(1);
        expect(Debug.childNames(mirror, null)).toEqual(['tick']);
        expect(Debug.childNames(mirror, 'tick')).toEqual(['physics']);
        expect(Debug.counter(mirror, 'bodies')).toBe(12);
        expect(Debug.unitOf(mirror, 'bodies')).toBe('count');
        expect(Debug.inclusive(mirror).physics).toBeCloseTo(Debug.inclusive(source).physics!, 3);
    });

    it('ignores pushed frames while frozen', () => {
        const mirror = Debug.createProfiler(true);
        const empty = {
            duration: 1,
            count: 0,
            key: [],
            depth: [],
            start: [],
            end: [],
            counterCount: 0,
            counterKey: [],
            counterValue: [],
        };
        Debug.pushFrame(mirror, empty);
        mirror.frozen = true;
        Debug.pushFrame(mirror, empty);
        expect(Debug.frameCount(mirror)).toBe(1);
    });
});

describe('room_frames on the wire', () => {
    it('round-trips a sliced frame through the server message codec', () => {
        const source = Debug.createProfiler(true);
        Debug.frameStart(source);
        Debug.begin(source, 'tick');
        Debug.begin(source, 'room:a');
        spin(1);
        Debug.record(source, 'bodies', 12, 'count');
        Debug.end(source);
        Debug.end(source);
        Debug.frameEnd(source);

        const slice = Debug.createFrameSlice();
        Debug.sliceFrame(Debug.getFrame(source)!, new Set(), 0, slice);

        const packed = Protocol.packServerMessage({
            type: 'room_frames',
            roomId: 'a',
            keys: source.idToKey.slice(0),
            units: source.unitById.slice(0),
            duration: slice.duration,
            spanKey: slice.key.slice(0, slice.count),
            spanDepth: slice.depth.slice(0, slice.count),
            spanStart: slice.start.slice(0, slice.count),
            spanEnd: slice.end.slice(0, slice.count),
            counterKey: slice.counterKey.slice(0, slice.counterCount),
            counterValue: slice.counterValue.slice(0, slice.counterCount),
        });
        const message = Protocol.unpackServerMessage(packed);
        expect(message?.type).toBe('room_frames');
        if (message?.type !== 'room_frames') return;

        const mirror = Debug.createProfiler(true);
        for (let i = 0; i < message.keys.length; i++) {
            const id = Debug.intern(mirror, message.keys[i]!);
            const unit = message.units[i];
            if (unit) mirror.unitById[id] = unit;
        }
        Debug.pushFrame(mirror, {
            duration: message.duration,
            count: message.spanKey.length,
            key: message.spanKey,
            depth: message.spanDepth,
            start: message.spanStart,
            end: message.spanEnd,
            counterCount: message.counterKey.length,
            counterKey: message.counterKey,
            counterValue: message.counterValue,
        });

        expect(Debug.childNames(mirror, null)).toEqual(['tick']);
        expect(Debug.childNames(mirror, 'tick')).toEqual(['room:a']);
        expect(Debug.counter(mirror, 'bodies')).toBe(12);
        expect(Debug.unitOf(mirror, 'bodies')).toBe('count');
        expect(Debug.frameMs(mirror)).toBeCloseTo(Debug.frameMs(source), 3);
        expect(Debug.inclusive(mirror)['room:a']).toBeCloseTo(Debug.inclusive(source)['room:a']!, 3);
    });
});
