<?php
/**
 * A small PDF writer.
 *
 * Enough to typeset the lease agreement and the house rules: A4 pages, Helvetica
 * in regular and bold, word wrapping, headings, bullets and page breaks. No
 * dependencies, so it works on any shared host.
 */
declare(strict_types=1);

final class Pdf
{
    private const W = 595.28;          // A4 width in points
    private const H = 841.89;          // A4 height
    private const ML = 56.7;           // margins
    private const MR = 56.7;
    private const MT = 62.0;
    private const MB = 62.0;

    /** Helvetica advance widths per 1000 em, ASCII 32-126. */
    private const REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
        556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,
        722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,
        667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,
        222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
    private const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
        556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,
        722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,
        667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,
        278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

    private array $pages = [];
    private string $buf = '';
    private float $y = 0.0;
    private array $meta;

    public function __construct(array $meta = [])
    {
        $this->meta = $meta + ['title' => 'Document', 'footer' => ''];
        $this->newPage();
    }

    private function width(string $t, float $size, bool $bold): float
    {
        $tbl = $bold ? self::BOLD : self::REG;
        $w = 0;
        $len = strlen($t);
        for ($i = 0; $i < $len; $i++) {
            $c = ord($t[$i]);
            $w += ($c >= 32 && $c <= 126) ? $tbl[$c - 32] : 556;
        }
        return $w * $size / 1000;
    }

    private function esc(string $t): string
    {
        // PDF text strings use WinAnsi; fold the few characters we actually emit.
        $t = strtr($t, ['\\' => '\\\\', '(' => '\\(', ')' => '\\)']);
        $t = strtr($t, ["\xE2\x80\x99" => "'", "\xE2\x80\x98" => "'", "\xE2\x80\x9C" => '"',
                        "\xE2\x80\x9D" => '"', "\xE2\x80\x94" => '-', "\xE2\x80\x93" => '-',
                        "\xC2\xB7" => '-', "\xC2\xA0" => ' ']);
        return preg_replace('/[^\x20-\x7E]/', '', $t) ?? '';
    }

    private function newPage(): void
    {
        if ($this->buf !== '') $this->pages[] = $this->buf;
        $this->buf = '';
        $this->y = self::H - self::MT;
    }

    private function room(float $need): void
    {
        if ($this->y - $need < self::MB) $this->newPage();
    }

    /** Wrap text to the content width and emit it. */
    public function text(string $t, float $size = 10.0, bool $bold = false,
                         float $indent = 0.0, float $lead = 1.45): void
    {
        $max = self::W - self::ML - self::MR - $indent;
        foreach (explode("\n", $t) as $para) {
            $words = preg_split('/\s+/', trim($para)) ?: [];
            if ($words === [''] || $words === []) { $this->y -= $size * $lead; continue; }
            $line = '';
            foreach ($words as $word) {
                $try = $line === '' ? $word : $line . ' ' . $word;
                if ($this->width($try, $size, $bold) > $max && $line !== '') {
                    $this->line($line, $size, $bold, $indent, $lead);
                    $line = $word;
                } else {
                    $line = $try;
                }
            }
            if ($line !== '') $this->line($line, $size, $bold, $indent, $lead);
        }
    }

    private function line(string $t, float $size, bool $bold, float $indent, float $lead): void
    {
        $this->room($size * $lead);
        $this->y -= $size * $lead;
        $this->buf .= sprintf("BT /%s %.1f Tf 0 0 0 rg %.2f %.2f Td (%s) Tj ET\n",
            $bold ? 'F2' : 'F1', $size, self::ML + $indent, $this->y, $this->esc($t));
    }

    public function heading(string $t, float $size = 12.0, float $space = 14.0): void
    {
        $this->room($size * 2.6);
        $this->y -= $space;
        $this->buf .= sprintf("BT /F2 %.1f Tf 0.85 0.48 0.06 rg %.2f %.2f Td (%s) Tj ET\n",
            $size, self::ML, $this->y - $size, $this->esc($t));
        $this->y -= $size * 1.25;
    }

    public function title(string $t, string $sub = ''): void
    {
        $this->y -= 6;
        $w = $this->width($t, 19, true);
        $this->buf .= sprintf("BT /F2 19 Tf 0.85 0.48 0.06 rg %.2f %.2f Td (%s) Tj ET\n",
            (self::W - $w) / 2, $this->y - 19, $this->esc($t));
        $this->y -= 26;
        if ($sub !== '') {
            $w = $this->width($sub, 9.5, false);
            $this->buf .= sprintf("BT /F1 9.5 Tf 0.36 0.42 0.52 rg %.2f %.2f Td (%s) Tj ET\n",
                (self::W - $w) / 2, $this->y - 10, $this->esc($sub));
            $this->y -= 16;
        }
        $this->rule();
    }

    public function rule(): void
    {
        $this->y -= 8;
        $this->buf .= sprintf("0.85 0.48 0.06 RG 1.1 w %.2f %.2f m %.2f %.2f l S\n",
            self::ML, $this->y, self::W - self::MR, $this->y);
        $this->y -= 6;
    }

    /** Label on the left, value on the right of a fixed column. */
    public function row(string $label, string $value, float $size = 10.0): void
    {
        $this->room($size * 1.7);
        $this->y -= $size * 1.55;
        $this->buf .= sprintf("BT /F1 %.1f Tf 0.36 0.42 0.52 rg %.2f %.2f Td (%s) Tj ET\n",
            $size, self::ML, $this->y, $this->esc($label));
        $col = self::ML + 150;
        $max = self::W - self::MR - $col;
        $val = $value;
        while ($this->width($val, $size, true) > $max && strlen($val) > 4) {
            $val = substr($val, 0, -2);
        }
        if ($val !== $value) $val = rtrim($val) . '...';
        $this->buf .= sprintf("BT /F2 %.1f Tf 0 0 0 rg %.2f %.2f Td (%s) Tj ET\n",
            $size, $col, $this->y, $this->esc($val));
    }

    public function bullet(string $t, float $size = 10.0): void
    {
        $this->room($size * 1.5);
        $y0 = $this->y - $size * 1.45;
        $this->buf .= sprintf("BT /F1 %.1f Tf 0 0 0 rg %.2f %.2f Td (-) Tj ET\n",
            $size, self::ML + 6, $y0);
        $this->text($t, $size, false, 20.0);
    }

    public function space(float $pt = 10.0): void { $this->y -= $pt; }

    /** Draw a signature image is out of scope; name and timestamp carry the record. */
    public function signature(string $role, string $name, string $when): void
    {
        $this->room(58);
        $this->y -= 26;
        $this->buf .= sprintf("0.72 0.78 0.87 RG 0.8 w %.2f %.2f m %.2f %.2f l S\n",
            self::ML, $this->y, self::ML + 210, $this->y);
        $this->y -= 12;
        $this->buf .= sprintf("BT /F2 9.5 Tf 0 0 0 rg %.2f %.2f Td (%s) Tj ET\n",
            self::ML, $this->y, $this->esc($name));
        $this->y -= 12;
        $this->buf .= sprintf("BT /F1 8.5 Tf 0.36 0.42 0.52 rg %.2f %.2f Td (%s) Tj ET\n",
            self::ML, $this->y, $this->esc($role . ($when ? '  signed ' . $when : '')));
    }

    public function output(): string
    {
        $this->pages[] = $this->buf;
        $foot = $this->meta['footer'];
        $n = count($this->pages);

        $objs = [];
        $objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
        $kids = [];
        $first = 4;
        for ($i = 0; $i < $n; $i++) $kids[] = ($first + $i * 2) . ' 0 R';
        $objs[2] = "<< /Type /Pages /Count $n /Kids [" . implode(' ', $kids) . "] >>";
        $objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

        $fontBold = $first + $n * 2;
        foreach ($this->pages as $i => $content) {
            if ($foot !== '') {
                $content .= sprintf("BT /F1 7.5 Tf 0.55 0.6 0.68 rg %.2f %.2f Td (%s) Tj ET\n",
                    self::ML, 38.0, $this->esc($foot . '   Page ' . ($i + 1) . ' of ' . $n));
            }
            $pno = $first + $i * 2;
            $objs[$pno] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " . self::W . " " . self::H . "] "
                . "/Resources << /Font << /F1 3 0 R /F2 $fontBold 0 R >> >> /Contents " . ($pno + 1) . " 0 R >>";
            $objs[$pno + 1] = "<< /Length " . strlen($content) . " >>\nstream\n" . $content . "endstream";
        }
        $objs[$fontBold] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
        $objs[$fontBold + 1] = "<< /Title (" . $this->esc($this->meta['title']) . ") /Producer (Ligcabho Le'Africa Residences) >>";

        ksort($objs);
        $out = "%PDF-1.4\n";
        $offsets = [];
        foreach ($objs as $num => $body) {
            $offsets[$num] = strlen($out);
            $out .= "$num 0 obj\n$body\nendobj\n";
        }
        $max = max(array_keys($objs));
        $xref = strlen($out);
        $out .= "xref\n0 " . ($max + 1) . "\n0000000000 65535 f \n";
        for ($i = 1; $i <= $max; $i++) {
            $out .= isset($offsets[$i]) ? sprintf("%010d 00000 n \n", $offsets[$i]) : "0000000000 65535 f \n";
        }
        $out .= "trailer\n<< /Size " . ($max + 1) . " /Root 1 0 R /Info " . ($fontBold + 1) . " 0 R >>\n"
              . "startxref\n$xref\n%%EOF";
        return $out;
    }
}
