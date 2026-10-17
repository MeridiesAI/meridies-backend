// allocates until the worker's memory cap kills it.
const keep = [];
for (;;) keep.push(new Array(1_000_000).fill(Math.random()));
