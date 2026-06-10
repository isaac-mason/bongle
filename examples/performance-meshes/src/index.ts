import {
    addChild,
    addTrait,
    cloneModel,
    env,
    FlyControllerTrait,
    matchmaking,
    onFrame,
    onInit,
    onJoin,
    script,
    setPosition,
    setQuaternion,
    TransformTrait,
    trait,
} from 'bongle';
import { models } from 'bongle/starter';
import { quat } from 'mathcat';

// ── matchmaking ─────────────────────────────────────────────────────

matchmaking({ maxPlayers: 4 });

const SparkModel = models.spark;

// ── meshes ──────────────────────────────────────────────────────────

const MeshesTrait = trait('meshes');

const _q = quat.create();
const ROT_AXIS: [number, number, number] = [0, 1, 0];
const ROT_SPEED = 1.0; // radians per second

script(
    MeshesTrait,
    'spawn',
    (ctx) => {
        if (!env.client) return;
        if (ctx.mode !== 'edit') return;

        const N = 10;
        const SPACING = 1;

        const transforms: TransformTrait[] = [];
        let elapsed = 0;

        onJoin(ctx, ({ playerNode }) => {
            addTrait(playerNode, FlyControllerTrait);
        });

        onInit(ctx, () => {
            for (let y = 0; y < N; y++) {
                for (let z = 0; z < N; z++) {
                    for (let x = 0; x < N; x++) {
                        const mesh = cloneModel(SparkModel.scene);
                        mesh.name = `spark-${x}-${y}-${z}`;
                        mesh.persist = false;
                        const transform = addTrait(mesh, TransformTrait);
                        setPosition(transform, [x * SPACING, y * SPACING, z * SPACING]);

                        addChild(ctx.node, mesh);
                        transforms.push(transform);
                    }
                }
            }
        });

        onFrame(ctx, (args) => {
            elapsed += args.delta;
            const angle = elapsed * ROT_SPEED;
            quat.setAxisAngle(_q, ROT_AXIS, angle);
            for (let i = 0; i < transforms.length; i++) {
                setQuaternion(transforms[i]!, _q);
            }
        });
    },
    { editor: true },
);
