<?php $o = $old; $approved = array_values(array_filter($tpls, fn($t) => $t['status'] === 'approved')); ?>
<div class="grid" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);align-items:start" id="wat-grid">
  <div class="stack">
    <form method="post" class="panel form" id="builder"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <div class="panel-head" style="margin-bottom:4px"><h2>New message template</h2><span class="muted small">Approved by WhatsApp first</span></div>
      <p class="muted small">Templates are the messages you can send at any time, such as order updates, booking reminders or one-time codes. WhatsApp checks each one before it can be used. Use <code>{{1}}</code>, <code>{{2}}</code> and so on for values that change for each customer.</p>
      <div class="row"><div class="field"><label for="w-name">Name</label><input id="w-name" name="name" value="<?= e($o['name'] ?? '') ?>" placeholder="order_ready" maxlength="60" required></div>
        <div class="field"><label for="w-cat">Category</label><select id="w-cat" name="category"><?php foreach (WaTemplates::CATEGORIES as $k => $l): ?><option value="<?= $k ?>" <?= ($o['category'] ?? 'utility') === $k ? 'selected' : '' ?>><?= e($l) ?></option><?php endforeach; ?></select></div></div>
      <div class="row"><div class="field"><label for="w-lang">Language</label><select id="w-lang" name="language"><?php foreach (WaTemplates::LANGUAGES as $k => $l): ?><option value="<?= $k ?>" <?= ($o['language'] ?? 'en_ZA') === $k ? 'selected' : '' ?>><?= e($l) ?></option><?php endforeach; ?></select></div>
        <div class="field"><label for="w-ht">Heading</label><select id="w-ht" name="header_type"><option value="none">No heading</option><option value="text" <?= ($o['header_type'] ?? '') === 'text' ? 'selected' : '' ?>>Text heading</option></select></div></div>
      <div class="field"><label for="w-htext">Heading text <span class="muted">(optional, no values)</span></label><input id="w-htext" name="header_text" maxlength="60" value="<?= e($o['header_text'] ?? '') ?>" placeholder="Order update"></div>
      <div class="field"><label for="w-body">Message</label><textarea id="w-body" name="body" rows="5" maxlength="1024" required placeholder="Hi {{1}}, your order {{2}} is ready for collection."><?= e($o['body'] ?? '') ?></textarea></div>
      <div class="row">
        <?php for ($i = 1; $i <= 3; $i++): ?><div class="field"><label for="w-s<?= $i ?>">Example for {{<?= $i ?>}}</label><input id="w-s<?= $i ?>" name="samples[]" value="<?= e($o['samples'][$i - 1] ?? '') ?>" placeholder="Thandi"></div><?php endfor; ?>
      </div>
      <div class="field"><label for="w-foot">Footer <span class="muted">(optional)</span></label><input id="w-foot" name="footer" maxlength="60" value="<?= e($o['footer'] ?? '') ?>" placeholder="Reply STOP to opt out"></div>
      <fieldset class="field" style="border:0;padding:0;margin:0"><legend>Buttons <span class="muted small">(up to 3)</span></legend>
        <?php for ($i = 0; $i < 3; $i++): $bt = $o['btn_type'][$i] ?? ''; ?>
        <div class="row" style="margin-bottom:8px"><div class="field" style="max-width:150px"><select name="btn_type[<?= $i ?>]" aria-label="Button <?= $i + 1 ?> type"><option value="">No button</option><option value="url" <?= $bt === 'url' ? 'selected' : '' ?>>Website</option><option value="phone" <?= $bt === 'phone' ? 'selected' : '' ?>>Phone call</option><option value="quick" <?= $bt === 'quick' ? 'selected' : '' ?>>Quick reply</option></select></div>
          <div class="field"><input name="btn_text[<?= $i ?>]" maxlength="25" value="<?= e($o['btn_text'][$i] ?? '') ?>" placeholder="Button text" aria-label="Button <?= $i + 1 ?> text"></div>
          <div class="field"><input name="btn_url[<?= $i ?>]" value="<?= e($o['btn_url'][$i] ?? '') ?>" placeholder="https://yourbusiness.co.za/track/{{1}}" aria-label="Button <?= $i + 1 ?> link"></div>
          <div class="field"><input name="btn_phone[<?= $i ?>]" value="<?= e($o['btn_phone'][$i] ?? '') ?>" placeholder="082 123 4567" aria-label="Button <?= $i + 1 ?> number"></div></div>
        <?php endfor; ?>
      </fieldset>
      <button class="btn btn-primary btn-sm">Save template</button>
    </form>
    <div class="panel flush" id="tpl-list"><div class="panel-head"><h2>Your templates</h2><span class="muted small"><?= count($tpls) ?></span></div>
      <?php if (!$tpls): ?><div class="empty">No templates yet. Write your first one above.</div><?php else: ?>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Template</th><th>Category</th><th>Status</th><th></th></tr></thead><tbody>
      <?php foreach ($tpls as $t): $st = ['draft' => ['', 'Draft'], 'pending' => ['amber', 'Waiting for approval'], 'approved' => ['green', 'Approved'], 'rejected' => ['red', 'Not approved']][$t['status']] ?? ['', $t['status']]; ?>
        <tr><td><b class="mono small"><?= e($t['name']) ?></b><div class="muted small"><?= e(mb_strimwidth($t['body'], 0, 80, '…')) ?></div></td><td class="small"><?= e(ucfirst($t['category'])) ?> · <?= e($t['language']) ?></td>
        <td><span class="pill <?= $st[0] ?>"><?= $st[1] ?></span></td>
        <td class="right nowrap"><?php if ($t['status'] === 'draft'): ?><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="submit"><input type="hidden" name="id" value="<?= (int) $t['id'] ?>"><button class="btn btn-ghost btn-xs">Submit for approval</button></form><?php endif; ?>
        <?php if ($t['status'] !== 'approved'): ?><form method="post" class="inline-form" data-confirm="Delete this template?"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?= (int) $t['id'] ?>"><button class="btn btn-danger btn-xs">Delete</button></form><?php endif; ?></td></tr>
      <?php endforeach; ?></tbody></table></div><?php endif; ?>
    </div>
  </div>
  <div class="stack">
    <div class="panel wa-preview" aria-label="Preview of the message on a phone">
      <h2>Preview</h2>
      <div class="wa-phone"><div class="wa-bar"><?= e($wa['display_name'] ?? ($org['name'] ?? 'Your business')) ?></div>
        <div class="wa-chat"><div class="wa-bub" id="pv">
          <div class="wa-head" id="pv-head" hidden></div>
          <div class="wa-body" id="pv-body">Your message appears here.</div>
          <div class="wa-foot" id="pv-foot" hidden></div>
          <div class="wa-btns" id="pv-btns"></div>
        </div></div></div>
      <p class="muted small" style="margin-top:10px">Shown with the examples you enter. Customers see the real values.</p>
    </div>
    <form method="post" class="panel form" id="test"><?= csrf_field() ?><input type="hidden" name="action" value="send">
      <h2>Send a test</h2>
      <?php if (!$approved): ?><p class="muted small">Send a test once a template is approved.</p>
      <?php else: ?>
      <div class="field"><label for="t-id">Template</label><select id="t-id" name="id"><?php foreach ($approved as $t): ?><option value="<?= (int) $t['id'] ?>"><?= e($t['name']) ?> (<?= e($t['language']) ?>)</option><?php endforeach; ?></select></div>
      <div class="field"><label for="t-to">Mobile number</label><input id="t-to" name="to" inputmode="tel" placeholder="082 123 4567" required></div>
      <div class="row"><?php for ($i = 1; $i <= 3; $i++): ?><div class="field"><label for="t-v<?= $i ?>">Value {{<?= $i ?>}}</label><input id="t-v<?= $i ?>" name="values[]"></div><?php endfor; ?></div>
      <div class="field"><label for="t-bv">Value at the end of a website button link <span class="muted">(if the button has one)</span></label><input id="t-bv" name="button_value"></div>
      <button class="btn btn-ghost btn-sm">Send test</button>
      <p class="muted small">Until your WhatsApp connection is live, tests run in the sandbox: nothing is delivered and nothing is charged.<?= $wa ? '' : ' No WhatsApp number is connected yet.' ?></p>
      <?php endif; ?>
    </form>
  </div>
</div>
<style>
.wa-phone { background:#0b141a; border-radius:26px; padding:10px; max-width:300px; margin:12px auto 0; }
.wa-bar { color:#e9edef; font-size:13px; font-weight:600; padding:6px 10px 10px; }
.wa-chat { background:#efeae2; border-radius:18px; padding:14px 10px; min-height:220px; }
.wa-bub { background:#fff; color:#111; border-radius:10px 10px 10px 2px; padding:8px 10px 6px; max-width:100%; box-shadow:0 1px 1px rgba(0,0,0,.12); font-size:14px; line-height:1.45; }
.wa-head { font-weight:700; margin-bottom:4px; } .wa-foot { color:#8696a0; font-size:12px; margin-top:6px; }
.wa-btns { margin:8px -10px -6px; border-top:1px solid #e9edef; } .wa-btns span { display:block; text-align:center; padding:9px; color:#027eb5; font-weight:600; border-top:1px solid #e9edef; font-size:13.5px; }
.wa-bub .var { background:#fff3c4; border-radius:3px; padding:0 2px; }
@media (max-width:980px){ #wat-grid { grid-template-columns:1fr !important; } }
</style>
<script>
(function(){
  var body=document.getElementById('w-body'); if(!body) return;
  function esc(s){var d=document.createElement('div'); d.textContent=s; return d.innerHTML;}
  function fill(text){ var s=[1,2,3].map(function(i){var v=document.getElementById('w-s'+i); return v&&v.value?v.value:'{{'+i+'}}';}); return esc(text).replace(/\{\{(\d)\}\}/g,function(m,n){return '<span class="var">'+esc(s[n-1]||m)+'</span>';}); }
  function update(){
    var ht=document.getElementById('w-ht').value==='text'; var h=document.getElementById('w-htext').value;
    var head=document.getElementById('pv-head'); head.hidden=!(ht&&h); head.textContent=h;
    document.getElementById('pv-body').innerHTML=body.value?fill(body.value):'Your message appears here.';
    var f=document.querySelector('[name=footer]').value; var foot=document.getElementById('pv-foot'); foot.hidden=!f; foot.textContent=f;
    var btns=''; for(var i=0;i<3;i++){ var t=document.querySelector('[name="btn_text['+i+']"]').value; if(t) btns+='<span>'+esc(t)+'</span>'; }
    document.getElementById('pv-btns').innerHTML=btns;
  }
  document.querySelectorAll('#builder input, #builder textarea, #builder select').forEach(function(el){ el.addEventListener('input', update); el.addEventListener('change', update); });
  update();
})();
</script>
