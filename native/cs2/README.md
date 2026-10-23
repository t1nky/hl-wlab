# CS2 scan numeric kernel

Rebuild the checked-in `web/cs2/scan.wasm` from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-cs2-scan.ps1
```

Built with Zig 0.16.0's freestanding C++ compiler. No new runtime dependency or
GoldSrc engine change. Keep `-ffp-contract=off`; never enable fast math. Coordinates,
triangle/SAT arithmetic, intervals and damage use f64, in the JavaScript operation
order. Float32 map vertices and conservative BVH bounds promote to f64. `Math.pow`
is imported from the host to preserve the engine's exponentiation results.

The production entry points are `cs2_column` and `cs2_energy_batch` (at most 1,024
rays). The TypeScript scanner still owns row order, target hitgroups, scheduling,
bounded placement caching and exact JavaScript fallback. Negative native status
means a capacity limit: recompute that entire column/ray with JavaScript. Full
public shot contacts/spans/issues/losses and movement retain the original JS BVH.

ABI 1 has a 144-byte map header: fourteen u32 pointers/counts followed by eleven
f64 values (far, six exact bounds, four reserved initial weapon values). The
compiled module exports its ABI, heap base and context size; TypeScript checks
these before allocating. Packed nodes are 32 bytes: six float32 bounds, an index
and flags. Flags 0/1 select bullet/player; bit 3 marks a leaf, with triangle count
in bits 8–23. Interior indices point after the entire subtree; leaf indices point
into the accelerated indirect triangle order.

SAH changes candidate traversal only. Each actual ray hit is restored to original
JS depth-first triangle rank **before** shape grouping or stable distance sorting.
Equal-fraction sweeps retain the lowest original rank, and the thirteen SAT axes
retain their original order and first-winning normal. Every ray retains the full
original far distance, including crossings beyond the target needed to determine
open/inside geometry. No target-distance truncation or geometry simplification.

One actual shared `WebAssembly.Memory` owns all immutable numeric arrays and five
fixed scratch/1 MiB stack slots: coordinator 0, scan workers 1–4. Each instance has
its own mutable stack-pointer global and writes only its assigned slot. The
memory cannot grow. An arbitrary external SharedArrayBuffer cannot be imported as
WASM memory. Production adopts the geometry views from this Memory, then shares
the original JS BVH/indirect order once for inspector/movement/fallback. Do not
pair the accelerated indirect array with the original JS BVH.

The persistent acceleration cache holds one map. Its key includes binary SHA256,
ABI, cache schema 2, BVH dependency versions, strategy and leaf size. SHA256 covers
all derived arrays including bounds, with separate component hashes and a manifest
to avoid concatenating another full index in memory. Reads also require a complete
triangle permutation, nonempty disjoint leaf coverage, coherent binary subtree
escapes and collision masks, flags and exact original DFS ranks. Quota,
cache or native initialization failure retains the JS implementation. Loaded
geometry/flags are immutable; replace the map to change them. Weapon values are
private to each context and refreshed every scan; no shot answers are cached.

Worker count changes/errors terminate old children before their slots are reused.
Closing a native handle drops its Memory/Instance/views; other active slots remain
valid. The pool and coordinator intentionally share the Memory for the loaded
map's lifetime; terminating the map worker ends its children and releases it.
Browsers without shared memory use the exact one-worker JavaScript path.

Regression tests: `web/tests/cs2-native-scan.test.ts`. Exact installed-map benchmark:
`bun tools/cs2-native-bench.mjs <label>`. Browser benchmark:
`bun tools/cs2-scan-browser-bench.mjs` with the integrated server already on 8768.
Private fixtures and raw reports stay under ignored `.local`.
