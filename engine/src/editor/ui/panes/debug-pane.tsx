import { useEditRoom } from '../../edit-room-store';

export function DebugPane() {
    const showColliders = useEditRoom((s) => s.showPhysicsColliders);
    const setShowColliders = useEditRoom((s) => s.setShowPhysicsColliders);
    const showGrid = useEditRoom((s) => s.showGrid);
    const setShowGrid = useEditRoom((s) => s.setShowGrid);
    const showOrientationCube = useEditRoom((s) => s.showOrientationCube);
    const setShowOrientationCube = useEditRoom((s) => s.setShowOrientationCube);
    const showChunkBoundaries = useEditRoom((s) => s.showChunkBoundaries);
    const setShowChunkBoundaries = useEditRoom((s) => s.setShowChunkBoundaries);

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
        </div>
    );
}
