'use strict';
// qr.js — minimal QR encoder (byte mode) with zero npm deps.
//
// Why this exists: /join is a phone flow. The donor reads a verification URL on
// a laptop and finishes the OAuth on their phone, so the URL has to be
// scannable. pool-meter is deliberately dependency-free (node stdlib only), so
// pulling `qrcode` off npm for one SVG was not acceptable. This is a standard
// ISO/IEC 18004 byte-mode encoder: version auto-select, Reed-Solomon ECC,
// standard mask penalty scoring. Verified module-for-module against segno
// (see test/qr-vs-segno.js) so it is not "probably right".
//
// Public API:
//   encode(text, { ecl }) -> { version, size, modules: boolean[][] }
//   svg(text, opts) -> string (standalone <svg>)

// ---- GF(2^8) arithmetic, primitive polynomial 0x11D ----
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// ---- ECC tables (index = version, 1..40). Standard ISO tables. ----
const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS = { L: 1, M: 0 };
const MIN_VERSION = 1;
const MAX_VERSION = 40;

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    // Version >= 7 carries TWO 3x6 version-information blocks (top-right and
    // bottom-left), so 36 modules are reserved, not 18. Getting this wrong
    // overstates capacity by 2 codewords and every v7+ symbol fails to scan.
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver, ecl) {
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
  );
}

function alignmentPatternPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const size = ver * 4 + 17;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon ----
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = Array.from(
      data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)),
    );
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // interleave placeholder, skipped below
    blocks.push(dat.concat(Array.from(ecc)));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // Skip the placeholder byte in short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

// ---- bit buffer ----
function appendBits(bb, val, len) {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

// ---- symbol construction ----
function makeSymbol(ver, ecl, dataCodewords, forceMask) {
  const size = ver * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array(size).fill(false));
    isFunction.push(new Array(size).fill(false));
  }
  const setFn = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  const drawFinder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  const drawAlign = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };
  const drawFormat = (mask) => {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true); // always-dark module
  };

  // timing patterns
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  const alignPos = alignmentPatternPositions(ver);
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === alignPos.length - 1) ||
        (i === alignPos.length - 1 && j === 0);
      if (!corner) drawAlign(alignPos[i], alignPos[j]);
    }
  }
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // data placement (zigzag, right to left, skipping the vertical timing column)
  const allCodewords = addEccAndInterleave(dataCodewords, ver, ecl);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < allCodewords.length * 8) {
          modules[y][x] = ((allCodewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const maskFns = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskFns[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };

  let bestMask = 0;
  let minPenalty = Infinity;
  if (typeof forceMask === 'number') {
    applyMask(forceMask);
    drawFormat(forceMask);
    return { version: ver, size, modules, mask: forceMask };
  }
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(modules, size);
    if (p < minPenalty) {
      minPenalty = p;
      bestMask = mask;
    }
    applyMask(mask); // undo (XOR is its own inverse)
  }
  applyMask(bestMask);
  drawFormat(bestMask);
  return { version: ver, size, modules, mask: bestMask };
}

// Standard penalty scoring (ISO/IEC 18004 section 8.8.2).
function penalty(modules, size) {
  const N1 = 3;
  const N2 = 3;
  const N3 = 40;
  const N4 = 10;
  let result = 0;

  // rows
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runX = 0;
    const runHistory = new Array(7).fill(0);
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runX++;
        if (runX === 5) result += N1;
        else if (runX > 5) result++;
      } else {
        finderPenaltyAddHistory(runX, runHistory, size);
        if (!runColor) result += finderPenaltyCountPatterns(runHistory) * N3;
        runColor = modules[y][x];
        runX = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runX, runHistory, size) * N3;
  }
  // columns
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runY = 0;
    const runHistory = new Array(7).fill(0);
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runY++;
        if (runY === 5) result += N1;
        else if (runY > 5) result++;
      } else {
        finderPenaltyAddHistory(runY, runHistory, size);
        if (!runColor) result += finderPenaltyCountPatterns(runHistory) * N3;
        runColor = modules[y][x];
        runY = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runY, runHistory, size) * N3;
  }
  // 2x2 blocks of same color
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += N2;
      }
    }
  }
  // balance of dark modules
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * N4;
  return result;
}

function finderPenaltyAddHistory(currentRunLength, runHistory, size) {
  if (runHistory[0] === 0) currentRunLength += size; // add light border to initial run
  runHistory.pop();
  runHistory.unshift(currentRunLength);
}

function finderPenaltyCountPatterns(runHistory) {
  const n = runHistory[1];
  const core =
    n > 0 &&
    runHistory[2] === n &&
    runHistory[3] === n * 3 &&
    runHistory[4] === n &&
    runHistory[5] === n;
  return (
    (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
    (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
  );
}

function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory, size) {
  if (currentRunColor) {
    finderPenaltyAddHistory(currentRunLength, runHistory, size);
    currentRunLength = 0;
  }
  currentRunLength += size; // add light border to final run
  finderPenaltyAddHistory(currentRunLength, runHistory, size);
  return finderPenaltyCountPatterns(runHistory);
}

/** Encode text (UTF-8, byte mode) into a QR symbol. */
function encode(text, opts = {}) {
  const ecl = opts.ecl === 'L' ? 'L' : 'M';
  const bytes = Buffer.from(String(text), 'utf8');
  // pick the smallest version that fits; fall back to L if M cannot hold it
  for (const level of [ecl, ecl === 'M' ? 'L' : 'M']) {
    for (let ver = MIN_VERSION; ver <= MAX_VERSION; ver++) {
      const capacityBits = numDataCodewords(ver, level) * 8;
      const ccBits = ver <= 9 ? 8 : 16;
      const usedBits = 4 + ccBits + bytes.length * 8;
      if (usedBits > capacityBits) continue;
      const bb = [];
      appendBits(bb, 0b0100, 4); // byte mode
      appendBits(bb, bytes.length, ccBits);
      for (const b of bytes) appendBits(bb, b, 8);
      appendBits(bb, 0, Math.min(4, capacityBits - bb.length)); // terminator
      appendBits(bb, 0, (8 - (bb.length % 8)) % 8); // byte align
      for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bb, pad, 8);
      const codewords = new Uint8Array(bb.length / 8);
      for (let i = 0; i < bb.length; i++) codewords[i >>> 3] |= bb[i] << (7 - (i & 7));
      return makeSymbol(ver, level, codewords, opts.forceMask);
    }
  }
  throw new Error('qr: data too long for a version 40 symbol');
}

/**
 * Render `text` as a standalone SVG QR code. Uses a single <path> so the markup
 * stays small enough to inline in an HTML response (no extra request, no cache
 * headers to get wrong).
 */
function svg(text, opts = {}) {
  const quiet = opts.quiet == null ? 4 : Math.max(0, opts.quiet | 0);
  const sym = encode(text, opts);
  const dim = sym.size + quiet * 2;
  let d = '';
  for (let y = 0; y < sym.size; y++) {
    for (let x = 0; x < sym.size; x++) {
      if (sym.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const light = opts.light || '#ffffff';
  const dark = opts.dark || '#000000';
  const attrs = opts.attrs || '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${opts.alt || 'QR code'}"${attrs ? ' ' + attrs : ''}>` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`
  );
}

module.exports = { encode, svg, numDataCodewords };
