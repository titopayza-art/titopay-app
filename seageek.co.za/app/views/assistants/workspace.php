<?php
$base = '/dashboard/assistants/' . $a['public_id'];
$tpl = Assistants::templates()[$a['role']] ?? null;
$card = function (array $x) use ($base, $chat): string {
    $title = $x['kind'] === 'email' ? 'Email to ' . $x['to'] : 'SMS to ' . $x['to'];
    $body = $x['kind'] === 'email' ? '<b>' . e($x['subject']) . '</b><div class="pre">' . e($x['body']) . '</div>' : '<div class="pre">' . e($x['text']) . '</div>';
    $foot = $x['status'] === 'pending'
        ? '<form method="post" action="' . e($base) . '/decide" class="appr-btns" data-decide>' . csrf_field() . '<input type="hidden" name="id" value="' . (int) $x['id'] . '"><input type="hidden" name="chat" value="' . e($chat['public_id'] ?? '') . '"><button class="btn btn-primary btn-xs" name="decision" value="send">Send</button><button class="btn btn-ghost btn-xs" name="decision" value="cancel">Cancel</button></form>'
        : '<span class="appr-state ' . e($x['status']) . '">' . e($x['status'] === 'approved' ? ($x['result'] ?: 'Sent') : 'Cancelled') . '</span>';
    return '<div class="appr" data-appr="' . (int) $x['id'] . '"><div class="appr-head">' . icon($x['kind'] === 'email' ? 'mail' : 'sms') . '<span>' . e($title) . '</span><small>Draft, needs your approval</small></div>' . $body . $foot . '</div>';
};
$starters = match ($a['role']) {
    'projects' => ['Start a project for our website relaunch with tasks for the next two weeks', 'What is late across our projects?', 'Write a status update for the team'],
    'sales' => ['Plan follow-ups for three leads I met this week', 'Draft a friendly follow-up email to a customer who went quiet', 'What follow-ups are due today?'],
    'support' => ['Summarise this week\'s open tickets', 'What are customers asking about most?', 'Draft a reply about delivery times'],
    'research' => ['Summarise the documents I added', 'What do our documents say about pricing?', 'Draft a one-page proposal'],
    'hr' => ['How many leave days do staff get?', 'What is the process for sick leave?', 'Summarise the code of conduct'],
    default => ['What should I focus on today?', 'Remind me tomorrow at 9:00 to call the bank', 'Add a task to send the invoice by Friday'],
};
?>
<div class="asst-top">
  <span class="asst-av" style="--c:<?= e($a['color']) ?>"><?= e(mb_strtoupper(mb_substr($a['name'], 0, 1))) ?></span>
  <div><b><?= e($a['name']) ?></b><small><?= e($tpl[0] ?? 'Assistant') ?> · <?= e(Catalog::aiModel($a['provider'], $a['model'])['label'] ?? $a['model']) ?> · <?= e(Assistants::EFFORT[$a['effort']] ?? '') ?></small></div>
  <div class="asst-top-actions"><a class="btn btn-ghost btn-sm" href="/dashboard/assistants">All assistants</a><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>/settings">Settings and knowledge</a></div>
</div>
<?php if ($new): ?><div class="alert alert-ok"><?= e($a['name']) ?> is ready. Ask it anything below, or add your documents under Settings and knowledge so it knows your business.</div><?php endif; ?>
<div class="asst-layout">
  <aside class="asst-chats">
    <a class="btn btn-ghost btn-sm" href="<?= e($base) ?>?chat=new" style="width:100%;justify-content:center">New conversation</a>
    <nav><?php foreach ($chats as $c): ?><a class="<?= $chat && $chat['id'] === $c['id'] ? 'on' : '' ?>" href="<?= e($base) ?>?chat=<?= e($c['public_id']) ?>"><?= e($c['title']) ?><small><?= e(Ops::ago($c['updated_at'])) ?></small></a><?php endforeach; ?>
    <?php if (!$chats): ?><p class="muted small" style="padding:8px">No conversations yet.</p><?php endif; ?></nav>
  </aside>
  <section class="asst-main">
    <div class="asst-log" id="asst-log" aria-live="polite">
      <?php if (!$msgs): ?>
        <div class="asst-empty"><span class="asst-av big" style="--c:<?= e($a['color']) ?>"><?= e(mb_strtoupper(mb_substr($a['name'], 0, 1))) ?></span><h3>How can I help?</h3>
          <div class="starters"><?php foreach ($starters as $s): ?><button type="button" class="starter" data-starter="<?= e($s) ?>"><?= e($s) ?></button><?php endforeach; ?></div></div>
      <?php endif; ?>
      <?php foreach ($msgs as $m): $acts = $m['actions'] ? json_decode($m['actions'], true) : []; ?>
        <div class="amsg <?= $m['role'] === 'user' ? 'me' : 'ai' ?>">
          <?php if ($m['role'] === 'user'): ?><div class="abody"><?= nl2br(e($m['content'])) ?></div>
          <?php else: ?>
            <?php if (!empty($acts['done'])): ?><div class="adone"><?php foreach ($acts['done'] as $d): ?><span><?= icon('check') ?><?= e($d) ?></span><?php endforeach; ?></div><?php endif; ?>
            <div class="abody"><?= md_lite($m['content']) ?></div>
            <?php foreach ($acts['approvals'] ?? [] as $aid) if (isset($approvals[$aid])) echo $card($approvals[$aid]); ?>
          <?php endif; ?>
        </div>
      <?php endforeach; ?>
    </div>
    <form class="asst-form" id="asst-form" data-send="<?= e($base) ?>/send" data-decide="<?= e($base) ?>/decide" data-chat="<?= e($chat['public_id'] ?? '') ?>" data-new="<?= isset($_GET['chat']) && $_GET['chat'] === 'new' ? '1' : '' ?>"><?= csrf_field() ?>
      <textarea name="message" id="asst-input" rows="1" placeholder="Message <?= e($a['name']) ?>" aria-label="Message <?= e($a['name']) ?>"></textarea>
      <button class="btn btn-primary" aria-label="Send"><?= icon('send') ?></button>
    </form>
    <p class="asst-note muted small">Emails and SMS are only drafts until you press Send. <?= e($a['name']) ?> can make mistakes, so check important details.</p>
  </section>
  <aside class="asst-side">
    <?php if ($pending): ?>
      <div class="panel side-block"><h3>Waiting for you</h3><?php foreach ($pending as $x): $x = ['id' => (int) $x['id'], 'kind' => $x['kind'], 'status' => $x['status'], 'result' => $x['result']] + json_decode($x['payload'], true); ?>
        <p class="small"><?= icon($x['kind'] === 'email' ? 'mail' : 'sms') ?> <?= e($x['kind'] === 'email' ? $x['subject'] : mb_strimwidth($x['text'], 0, 60, '…')) ?> <span class="muted">to <?= e($x['to']) ?></span></p><?php endforeach; ?>
        <p class="muted small">Open the conversation to send or cancel.</p></div>
    <?php endif; ?>
    <?php if ($tasks !== null): ?>
      <div class="panel side-block" id="side-tasks"><div class="side-head"><h3>Open tasks</h3><a class="link small" href="/dashboard/work">Board</a></div>
        <?php if (!$tasks): ?><p class="muted small">No open tasks. Ask <?= e($a['name']) ?> to add some.</p><?php endif; ?>
        <ul class="side-tasks"><?php foreach ($tasks as $t): $late = $t['due_on'] && $t['due_on'] < gmdate('Y-m-d', time() + 7200); ?>
          <li><label class="consent"><input type="checkbox" data-task="<?= (int) $t['id'] ?>"><span><?= e($t['title']) ?><small class="<?= $late ? 'warn' : 'muted' ?>">#<?= (int) $t['id'] ?><?= $t['due_on'] ? ' · ' . ($late ? 'late, ' : 'due ') . e(date('j M', strtotime($t['due_on']))) : '' ?><?= $t['project'] ? ' · ' . e($t['project']) : '' ?></small></span></label></li>
        <?php endforeach; ?></ul></div>
    <?php endif; ?>
    <?php if ($reminders): ?>
      <div class="panel side-block"><h3>Reminders</h3><?php foreach ($reminders as $rm): ?><p class="small"><span class="muted"><?= e(gmdate('D j M H:i', strtotime($rm['due_at'] . ' UTC') + 7200)) ?></span><br><?= e($rm['message']) ?></p><?php endforeach; ?></div>
    <?php endif; ?>
    <?php if ($memory !== null): ?>
      <div class="panel side-block"><div class="side-head"><h3>Remembers</h3><a class="link small" href="<?= e($base) ?>/settings#memory">Edit</a></div>
        <?php if (!$memory): ?><p class="muted small">Tell it things to remember, like "My manager is Thabo".</p><?php endif; ?>
        <?php foreach ($memory as $mm): ?><p class="small mem"><?= e($mm['fact']) ?></p><?php endforeach; ?></div>
    <?php endif; ?>
    <div class="panel side-block"><div class="side-head"><h3>Knowledge</h3><a class="link small" href="<?= e($base) ?>/settings#knowledge">Add</a></div><p class="muted small"><?= $docs ? $docs . ' document' . ($docs === 1 ? '' : 's') : 'No documents yet. Add your price list, policies or project notes.' ?></p></div>
  </aside>
</div>
<script src="/assets/js/assistant.js?v=1" defer></script>
