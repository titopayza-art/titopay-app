<?php if ($state === 'invalid'): ?>
  <h1 style="font-size:24px;margin-top:18px">This link is not valid</h1>
  <p class="muted" style="margin-top:8px">It may have been copied incompletely. Reply to the email you received and ask to be removed.</p>
<?php elseif ($state === 'done'): ?>
  <h1 style="font-size:24px;margin-top:18px">You are unsubscribed</h1>
  <p class="muted" style="margin-top:8px"><?= e($address) ?> will not get marketing from <?= e($from) ?> again. You may still get messages about orders or your account.</p>
<?php else: ?>
  <h1 style="font-size:24px;margin-top:18px">Unsubscribe</h1>
  <p class="muted" style="margin-top:8px">Stop marketing messages from <b style="color:var(--text)"><?= e($from) ?></b> to <?= e($address) ?>?</p>
  <form method="post" style="margin-top:18px"><button class="btn btn-primary" style="width:100%">Unsubscribe</button></form>
<?php endif; ?>
