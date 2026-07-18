import {
    Animation,
    AnimatorTrait,
    addChild,
    addTrait,
    cloneModel,
    env,
    getTrait,
    onInit,
    script,
    setPosition,
    trait,
    TransformTrait,
    type Node,
    onDispose,
    destroyNode,
} from 'bongle';
import { models } from 'bongle/kit';

const PenguinModel = models.peng;

const AnimatedMeshesTrait = trait('animated-meshes');

script(
    AnimatedMeshesTrait,
    'spawn',
    (ctx) => {
        if (!env.client) return;

        const N = 10;
        const SPACING = 1;
        const Y = 0;

        const penguins: Node[] = [];

        onInit(ctx, () => {
            for (let z = 0; z < N; z++) {
                for (let x = 0; x < N; x++) {
                    const node = cloneModel(PenguinModel.scene);
                    node.name = `peng-${x}-${z}`;
                    const transform = getTrait(node, TransformTrait)!;
                    setPosition(transform, [x * SPACING, Y, z * SPACING]);

                    addChild(ctx.nodes.root, node);

                    const animator = addTrait(node, AnimatorTrait);
                    const action = Animation.clip(animator, PenguinModel.animations.waddle);
                    Animation.play(action);

                    penguins.push(node);
                }
            }
        });

        onDispose(ctx, () => {
            for (const penguin of penguins) {
                destroyNode(penguin);
            }
        });
    },
    { editor: true },
);
