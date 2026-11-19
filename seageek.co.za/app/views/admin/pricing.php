<form method="post"><?= csrf_field() ?>
<div class="panel flush">
  <div class="panel-head"><h2>Plans</h2><span class="muted">Limits are enforced on every API and AI request</span></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Plan</th><th>Price (R/mo)</th><th>Included credit</th><th>Usage discount %</th><th>AI cap (R/mo)</th><th>AI max tokens</th><th>AI req/min</th><th>API req/s</th><th>Desk seats</th><th>WA numbers</th><th>Active</th></tr></thead><tbody>
  <?php foreach ($plans as $p): $n = 'plan[' . e($p['code']) . ']'; ?><tr><td><b><?= e($p['name']) ?></b></td>
    <?php foreach (['price', 'included_credit', 'discount_pct', 'ai_monthly_cap', 'ai_max_tokens', 'ai_rpm', 'api_rps', 'desk_agents', 'wa_numbers'] as $c): ?><td><input name="<?= $n ?>[<?= $c ?>]" type="number" step="any" value="<?= (float) $p[$c] ?>" style="width:72px;height:34px;border-radius:6px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);padding:0 8px"></td><?php endforeach; ?>
    <td><input type="checkbox" name="<?= $n ?>[active]" value="1" <?= $p['active'] ? 'checked' : '' ?>></td></tr><?php endforeach; ?>
  </tbody></table></div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Usage rates</h2><span class="muted">Selling price and your wholesale cost, excl. VAT. Margin updates as you type.</span></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Unit</th><th>Product</th><th>Sell (R)</th><th>Cost (R)</th><th class="right">Margin</th></tr></thead><tbody>
  <?php foreach ($rates as $r): $m = (float) $r['price'] > 0 ? round(((float) $r['price'] - (float) $r['cost']) / (float) $r['price'] * 100) : 0; ?><tr data-margin><td><?= e($r['label']) ?><div class="muted small"><?= e($r['per']) ?></div></td><td class="small"><?= e(service_names()[$r['service']] ?? $r['service']) ?></td>
    <td><input name="rate[<?= e($r['unit']) ?>][price]" type="number" step="0.0001" value="<?= (float) $r['price'] ?>" style="width:110px;height:34px;border-radius:6px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);padding:0 8px"></td>
    <td><input name="rate[<?= e($r['unit']) ?>][cost]" type="number" step="0.0001" value="<?= (float) $r['cost'] ?>" style="width:110px;height:34px;border-radius:6px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);padding:0 8px"></td>
    <td class="right mono small" data-out><?= $m ?>%</td></tr><?php endforeach; ?>
  </tbody></table></div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Packages</h2><span class="muted">Prepaid bundles customers can add to an order. Credit above the price is the bonus.</span></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Package</th><th>Product</th><th>Price (R)</th><th>Credit given (R)</th><th class="right">Bonus</th><th>Active</th></tr></thead><tbody>
  <?php foreach ($packages as $p): $n = 'pkg[' . e($p['code']) . ']'; $bonus = (float) $p['price'] > 0 ? round(((float) $p['credit'] - (float) $p['price']) / (float) $p['price'] * 100, 1) : 0; ?><tr><td><?= e($p['name']) ?><div class="muted small"><?= e($p['description']) ?></div></td><td class="small"><?= e(service_names()[$p['service']] ?? $p['service']) ?></td>
    <td><input class="mini-input" name="<?= $n ?>[price]" type="number" step="0.01" value="<?= (float) $p['price'] ?>"></td>
    <td><input class="mini-input" name="<?= $n ?>[credit]" type="number" step="0.01" value="<?= (float) $p['credit'] ?>"></td>
    <td class="right mono small"><?= $bonus > 0 ? '+' . $bonus . '%' : '–' ?></td>
    <td><input type="hidden" name="<?= $n ?>[active]" value="0"><input type="checkbox" name="<?= $n ?>[active]" value="1" <?= $p['active'] ? 'checked' : '' ?> aria-label="Active"></td></tr><?php endforeach; ?>
  </tbody></table></div>
</div>
<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>AI pricing</h2><span class="muted">Customer price = provider USD price × exchange rate × (1 + markup)</span></div>
  <div class="toolbar"><label class="small muted">USD/ZAR <input name="usd_zar" type="number" step="0.01" value="<?= e(Settings::get('usd_zar')) ?>" style="width:100px"></label><label class="small muted">Markup % <input name="ai_markup_pct" type="number" step="1" value="<?= e(Settings::get('ai_markup_pct')) ?>" style="width:80px"></label></div>
  <table class="tbl"><thead><tr><th>Model</th><th class="right">Input / M tokens</th><th class="right">Output / M tokens</th></tr></thead><tbody><?php foreach ($models as $m): $p = Catalog::aiPrice($m); ?><tr><td><?= e($m['label']) ?> <span class="muted small"><?= e($m['model']) ?></span></td><td class="right mono small"><?= zar($p['in']) ?></td><td class="right mono small"><?= zar($p['out']) ?></td></tr><?php endforeach; ?></tbody></table>
</div>
<div style="margin-top:14px"><button class="btn btn-primary">Save pricing</button></div>
</form>
