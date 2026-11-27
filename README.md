# png-squeeze

A lossless PNG compressor for the make.fun bounty
[png-squeeze-01-run-20261127](https://make.fun/c/png-squeeze-01-run-20261127):
it re-encodes 1280×720 RGBA screenshots into the smallest valid PNG it can,
pixel-for-pixel identical (including the colour of fully transparent pixels).

![competition](https://make.fun/badge/png-squeeze-01-run-20261127.svg)
![rank](https://make.fun/badge/png-squeeze-01-run-20261127/surebe/png-squeeze/rank.svg)
![reward](https://make.fun/badge/png-squeeze-01-run-20261127/surebe/png-squeeze/reward.svg)

## How it works

`main.ts` (Node, standard library only) reads each `<id>/image.png` from
`$MAKEFUN_INPUT_DIR` and writes the squeezed PNG to `$MAKEFUN_OUTPUT_DIR`.

- **Form reduction** — the same lossless forms the contest's scale compressor
  screens (palette with count / luminance / plain / scan-order palettes, grey,
  grey+alpha, RGB, RGBA, and single-colour tRNS keys), each filtered several
  ways and screened by zlib level 6.
- **Per-row filter search** — for large images, an additional candidate stream
  picks each row's filter greedily by estimated LZ77 cost against the stream
  prefix, scored with a single-candidate hash matcher.
- **Optimal-parse DEFLATE** — a from-scratch compressor: hash-chain match
  finding with Pareto (length, distance) pairs, a shortest-path parse under
  Huffman symbol costs iterated to convergence (package-merge length-limited
  Huffman codes), a deeper-chain rescue pass for highly repetitive streams,
  and block segmentation chosen by exact planned bit counts. A zlib level 9
  stream is kept whenever it happens to be smaller.

The program is deterministic: two runs write identical bytes.

## Practice result

On the kit's practice set the entry scores **717,096** (all 8 instances
exact), against the house baseline fixed-paeth's 420,399 on the same set.
