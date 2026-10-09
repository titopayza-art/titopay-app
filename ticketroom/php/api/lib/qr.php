<?php
/**
 * Dependency-free QR code encoder (ISO/IEC 18004), PHP 8.0+.
 *
 * - Byte mode only (input bytes are encoded as-is, so UTF-8 strings work).
 * - Error correction levels L, M, Q, H.
 * - Versions 1..40; the smallest version that fits is chosen automatically.
 * - All 8 masks are evaluated with the standard penalty rules; the lowest wins.
 *
 * Public API:
 *   tr_qr_matrix(string $data, string $ecc = 'M'): array   rows of bools, true = dark, no quiet zone
 *   tr_qr_svg(string $data, array $opts = []): string       standalone SVG
 *
 * Coordinates below are (x, y) = (column, row); the matrix is indexed $m[$y][$x].
 */

/* ------------------------------------------------------------------------ */
/* Tables                                                                   */
/* ------------------------------------------------------------------------ */

/** EC codewords per block, indexed [ecc][version]. Index 0 unused. */
function tr_qr_ecc_per_block(string $ecc, int $ver): int
{
    static $t = [
        'L' => [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        'M' => [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
        'Q' => [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        'H' => [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    ];
    return $t[$ecc][$ver];
}

/** Number of EC blocks, indexed [ecc][version]. Index 0 unused. */
function tr_qr_num_blocks(string $ecc, int $ver): int
{
    static $t = [
        'L' => [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
        'M' => [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
        'Q' => [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
        'H' => [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
    ];
    return $t[$ecc][$ver];
}

/** Format-info bits for each EC level (note: not alphabetical). */
function tr_qr_ecc_format_bits(string $ecc): int
{
    return ['L' => 1, 'M' => 0, 'Q' => 3, 'H' => 2][$ecc];
}

/**
 * Number of modules available for data + EC codewords (i.e. everything
 * except function patterns and format/version info), in bits.
 */
function tr_qr_raw_data_modules(int $ver): int
{
    $result = (16 * $ver + 128) * $ver + 64;
    if ($ver >= 2) {
        $numAlign = intdiv($ver, 7) + 2;
        $result -= (25 * $numAlign - 10) * $numAlign - 55;
        if ($ver >= 7) {
            $result -= 36;
        }
    }
    return $result;
}

/** Number of 8-bit data codewords (excluding EC) for a version + level. */
function tr_qr_data_codewords(int $ver, string $ecc): int
{
    return intdiv(tr_qr_raw_data_modules($ver), 8)
        - tr_qr_ecc_per_block($ecc, $ver) * tr_qr_num_blocks($ecc, $ver);
}

/** Centre coordinates of alignment patterns (same list for rows and columns). */
function tr_qr_alignment_positions(int $ver): array
{
    if ($ver === 1) {
        return [];
    }
    $size = $ver * 4 + 17;
    $numAlign = intdiv($ver, 7) + 2;
    $step = ($ver === 32) ? 26 : (int)ceil(($ver * 4 + 4) / ($numAlign * 2 - 2)) * 2;
    $result = [];
    for ($i = 0, $pos = $size - 7; $i < $numAlign - 1; $i++, $pos -= $step) {
        array_unshift($result, $pos);
    }
    array_unshift($result, 6);
    return $result;
}

/* ------------------------------------------------------------------------ */
/* Reed-Solomon over GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D) */
/* ------------------------------------------------------------------------ */

/** Returns [exp, log] tables. exp has 512 entries to avoid a modulo. */
function tr_qr_gf_tables(): array
{
    static $tables = null;
    if ($tables === null) {
        $exp = array_fill(0, 512, 0);
        $log = array_fill(0, 256, 0);
        $x = 1;
        for ($i = 0; $i < 255; $i++) {
            $exp[$i] = $x;
            $log[$x] = $i;
            $x <<= 1;
            if ($x & 0x100) {
                $x ^= 0x11D;
            }
        }
        for ($i = 255; $i < 512; $i++) {
            $exp[$i] = $exp[$i - 255];
        }
        $tables = [$exp, $log];
    }
    return $tables;
}

function tr_qr_gf_mul(int $a, int $b): int
{
    if ($a === 0 || $b === 0) {
        return 0;
    }
    [$exp, $log] = tr_qr_gf_tables();
    return $exp[$log[$a] + $log[$b]];
}

/**
 * Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), coefficients
 * from highest to lowest power, with the leading 1 omitted.
 */
function tr_qr_rs_divisor(int $degree): array
{
    static $cache = [];
    if (isset($cache[$degree])) {
        return $cache[$degree];
    }
    $result = array_fill(0, $degree, 0);
    $result[$degree - 1] = 1; // start with the monomial x^0
    $root = 1;
    for ($i = 0; $i < $degree; $i++) {
        // Multiply the current product by (x - root).
        for ($j = 0; $j < $degree; $j++) {
            $result[$j] = tr_qr_gf_mul($result[$j], $root);
            if ($j + 1 < $degree) {
                $result[$j] ^= $result[$j + 1];
            }
        }
        $root = tr_qr_gf_mul($root, 2);
    }
    return $cache[$degree] = $result;
}

/** Remainder of data(x) * x^degree divided by the generator = EC codewords. */
function tr_qr_rs_remainder(array $data, array $divisor): array
{
    $degree = count($divisor);
    $result = array_fill(0, $degree, 0);
    foreach ($data as $b) {
        $factor = $b ^ array_shift($result);
        $result[] = 0;
        if ($factor !== 0) {
            for ($i = 0; $i < $degree; $i++) {
                $result[$i] ^= tr_qr_gf_mul($divisor[$i], $factor);
            }
        }
    }
    return $result;
}

/* ------------------------------------------------------------------------ */
/* Codeword construction                                                    */
/* ------------------------------------------------------------------------ */

/** Builds the data codeword sequence (mode, length, payload, terminator, padding). */
function tr_qr_data_bytes(string $data, int $ver, string $ecc): array
{
    $bits = [];
    $append = static function (int $val, int $len) use (&$bits): void {
        for ($i = $len - 1; $i >= 0; $i--) {
            $bits[] = ($val >> $i) & 1;
        }
    };
    $len = strlen($data);
    $append(0b0100, 4);                       // byte mode indicator
    $append($len, $ver <= 9 ? 8 : 16);         // character count
    for ($i = 0; $i < $len; $i++) {
        $append(ord($data[$i]), 8);
    }

    $capacityBits = tr_qr_data_codewords($ver, $ecc) * 8;
    $append(0, min(4, $capacityBits - count($bits)));     // terminator
    $append(0, (8 - count($bits) % 8) % 8);               // pad to byte boundary

    $bytes = [];
    for ($i = 0, $n = count($bits); $i < $n; $i += 8) {
        $v = 0;
        for ($j = 0; $j < 8; $j++) {
            $v = ($v << 1) | $bits[$i + $j];
        }
        $bytes[] = $v;
    }
    // Alternate pad bytes 0xEC, 0x11 until full.
    for ($pad = 0xEC; count($bytes) < $capacityBits / 8; $pad ^= 0xEC ^ 0x11) {
        $bytes[] = $pad;
    }
    return $bytes;
}

/** Splits data into blocks, appends RS EC to each, and interleaves them. */
function tr_qr_add_ecc_and_interleave(array $data, int $ver, string $ecc): array
{
    $numBlocks = tr_qr_num_blocks($ecc, $ver);
    $blockEccLen = tr_qr_ecc_per_block($ecc, $ver);
    $rawCodewords = intdiv(tr_qr_raw_data_modules($ver), 8);
    $numShortBlocks = $numBlocks - $rawCodewords % $numBlocks;
    $shortBlockLen = intdiv($rawCodewords, $numBlocks);  // data + ecc length of a short block
    $divisor = tr_qr_rs_divisor($blockEccLen);

    $blocks = [];
    for ($i = 0, $k = 0; $i < $numBlocks; $i++) {
        $datLen = $shortBlockLen - $blockEccLen + ($i < $numShortBlocks ? 0 : 1);
        $dat = array_slice($data, $k, $datLen);
        $k += $datLen;
        $eccBytes = tr_qr_rs_remainder($dat, $divisor);
        if ($i < $numShortBlocks) {
            $dat[] = -1; // placeholder so all blocks line up for interleaving
        }
        $blocks[] = array_merge($dat, $eccBytes);
    }

    // Read column-wise across blocks, skipping the placeholders.
    $result = [];
    $blockLen = $shortBlockLen + 1;
    for ($i = 0; $i < $blockLen; $i++) {
        foreach ($blocks as $j => $block) {
            if ($i !== $shortBlockLen - $blockEccLen || $j >= $numShortBlocks) {
                $result[] = $block[$i];
            }
        }
    }
    return $result;
}

/* ------------------------------------------------------------------------ */
/* Matrix construction                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Draws all function patterns. $m holds module colours; $fn marks modules
 * that are function modules (never touched by data or masking).
 */
function tr_qr_draw_function_patterns(array &$m, array &$fn, int $ver): void
{
    $size = count($m);
    $set = static function (int $x, int $y, bool $dark) use (&$m, &$fn): void {
        $m[$y][$x] = $dark;
        $fn[$y][$x] = true;
    };

    // Timing patterns (row 6 and column 6).
    for ($i = 0; $i < $size; $i++) {
        $set(6, $i, $i % 2 === 0);
        $set($i, 6, $i % 2 === 0);
    }

    // Finder patterns with their separators (the 9x9 area clipped to the symbol).
    foreach ([[3, 3], [$size - 4, 3], [3, $size - 4]] as [$cx, $cy]) {
        for ($dy = -4; $dy <= 4; $dy++) {
            for ($dx = -4; $dx <= 4; $dx++) {
                $x = $cx + $dx;
                $y = $cy + $dy;
                if ($x >= 0 && $x < $size && $y >= 0 && $y < $size) {
                    $dist = max(abs($dx), abs($dy));
                    $set($x, $y, $dist !== 2 && $dist !== 4);
                }
            }
        }
    }

    // Alignment patterns, except where they would overlap the finders.
    $pos = tr_qr_alignment_positions($ver);
    $n = count($pos);
    for ($i = 0; $i < $n; $i++) {
        for ($j = 0; $j < $n; $j++) {
            if (($i === 0 && $j === 0) || ($i === 0 && $j === $n - 1) || ($i === $n - 1 && $j === 0)) {
                continue;
            }
            for ($dy = -2; $dy <= 2; $dy++) {
                for ($dx = -2; $dx <= 2; $dx++) {
                    $set($pos[$i] + $dx, $pos[$j] + $dy, max(abs($dx), abs($dy)) !== 1);
                }
            }
        }
    }

    // Reserve format info areas (real bits drawn later) and draw version info.
    tr_qr_draw_format_bits($m, $fn, 'M', 0);
    if ($ver >= 7) {
        // 18-bit version info: 6-bit version + 12-bit BCH(18,6) remainder, generator 0x1F25.
        $rem = $ver;
        for ($i = 0; $i < 12; $i++) {
            $rem = ($rem << 1) ^ (($rem >> 11) * 0x1F25);
        }
        $bits = ($ver << 12) | $rem;
        for ($i = 0; $i < 18; $i++) {
            $bit = (($bits >> $i) & 1) === 1;
            $a = $size - 11 + $i % 3;
            $b = intdiv($i, 3);
            $set($a, $b, $bit); // top-right block
            $set($b, $a, $bit); // bottom-left block
        }
    }
}

/** Draws the two copies of the 15-bit format info, plus the dark module. */
function tr_qr_draw_format_bits(array &$m, array &$fn, string $ecc, int $mask): void
{
    $size = count($m);
    $set = static function (int $x, int $y, bool $dark) use (&$m, &$fn): void {
        $m[$y][$x] = $dark;
        $fn[$y][$x] = true;
    };

    // 5 data bits + 10-bit BCH(15,5) remainder (generator 0x537), XOR mask 0x5412.
    $data = (tr_qr_ecc_format_bits($ecc) << 3) | $mask;
    $rem = $data;
    for ($i = 0; $i < 10; $i++) {
        $rem = ($rem << 1) ^ (($rem >> 9) * 0x537);
    }
    $bits = (($data << 10) | $rem) ^ 0x5412;
    $bit = static fn(int $i): bool => (($bits >> $i) & 1) === 1;

    // First copy, around the top-left finder.
    for ($i = 0; $i <= 5; $i++) {
        $set(8, $i, $bit($i));
    }
    $set(8, 7, $bit(6));
    $set(8, 8, $bit(7));
    $set(7, 8, $bit(8));
    for ($i = 9; $i < 15; $i++) {
        $set(14 - $i, 8, $bit($i));
    }

    // Second copy, split between top-right and bottom-left finders.
    for ($i = 0; $i < 8; $i++) {
        $set($size - 1 - $i, 8, $bit($i));
    }
    for ($i = 8; $i < 15; $i++) {
        $set(8, $size - 15 + $i, $bit($i));
    }
    $set(8, $size - 8, true); // the "dark module", always dark
}

/** Places codeword bits in the zig-zag order, skipping function modules. */
function tr_qr_draw_codewords(array &$m, array $fn, array $codewords): void
{
    $size = count($m);
    $totalBits = count($codewords) * 8;
    $i = 0;
    // Two-column strips from right to left; column 6 (vertical timing) is skipped.
    for ($right = $size - 1; $right >= 1; $right -= 2) {
        if ($right === 6) {
            $right = 5;
        }
        $upward = (($right + 1) & 2) === 0;
        for ($vert = 0; $vert < $size; $vert++) {
            $y = $upward ? $size - 1 - $vert : $vert;
            for ($j = 0; $j < 2; $j++) {
                $x = $right - $j;
                if (!$fn[$y][$x] && $i < $totalBits) {
                    $m[$y][$x] = (($codewords[$i >> 3] >> (7 - ($i & 7))) & 1) === 1;
                    $i++;
                }
                // Remaining (remainder) bits stay light, as initialised.
            }
        }
    }
}

/** XORs a mask pattern onto all non-function modules (self-inverse). */
function tr_qr_apply_mask(array &$m, array $fn, int $mask): void
{
    $size = count($m);
    for ($y = 0; $y < $size; $y++) {
        for ($x = 0; $x < $size; $x++) {
            if ($fn[$y][$x]) {
                continue;
            }
            switch ($mask) {
                case 0: $inv = ($x + $y) % 2 === 0; break;
                case 1: $inv = $y % 2 === 0; break;
                case 2: $inv = $x % 3 === 0; break;
                case 3: $inv = ($x + $y) % 3 === 0; break;
                case 4: $inv = (intdiv($x, 3) + intdiv($y, 2)) % 2 === 0; break;
                case 5: $inv = ($x * $y % 2 + $x * $y % 3) === 0; break;
                case 6: $inv = (($x * $y % 2 + $x * $y % 3) % 2) === 0; break;
                default: $inv = ((($x + $y) % 2 + $x * $y % 3) % 2) === 0; break;
            }
            if ($inv) {
                $m[$y][$x] = !$m[$y][$x];
            }
        }
    }
}

/** Penalty score per ISO/IEC 18004 section 7.8.3 (rules N1..N4). */
function tr_qr_penalty(array $m): int
{
    $size = count($m);
    $penalty = 0;

    // Build the transposed matrix so rows and columns share one code path.
    $cols = [];
    for ($x = 0; $x < $size; $x++) {
        $cols[$x] = array_column($m, $x);
    }

    foreach ([$m, $cols] as $lines) {
        foreach ($lines as $line) {
            // N1: runs of >= 5 same-colour modules: 3 + (run - 5).
            $run = 1;
            for ($i = 1; $i <= $size; $i++) {
                if ($i < $size && $line[$i] === $line[$i - 1]) {
                    $run++;
                } else {
                    if ($run >= 5) {
                        $penalty += 3 + ($run - 5);
                    }
                    $run = 1;
                }
            }
            // N3: finder-like 1:1:3:1:1 pattern with 4 light modules on either side.
            // Modules outside the symbol count as light (quiet zone).
            $s = str_repeat('0', 4);
            foreach ($line as $v) {
                $s .= $v ? '1' : '0';
            }
            $s .= '0000';
            $penalty += 40 * (substr_count($s, '00001011101') + substr_count($s, '10111010000'));
            // A pattern 00001011101 0000 matches both forms; standard practice counts it twice too.
        }
    }

    // N2: each 2x2 block of one colour: 3 points.
    for ($y = 0; $y < $size - 1; $y++) {
        for ($x = 0; $x < $size - 1; $x++) {
            $c = $m[$y][$x];
            if ($c === $m[$y][$x + 1] && $c === $m[$y + 1][$x] && $c === $m[$y + 1][$x + 1]) {
                $penalty += 3;
            }
        }
    }

    // N4: 10 points per 5% deviation of dark proportion from 50%.
    $dark = 0;
    foreach ($m as $row) {
        $dark += count(array_filter($row));
    }
    $total = $size * $size;
    $k = intdiv(abs($dark * 20 - $total * 10) + $total - 1, $total) - 1; // ceil(...) - 1
    $penalty += max(0, $k) * 10;

    return $penalty;
}

/**
 * Encodes $data (raw bytes) as a QR code matrix.
 *
 * @param string $data Bytes to encode (byte mode; UTF-8 passes through unchanged).
 * @param string $ecc  'L', 'M', 'Q' or 'H'.
 * @return array<int, array<int, bool>> Square matrix [$row][$col], true = dark, no quiet zone.
 * @throws InvalidArgumentException on a bad level or data too long for version 40.
 */
function tr_qr_matrix(string $data, string $ecc = 'M'): array
{
    $ecc = strtoupper($ecc);
    if (!in_array($ecc, ['L', 'M', 'Q', 'H'], true)) {
        throw new InvalidArgumentException("Invalid QR error correction level: $ecc");
    }

    // Smallest version whose capacity fits: 4-bit mode + count field + 8 bits/byte.
    $len = strlen($data);
    $ver = 0;
    for ($v = 1; $v <= 40; $v++) {
        $needBits = 4 + ($v <= 9 ? 8 : 16) + 8 * $len;
        if ($needBits <= tr_qr_data_codewords($v, $ecc) * 8) {
            $ver = $v;
            break;
        }
    }
    if ($ver === 0) {
        throw new InvalidArgumentException('Data too long for a QR code');
    }

    $codewords = tr_qr_add_ecc_and_interleave(tr_qr_data_bytes($data, $ver, $ecc), $ver, $ecc);

    $size = $ver * 4 + 17;
    $m = array_fill(0, $size, array_fill(0, $size, false));
    $fn = $m;
    tr_qr_draw_function_patterns($m, $fn, $ver);
    tr_qr_draw_codewords($m, $fn, $codewords);

    // Try each mask, keep the one with the lowest penalty.
    $best = null;
    $bestPenalty = PHP_INT_MAX;
    for ($mask = 0; $mask < 8; $mask++) {
        $cand = $m;
        $candFn = $fn;
        tr_qr_apply_mask($cand, $candFn, $mask);
        tr_qr_draw_format_bits($cand, $candFn, $ecc, $mask);
        $p = tr_qr_penalty($cand);
        if ($p < $bestPenalty) {
            $bestPenalty = $p;
            $best = $cand;
        }
    }
    return $best;
}

/**
 * Renders $data as a standalone SVG QR code.
 *
 * Options: 'ecc' => 'M', 'margin' => 1 (modules), 'dark' => '#0B1A33', 'light' => '#FFFFFF'.
 */
function tr_qr_svg(string $data, array $opts = []): string
{
    $ecc = (string)($opts['ecc'] ?? 'M');
    $margin = max(0, (int)($opts['margin'] ?? 1));
    $dark = htmlspecialchars((string)($opts['dark'] ?? '#0B1A33'), ENT_QUOTES | ENT_XML1);
    $light = htmlspecialchars((string)($opts['light'] ?? '#FFFFFF'), ENT_QUOTES | ENT_XML1);

    $m = tr_qr_matrix($data, $ecc);
    $size = count($m);
    $full = $size + 2 * $margin;

    // Merge horizontal runs of dark modules into one rectangle each.
    $d = '';
    for ($y = 0; $y < $size; $y++) {
        for ($x = 0; $x < $size; $x++) {
            if (!$m[$y][$x]) {
                continue;
            }
            $start = $x;
            while ($x + 1 < $size && $m[$y][$x + 1]) {
                $x++;
            }
            $w = $x - $start + 1;
            $d .= 'M' . ($start + $margin) . ' ' . ($y + $margin) . 'h' . $w . 'v1h-' . $w . 'z';
        }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $full . ' ' . $full . '"'
        . ' shape-rendering="crispEdges">'
        . '<rect width="' . $full . '" height="' . $full . '" fill="' . $light . '"/>'
        . '<path fill="' . $dark . '" d="' . $d . '"/>'
        . '</svg>';
}

// QR codes people make for posters and links (organiser event QR, admin QR
// maker). Colours must be plain #RRGGBB with enough contrast to scan; the
// text itself never appears in the SVG, only the squares that encode it.
function qr_colour(?string $c, string $fallback): string
{
    $c = trim((string) $c);
    return preg_match('/^#[0-9a-fA-F]{6}$/', $c) ? strtoupper($c) : $fallback;
}
function qr_luminance(string $hex): float
{
    $l = [];
    foreach ([1, 3, 5] as $i) { $v = hexdec(substr($hex, $i, 2)) / 255; $l[] = $v <= 0.03928 ? $v / 12.92 : (($v + 0.055) / 1.055) ** 2.4; }
    return 0.2126 * $l[0] + 0.7152 * $l[1] + 0.0722 * $l[2];
}
function qr_for_people(string $text, array $o = []): string
{
    if ($text === '' || strlen($text) > 1200) throw bad('Use between 1 and 1,200 characters.');
    $dark = qr_colour($o['dark'] ?? null, '#0B1A33');
    $light = qr_colour($o['light'] ?? null, '#FFFFFF');
    // Scanners need dark squares on a light background with real contrast.
    $ld = qr_luminance($dark); $ll = qr_luminance($light);
    if ($ld >= $ll || ($ll + 0.05) / ($ld + 0.05) < 3) throw invalid(['dark' => 'Pick a darker colour for the squares, or a lighter background. Phones cannot read low-contrast codes.']);
    $ecc = in_array($o['ecc'] ?? 'M', ['M', 'Q', 'H'], true) ? $o['ecc'] : 'M';
    return tr_qr_svg($text, ['ecc' => $ecc, 'margin' => 4, 'dark' => $dark, 'light' => $light]);
}
