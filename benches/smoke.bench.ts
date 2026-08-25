import { bench, group } from '@pmndrs/labs';

group('smoke test @smoke', () => {
    bench('array push 1k', function* () {
        const arr: number[] = [];
        yield () => {
            for (let i = 0; i < 1000; i++) arr.push(i);
            return arr.length;
        };
    });
});
