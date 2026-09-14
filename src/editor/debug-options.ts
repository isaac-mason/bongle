import type { TabGroup } from '../client/debug';
import { useClient } from '../client/ui/stores/client-store';
import { useEditor } from './editor-store';

export function addEditorDebugOptions(tabs: TabGroup): void {
    const options = tabs.tab('options');
    const ed = () => useEditor.getState();
    options.add({ get: () => ed().showGrid, set: (v) => ed().setShowGrid(v) }, { label: 'grid', listen: true });
    const view = options.folder('view');
    view.add({ get: () => ed().showMarkers, set: (v) => ed().setShowMarkers(v) }, { label: 'markers', listen: true });
    view.add({ get: () => ed().showOutlines, set: (v) => ed().setShowOutlines(v) }, { label: 'outlines', listen: true });
    view.add({ get: () => ed().showHandles, set: (v) => ed().setShowHandles(v) }, { label: 'handles', listen: true });
    view.add(
        { get: () => ed().showRelationshipLines, set: (v) => ed().setShowRelationshipLines(v) },
        { label: 'relationship lines', listen: true },
    );
    view.add({ get: () => ed().showNames, set: (v) => ed().setShowNames(v) }, { label: 'names', listen: true });
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
