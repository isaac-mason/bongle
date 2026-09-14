// editor/debug-options.ts, the editor's tab on the engine debug dashboard: the
// debug view toggles + the ws-latency sim. All global editor state (useEditor),
// bound via get/set accessors; `listen` reflects external changes, `show` reveals
// the sim sliders only while latency sim is on. Registered through
// `extendDebugDashboard` by mountEditUI.

import type { TabGroup } from '../client/debug';
import { useClient } from '../client/ui/stores/client-store';
import { useEditor } from './editor-store';

export function addEditorDebugOptions(tabs: TabGroup): void {
    const options = tabs.tab('options');
    const ed = () => useEditor.getState();
    options.add(
        { get: () => ed().showPhysicsColliders, set: (v) => ed().setShowPhysicsColliders(v) },
        {
            label: 'physics colliders',
            listen: true,
        },
    );
    options.add({ get: () => ed().showGrid, set: (v) => ed().setShowGrid(v) }, { label: 'grid', listen: true });
    options.add(
        { get: () => ed().showOrientationCube, set: (v) => ed().setShowOrientationCube(v) },
        {
            label: 'orientation cube',
            listen: true,
        },
    );
    options.add(
        { get: () => ed().showChunkBoundaries, set: (v) => ed().setShowChunkBoundaries(v) },
        {
            label: 'chunk boundaries',
            listen: true,
        },
    );
    options.add(
        {
            get: () => useClient.getState().showGpucatInspector,
            set: (v) => useClient.getState().setShowGpucatInspector(v),
        },
        {
            label: 'gpucat inspector',
            listen: true,
        },
    );

    const simOn = () => useEditor.getState().netSimEnabled;
    options.add(
        { get: () => ed().netSimEnabled, set: (v) => ed().setNetSimEnabled(v) },
        {
            label: 'simulate ws latency',
            listen: true,
        },
    );
    options.add(
        { get: () => ed().netSimRttMs, set: (v) => ed().setNetSimRttMs(v) },
        {
            label: 'rtt ms',
            min: 0,
            max: 500,
            step: 10,
            show: simOn,
            listen: true,
        },
    );
    options.add(
        { get: () => ed().netSimJitterMs, set: (v) => ed().setNetSimJitterMs(v) },
        {
            label: 'jitter ms',
            min: 0,
            max: 300,
            step: 10,
            show: simOn,
            listen: true,
        },
    );
    options.add(
        { get: () => ed().netSimBurstMs, set: (v) => ed().setNetSimBurstMs(v) },
        {
            label: 'burst ms',
            min: 0,
            max: 1000,
            step: 10,
            show: simOn,
            listen: true,
        },
    );
    options.add(
        { get: () => ed().netSimBurstChance, set: (v) => ed().setNetSimBurstChance(v) },
        {
            label: 'burst pct',
            min: 0,
            max: 0.2,
            step: 0.01,
            show: simOn,
            listen: true,
        },
    );
}
