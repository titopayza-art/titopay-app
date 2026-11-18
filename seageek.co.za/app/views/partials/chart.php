<?php
/** @var array $series day => ['count'=>int,'amount'=>float]; $metric = 'count'|'amount' */
$metric ??= 'count';
$vals = array_map(fn($d) => (float) $d[$metric], $series);
$max = max(1, max($vals ?: [1]));
$w = 720; $h = 180; $pad = 24; $n = max(1, count($vals) - 1);
$pts = [];
$i = 0;
foreach ($vals as $v) { $pts[] = [round($pad + ($w - 2 * $pad) * $i / $n, 1), round($h - $pad - ($h - 2 * $pad) * $v / $max, 1)]; $i++; }
$line = implode(' ', array_map(fn($p) => $p[0] . ',' . $p[1], $pts));
$area = 'M' . $pts[0][0] . ',' . ($h - $pad) . ' L' . $line . ' L' . end($pts)[0] . ',' . ($h - $pad) . ' Z';
$days = array_keys($series);
?>
<svg class="chart" viewBox="0 0 <?= $w ?> <?= $h ?>" preserveAspectRatio="none" role="img" aria-label="<?= $metric === 'amount' ? 'Spend' : 'Requests' ?> per day, last <?= count($series) ?> days">
  <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fe3cf" stop-opacity=".28"/><stop offset="1" stop-color="#5fe3cf" stop-opacity="0"/></linearGradient></defs>
  <?php for ($g = 0; $g <= 3; $g++): $y = $pad + ($h - 2 * $pad) * $g / 3; ?><line class="grid-l" x1="<?= $pad ?>" x2="<?= $w - $pad ?>" y1="<?= $y ?>" y2="<?= $y ?>"/><?php endfor; ?>
  <path class="area" d="<?= $area ?>"/>
  <polyline class="line" points="<?= $line ?>"/>
  <text x="<?= $pad ?>" y="<?= $h - 6 ?>"><?= e(date('j M', strtotime($days[0]))) ?></text>
  <text x="<?= $w - $pad ?>" y="<?= $h - 6 ?>" text-anchor="end"><?= e(date('j M', strtotime(end($days)))) ?></text>
  <text x="<?= $pad ?>" y="<?= $pad - 8 ?>"><?= $metric === 'amount' ? zar($max) : number_format($max) ?> peak</text>
</svg>
