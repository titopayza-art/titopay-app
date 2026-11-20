<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="chat-grid">
  <div class="stack">
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="chat">
      <div class="panel-head" style="margin-bottom:4px"><h2>Website chat</h2><span class="price-tag">Included</span></div>
      <p class="muted small">A chat button for your website. SeaGeek AI answers from your help centre articles straight away. When it cannot help, or the customer asks for a person, the chat moves to your Desk inbox and your team replies there.</p>
      <div class="row">
        <div class="field"><label for="c-title">Button text</label><input id="c-title" name="title" value="<?= e($s['title']) ?>" maxlength="40"></div>
        <div class="field"><label for="c-color">Colour</label><div class="color-row"><input id="c-color" name="color" type="color" value="<?= e($s['color']) ?>"><span class="muted small">Match your brand</span></div></div>
      </div>
      <div class="field"><label for="c-greet">First message <span class="muted">(optional)</span></label><input id="c-greet" name="greeting" value="<?= e($s['greeting']) ?>" maxlength="240" placeholder="Hi! Ask us about orders, delivery or opening hours."></div>
      <button class="btn btn-primary btn-sm">Save</button>
    </form>
    <div class="panel">
      <h2>Add it to your website</h2>
      <p class="muted small">Paste this line just before <code>&lt;/body&gt;</code> on every page. On WordPress, use a plugin such as "Insert Headers and Footers". On Wix or Shopify, paste it into the custom code or theme footer section.</p>
      <div class="snippet-head"><span class="snippet-label">Your chat snippet</span><button class="copy-btn" type="button" data-copy="chat-snip">Copy</button></div>
      <pre class="snippet" id="chat-snip"><?= e(Plugins::chatSnippet($org)) ?></pre>
      <p class="muted small" style="margin-top:12px"><?= number_format($chats) ?> chat<?= $chats === 1 ? '' : 's' ?> in the last 30 days. <a class="link" href="/dashboard/desk">Open Desk</a> · <a class="link" href="/dashboard/help-centre">Edit help articles</a></p>
    </div>
  </div>
  <div class="stack">
    <form method="post" class="panel form" id="whatsapp"><?= csrf_field() ?><input type="hidden" name="action" value="whatsapp">
      <div class="panel-head" style="margin-bottom:4px"><h2>WhatsApp button</h2><span class="price-tag">Free</span></div>
      <p class="muted small">A green "Chat on WhatsApp" button that opens a chat with your business number in WhatsApp on the visitor's phone or computer. Messages go to your own WhatsApp, not through SeaGeek.</p>
      <div class="field"><label for="w-num">Your WhatsApp number</label><input id="w-num" name="wa_number" value="<?= e($s['wa_number'] ? '+' . $s['wa_number'] : '') ?>" inputmode="tel" placeholder="082 123 4567"></div>
      <div class="row">
        <div class="field"><label for="w-label">Button text</label><input id="w-label" name="wa_label" value="<?= e($s['wa_label']) ?>" maxlength="40"></div>
        <div class="field"><label for="w-text">Message they start with <span class="muted">(optional)</span></label><input id="w-text" name="wa_text" value="<?= e($s['wa_text']) ?>" maxlength="200" placeholder="Hi, I saw your website"></div>
      </div>
      <button class="btn btn-primary btn-sm">Save</button>
      <?php if ($wa = Plugins::waSnippet($org)): ?>
        <div class="snippet-head" style="margin-top:18px"><span class="snippet-label">Your WhatsApp snippet</span><button class="copy-btn" type="button" data-copy="wa-snip">Copy</button></div>
        <pre class="snippet" id="wa-snip"><?= e($wa) ?></pre>
        <p class="muted small" style="margin-top:8px">Using both? Paste both lines; the WhatsApp button sits above the chat button. <a class="link" href="https://wa.me/<?= e($s['wa_number']) ?>" target="_blank" rel="noopener">Test the link</a></p>
      <?php endif; ?>
    </form>
  </div>
</div>
