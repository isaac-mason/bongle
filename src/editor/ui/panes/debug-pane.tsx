import { useEditRoom } from '../../edit-room-store';
import { useEditor } from '../../editor-store';
import { NumberInput } from '../components/number-input';
import { Range } from '../components/range';

export function DebugPane() {
    const showColliders = useEditRoom((s) => s.showPhysicsColliders);
    const setShowColliders = useEditRoom((s) => s.setShowPhysicsColliders);
    const showGrid = useEditRoom((s) => s.showGrid);
    const setShowGrid = useEditRoom((s) => s.setShowGrid);
    const showOrientationCube = useEditRoom((s) => s.showOrientationCube);
    const setShowOrientationCube = useEditRoom((s) => s.setShowOrientationCube);
    const showChunkBoundaries = useEditRoom((s) => s.showChunkBoundaries);
    const setShowChunkBoundaries = useEditRoom((s) => s.setShowChunkBoundaries);
    const netSimEnabled = useEditor((s) => s.netSimEnabled);
    const setNetSimEnabled = useEditor((s) => s.setNetSimEnabled);
    const netSimRttMs = useEditor((s) => s.netSimRttMs);
    const setNetSimRttMs = useEditor((s) => s.setNetSimRttMs);
    const netSimJitterMs = useEditor((s) => s.netSimJitterMs);
    const setNetSimJitterMs = useEditor((s) => s.setNetSimJitterMs);

    return (
        <div className="flex flex-col gap-1 px-3 py-2">
            <label className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={showColliders}
                    onChange={(e) => setShowColliders(e.target.checked)}
                    className="accent-blue-500"
                />
                show physics colliders
            </label>
            <label className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={showGrid}
                    onChange={(e) => setShowGrid(e.target.checked)}
                    className="accent-blue-500"
                />
                show grid
            </label>
            <label className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={showOrientationCube}
                    onChange={(e) => setShowOrientationCube(e.target.checked)}
                    className="accent-blue-500"
                />
                show orientation cube
            </label>
            <label className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={showChunkBoundaries}
                    onChange={(e) => setShowChunkBoundaries(e.target.checked)}
                    className="accent-blue-500"
                />
                show chunk boundaries
            </label>
            <label className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={netSimEnabled}
                    onChange={(e) => setNetSimEnabled(e.target.checked)}
                    className="accent-blue-500"
                />
                simulate ws latency
            </label>
            {netSimEnabled && (
                <>
                    <div className="flex items-center gap-1 pl-5">
                        <span className="text-[10px] font-mono text-neutral-500 w-12 shrink-0">rtt ms</span>
                        <NumberInput value={netSimRttMs} onChange={setNetSimRttMs} min={0} max={2000} step={10} />
                        <Range value={netSimRttMs} onChange={setNetSimRttMs} min={0} max={500} step={10} />
                    </div>
                    <div className="flex items-center gap-1 pl-5">
                        <span className="text-[10px] font-mono text-neutral-500 w-12 shrink-0">jitter ms</span>
                        <NumberInput value={netSimJitterMs} onChange={setNetSimJitterMs} min={0} max={1000} step={10} />
                        <Range value={netSimJitterMs} onChange={setNetSimJitterMs} min={0} max={300} step={10} />
                    </div>
                </>
            )}
        </div>
    );
}
