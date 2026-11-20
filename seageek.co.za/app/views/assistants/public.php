<div class="pub-asst">
  <div class="pub-head"><span class="asst-av" style="--c:<?= e($a['color']) ?>"><?= e(mb_strtoupper(mb_substr($a['name'], 0, 1))) ?></span><div><b><?= e($a['name']) ?></b><small><?= e($org['name']) ?></small></div></div>
  <div class="pub-log" id="pub-log" aria-live="polite"><div class="amsg ai"><div class="abody"><p>Hello. Ask me anything about <?= e($org['name']) ?>.</p></div></div></div>
  <form class="pub-form" id="pub-form" data-url="/a/<?= e($a['share_token']) ?>"><?= csrf_field() ?><textarea name="message" rows="2" placeholder="Type your question" aria-label="Your question" required></textarea><button class="btn btn-primary btn-sm">Send</button></form>
  <p class="muted small" style="margin-top:8px">Answers come from <?= e($org['name']) ?>'s documents and can be wrong. Do not share passwords or card numbers.</p>
  <?php $poweredRef = 'assistant'; require APP_DIR . '/views/partials/powered.php'; ?>
</div>
<script src="/assets/js/assistant.js?v=1" defer></script>
