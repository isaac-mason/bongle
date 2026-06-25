export type Bitset = number[];

const BITS_PER_WORD = 32;

export function init(size = 4): Bitset {
    const arr = new Array(size);
    for (let i = 0; i < size; i++) arr[i] = 0;
    return arr;
}

function ensureBitsetSize(bitset: Bitset, traitId: number): Bitset {
    const wordIndex = (traitId / BITS_PER_WORD) | 0;
    if (wordIndex >= bitset.length) {
        const newSize = Math.max(bitset.length * 2, wordIndex + 1);
        for (let i = bitset.length; i < newSize; i++) {
            bitset.push(0);
        }
    }
    return bitset;
}

export function add(bitset: Bitset, traitId: number): Bitset {
    ensureBitsetSize(bitset, traitId);
    const wordIndex = (traitId / BITS_PER_WORD) | 0;
    const bitIndex = traitId % BITS_PER_WORD;
    bitset[wordIndex] = (bitset[wordIndex] | ((1 << bitIndex) >>> 0)) >>> 0;
    return bitset;
}

export function remove(bitset: Bitset, traitId: number): Bitset {
    const wordIndex = (traitId / BITS_PER_WORD) | 0;
    if (wordIndex >= bitset.length) return bitset;
    const bitIndex = traitId % BITS_PER_WORD;
    bitset[wordIndex] = (bitset[wordIndex] & ~((1 << bitIndex) >>> 0)) >>> 0;
    return bitset;
}

export function has(bitset: Bitset, traitId: number): boolean {
    const wordIndex = (traitId / BITS_PER_WORD) | 0;
    if (wordIndex >= bitset.length) return false;
    const bitIndex = traitId % BITS_PER_WORD;
    return (bitset[wordIndex] & ((1 << bitIndex) >>> 0)) !== 0;
}

export function containsAll(bitset: Bitset, mask: Bitset): boolean {
    for (let i = 0; i < mask.length; i++) {
        const word = i < bitset.length ? bitset[i] : 0;
        if ((word & mask[i]) !== mask[i]) return false;
    }
    return true;
}

export function containsNone(bitset: Bitset, mask: Bitset): boolean {
    const len = Math.min(bitset.length, mask.length);
    for (let i = 0; i < len; i++) {
        if ((bitset[i] & mask[i]) !== 0) return false;
    }
    return true;
}

export function copy(bitset: Bitset): Bitset {
    return bitset.slice();
}

export function reset(bitset: Bitset): void {
    for (let i = 0; i < bitset.length; i++) bitset[i] = 0;
}
