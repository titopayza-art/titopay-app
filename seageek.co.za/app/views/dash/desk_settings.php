<?php $m = $s['mail']; $deskBase = $base . '/desk'; ?>
<div class="toolbar"><a class="btn btn-ghost btn-sm" href="<?= e($deskBase) ?>">Back to tickets</a><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>/desk-reports">Reports</a><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>/help-centre">Help centre and saved replies</a></div>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="ds-grid">
  <div class="stack">
    <form method="post" class="panel form" id="email"><?= csrf_field() ?><input type="hidden" name="action" value="mail">
      <div class="panel-head" style="margin-bottom:4px"><h2>Email</h2><span class="pill <?= $m['mode'] === 'pop3' && !$m['last_error'] ? 'green' : ($m['last_error'] ? 'red' : '') ?>"><?= $m['mode'] === 'pop3' ? ($m['last_error'] ? 'Problem' : 'Connected') : 'Off' ?></span></div>
      <p class="muted small">Connect the mailbox customers already write to, such as help@yourbusiness.co.za. Every new email becomes a ticket, replies join the right conversation, attachments come through, and the AI answers first. Your replies go out by email and customers simply reply.</p>
      <div class="field"><label for="ds-mode">Import email</label><select id="ds-mode" name="mode"><option value="none">Off</option><option value="pop3" <?= $m['mode'] === 'pop3' ? 'selected' : '' ?>>From a mailbox (POP3)</option></select></div>
      <div class="field"><label for="ds-addr">Support email address</label><input id="ds-addr" name="address" type="email" value="<?= e($m['address']) ?>" placeholder="help@yourbusiness.co.za"></div>
      <div class="row"><div class="field"><label for="ds-host">Mail server</label><input id="ds-host" name="host" value="<?= e($m['host']) ?>" placeholder="mail.yourbusiness.co.za"></div>
        <div class="field" style="max-width:110px"><label for="ds-port">Port</label><input id="ds-port" name="port" value="<?= (int) $m['port'] ?>" inputmode="numeric"></div>
        <div class="field" style="max-width:150px"><label for="ds-ssl">Security</label><select id="ds-ssl" name="ssl"><option value="1">SSL (995)</option><option value="0" <?= !$m['ssl'] ? 'selected' : '' ?>>None (110)</option></select></div></div>
      <div class="row"><div class="field"><label for="ds-user">Username</label><input id="ds-user" name="user" value="<?= e($m['user']) ?>" autocomplete="off"></div>
        <div class="field"><label for="ds-pass">Password</label><input id="ds-pass" name="pass" type="password" placeholder="<?= $m['pass_enc'] ? 'Saved (leave blank to keep)' : '' ?>" autocomplete="new-password"></div></div>
      <button class="btn btn-primary btn-sm">Save and test</button>
      <p class="muted small">Your host's email settings page lists the POP3 server (Afrihost, Hetzner, xneelo, cPanel, Microsoft 365 and Google Workspace all offer it). Emails stay in the mailbox; SeaGeek only reads new ones.
      <?php if ($m['mode'] === 'pop3'): ?><br>Last checked: <?= $m['last_check'] ? e(Ops::ago($m['last_check'])) : 'not yet' ?> · <?= (int) $m['imported'] ?> emails imported<?= $m['last_error'] ? ' · <span class="warn">' . e($m['last_error']) . '</span>' : '' ?><?php endif; ?></p>
      <details class="more"><summary>Using Amazon SES, Postmark, Mailgun, SendGrid or Cloudflare instead?</summary>
        <p class="muted small">Have the service forward incoming mail to this address. Raw emails and each service's own format both work.</p>
        <div class="secret" style="font-size:12.5px"><span id="fwd"><?= e($forward) ?></span><button class="copy-btn" type="button" data-copy="fwd">Copy</button></div>
      </details>
      <p class="muted small">Customers' replies go to: <b style="color:var(--text)"><?= e($replyTo) ?></b></p>
    </form>
    <form method="post" class="panel form" id="autoclose"><?= csrf_field() ?><input type="hidden" name="action" value="autoclose">
      <h2>Tidy up automatically</h2>
      <div class="field"><label for="ds-ac">When you are waiting on the customer, mark the ticket solved after</label><select id="ds-ac" name="autoclose_days"><?php foreach ([0 => 'Never', 2 => '2 days', 3 => '3 days', 5 => '5 days', 7 => '7 days', 14 => '14 days'] as $k => $l): ?><option value="<?= $k ?>" <?= (int) $s['autoclose_days'] === $k ? 'selected' : '' ?>><?= $l ?></option><?php endforeach; ?></select></div>
      <p class="muted small">The customer is told, and any reply opens the ticket again. Solved tickets close for good 7 days later; a reply after that starts a follow-up ticket.</p>
      <button class="btn btn-ghost btn-sm">Save</button>
    </form>
  </div>
  <div class="stack">
    <div class="panel">
      <h2>Channels</h2>
      <ul class="channels">
        <li><span class="dot up"></span><div><b>Website chat</b><small>Answered by SeaGeek AI, then your team. <a class="link" href="<?= $org['is_house'] ? '/' : '/dashboard/chat' ?>"><?= $org['is_house'] ? 'On seageek.co.za' : 'Get the code' ?></a></small></div></li>
        <li><span class="dot <?= $m['mode'] === 'pop3' && !$m['last_error'] ? 'up' : 'off' ?>"></span><div><b>Email</b><small><?= $m['mode'] === 'pop3' ? e($m['address']) : 'Connect your mailbox on the left' ?></small></div></li>
        <li><span class="dot <?= array_filter($wa, fn($w) => $w['status'] === 'active') ? 'up' : 'off' ?>"></span><div><b>WhatsApp</b><small><?= $wa ? e(implode(', ', array_map(fn($w) => $w['phone'] . ' (' . $w['status'] . ')', $wa))) . '. Messages open tickets; your replies go back on WhatsApp.' : 'No WhatsApp number connected yet.' ?></small></div></li>
        <li><span class="dot up"></span><div><b>Website forms and help centre</b><small>Contact forms, <a class="link" href="<?= $org['is_house'] ? '/help' : '/h/' . e($org['slug']) ?>">help centre</a> requests and the Desk API</small></div></li>
      </ul>
    </div>
    <div class="panel flush" id="rules">
      <div class="panel-head"><h2>Rules</h2><span class="muted small">Run in order on every ticket</span></div>
      <?php if (!$rules): ?><div class="empty" style="padding:18px">No rules yet. Example: if the subject or message mentions "refund", make it urgent and assign it to you.</div><?php else: ?>
      <div class="tbl-wrap"><table class="tbl"><tbody>
        <?php foreach ($rules as $ru): ?><tr<?= $ru['active'] ? '' : ' class="dim"' ?>>
          <td><b><?= e($ru['name']) ?></b><div class="muted small"><?= $ru['event'] === 'replied' ? 'When the customer replies' : 'When a ticket arrives' ?><?= $ru['channel'] ? ' by ' . e(channel_label($ru['channel'])) : '' ?><?= $ru['words'] ? ' and it mentions ' . e($ru['words']) : '' ?></div>
            <div class="small"><?= e(implode(', ', array_filter([$ru['set_priority'] ? 'priority ' . $ru['set_priority'] : null, $ru['set_status'] === 'person' ? 'skip the AI' : ($ru['set_status'] ? 'status ' . $ru['set_status'] : null), $ru['assign_to'] ? 'assign to ' . (array_column($agents, 'name', 'id')[$ru['assign_to']] ?? 'someone') : null, $ru['add_tag'] ? 'tag ' . $ru['add_tag'] : null, $ru['reply_macro'] ? 'send "' . (array_column($macros, 'title', 'id')[$ru['reply_macro']] ?? 'saved reply') . '"' : null]))) ?></div></td>
          <td class="right small muted nowrap"><?= (int) $ru['hits'] ?> times</td>
          <td class="right nowrap"><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="rule_toggle"><input type="hidden" name="id" value="<?= (int) $ru['id'] ?>"><button class="btn btn-ghost btn-xs"><?= $ru['active'] ? 'Pause' : 'Resume' ?></button></form>
            <form method="post" class="inline-form" data-confirm="Delete this rule?"><?= csrf_field() ?><input type="hidden" name="action" value="rule_delete"><input type="hidden" name="id" value="<?= (int) $ru['id'] ?>"><button class="btn btn-danger btn-xs">Delete</button></form></td></tr>
        <?php endforeach; ?>
      </tbody></table></div><?php endif; ?>
      <form method="post" class="form" style="padding:16px 20px;border-top:1px solid var(--line)"><?= csrf_field() ?><input type="hidden" name="action" value="rule_add">
        <div class="field"><label for="ru-name">New rule</label><input id="ru-name" name="name" placeholder="Refunds go to me, urgent"></div>
        <div class="row"><div class="field"><label for="ru-ev">When</label><select id="ru-ev" name="event"><option value="created">A ticket arrives</option><option value="replied">The customer replies</option></select></div>
          <div class="field"><label for="ru-ch">On</label><select id="ru-ch" name="channel"><option value="">Any channel</option><option value="chat">Chat</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="web">Web form</option><option value="api">API</option></select></div></div>
        <div class="row"><div class="field"><label for="ru-f">And the</label><select id="ru-f" name="field"><option value="any">Subject or message</option><option value="subject">Subject</option><option value="body">Message</option><option value="email">Sender's email</option></select></div>
          <div class="field"><label for="ru-w">mentions any of <span class="muted">(comma separated)</span></label><input id="ru-w" name="words" placeholder="refund, money back, chargeback"></div></div>
        <p class="snippet-label" style="margin-top:4px">Then</p>
        <div class="row"><div class="field"><label for="ru-p">Priority</label><select id="ru-p" name="set_priority"><option value="">No change</option><?php foreach (Desk::PRIORITIES as $p): ?><option value="<?= $p ?>"><?= ucfirst($p) ?></option><?php endforeach; ?></select></div>
          <div class="field"><label for="ru-a">Assign to</label><select id="ru-a" name="assign_to"><option value="">No change</option><?php foreach ($agents as $ag): ?><option value="<?= (int) $ag['id'] ?>"><?= e($ag['name']) ?></option><?php endforeach; ?></select></div></div>
        <div class="row"><div class="field"><label for="ru-s">Status</label><select id="ru-s" name="set_status"><option value="">No change</option><option value="person">Skip the AI, a person answers</option><option value="pending">Pending</option><option value="solved">Solved</option></select></div>
          <div class="field"><label for="ru-t">Add tag</label><input id="ru-t" name="add_tag" placeholder="refund"></div></div>
        <div class="field"><label for="ru-m">Send a saved reply</label><select id="ru-m" name="reply_macro"><option value="">None</option><?php foreach ($macros as $mc): ?><option value="<?= (int) $mc['id'] ?>"><?= e($mc['title']) ?></option><?php endforeach; ?></select></div>
        <button class="btn btn-primary btn-sm">Add rule</button>
      </form>
    </div>
  </div>
</div>
