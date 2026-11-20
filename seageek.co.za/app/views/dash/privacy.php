<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="priv-grid">
  <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
    <h2>AI and your data</h2>
    <p class="muted small">Your messages, documents and customer details are used only to answer your customers and your team. They are never used to train AI models, and they are never shared with other companies.</p>
    <label class="consent" style="margin-top:12px"><input type="checkbox" name="ai_data_allowed" value="1" <?= (int) $org['ai_data_allowed'] === 1 ? 'checked' : '' ?>><span><b>Let SeaGeek AI read my conversations and documents.</b> Switch this off and AI stops answering; chats go straight to a person and assistants refuse to run.</span></label>
    <p class="muted small" style="margin-top:14px">Before anything reaches an AI model, card numbers, South African ID numbers, bank account numbers, passwords and secret keys are removed. Names, emails and phone numbers stay, so the AI can still reply to people.</p>
    <div class="field" style="margin-top:12px"><label for="p-ret">Delete old conversations after</label><select id="p-ret" name="retention_days"><?php foreach ([30 => '30 days', 90 => '90 days', 180 => '6 months', 365 => '12 months (recommended)', 730 => '2 years', 0 => 'Never delete'] as $k => $l): ?><option value="<?= $k ?>" <?= (int) $org['retention_days'] === $k ? 'selected' : '' ?>><?= e($l) ?></option><?php endforeach; ?></select></div>
    <p class="muted small">Only closed or solved support tickets, finished assistant chats and uploaded files are deleted. Open work is never touched. Deleted items cannot be recovered.</p>
    <button class="btn btn-primary btn-sm" style="margin-top:12px">Save privacy settings</button>
  </form>
  <div class="stack">
    <div class="panel"><h2>What you hold</h2>
      <dl class="kv" style="grid-template-columns:1fr auto;margin-top:10px"><dt>Support conversations</dt><dd class="mono"><?= number_format($counts['tickets']) ?></dd><dt>Assistant chats</dt><dd class="mono"><?= number_format($counts['chats']) ?></dd><dt>Documents for assistants</dt><dd class="mono"><?= number_format($counts['docs']) ?></dd></dl>
      <form method="post" style="margin-top:12px" data-confirm="Delete old conversations now, according to your retention setting?"><?= csrf_field() ?><input type="hidden" name="action" value="purge"><button class="btn btn-ghost btn-sm" <?= (int) $org['retention_days'] === 0 ? 'disabled' : '' ?>>Delete old conversations now</button></form>
    </div>
    <div class="panel"><h2>Download a copy</h2>
      <p class="muted small" style="margin:6px 0 10px">Everything SeaGeek holds for your company as one file: conversations, tasks, invoices, documents, team and the activity log. Passwords and secret keys are never included.</p>
      <?php if (($me['role'] ?? '') === 'owner'): ?><a class="btn btn-primary btn-sm" href="/dashboard/privacy/export">Download my company data</a><?php else: ?><p class="muted small">Only the owner can download the company data.</p><?php endif; ?>
    </div>
    <div class="panel"><h2>Who can see what</h2><p class="muted small" style="margin:6px 0 10px">Set each person's access under Settings, Team. Everything they open or change is recorded in the activity log.</p><a class="link small" href="/dashboard/activity">Open the activity log</a> · <a class="link small" href="/dashboard/settings">Team access</a> · <a class="link small" href="/data-protection">How SeaGeek protects data</a></div>
  </div>
</div>
