<?php $base = '/dashboard/assistants/' . $a['public_id']; $groups = Assistants::groups($a); $total = array_sum(array_column($docs, 'chars')); ?>
<div class="toolbar"><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>">Back to <?= e($a['name']) ?></a><span class="muted small">AI used this month: <b style="color:var(--text)"><?= zar($usage) ?></b></span></div>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="as-grid">
  <div class="stack">
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <h2>Role</h2>
      <div class="row"><div class="field"><label for="a-name">Name</label><input id="a-name" name="name" value="<?= e($a['name']) ?>" maxlength="80"></div>
        <div class="field" style="max-width:120px"><label for="a-color">Colour</label><input id="a-color" name="color" type="color" value="<?= e($a['color']) ?>" style="height:40px;padding:3px"></div></div>
      <div class="field"><label for="a-ins">Instructions</label><textarea id="a-ins" name="instructions" rows="8"><?= e((string) $a['instructions']) ?></textarea>
        <p class="muted small" style="margin-top:6px">Describe the job, the tone, and anything it must always or never do. For example: "Write in a warm, short style. Our office is open 8 to 5. Never quote prices; send people to the price list."</p></div>
      <fieldset class="perm-grid"><legend>What it can do</legend>
        <?php foreach (Assistants::GROUPS as $k => [$label, $desc]): ?><label class="perm"><input type="checkbox" name="tools[]" value="<?= $k ?>" <?= in_array($k, $groups, true) ? 'checked' : '' ?>><span><b><?= e($label) ?></b><small><?= e($desc) ?></small></span></label><?php endforeach; ?>
      </fieldset>
      <div class="row">
        <div class="field"><label for="a-model">Model</label><select id="a-model" name="model" data-provider-select><?php foreach (Catalog::aiModels() as $m): $p = Catalog::aiPrice($m); ?><option value="<?= e($m['model']) ?>" data-provider="<?= e($m['provider']) ?>" <?= $m['model'] === $a['model'] ? 'selected' : '' ?>><?= e($m['label']) ?> (R<?= number_format($p['in'], 2) ?> / R<?= number_format($p['out'], 2) ?> per million tokens)</option><?php endforeach; ?></select><input type="hidden" name="provider" value="<?= e($a['provider']) ?>"></div>
        <div class="field" style="max-width:180px"><label for="a-eff">Thinking</label><select id="a-eff" name="effort"><?php foreach (Assistants::EFFORT as $k => $l): ?><option value="<?= $k ?>" <?= $a['effort'] === $k ? 'selected' : '' ?>><?= $l ?></option><?php endforeach; ?></select></div>
      </div>
      <p class="muted small">Quick is cheapest and fastest; Thorough thinks longer for planning and writing. Claude Opus 5.5 is the most capable; Haiku 5.5 is the cheapest.</p>
      <div class="row">
        <div class="field"><label for="a-brief">Morning email with your tasks</label><select id="a-brief" name="brief"><option value="">Off</option><?php foreach (range(5, 10) as $h): ?><option value="<?= $h ?>" <?= $a['brief_hour'] !== null && (int) $a['brief_hour'] === $h ? 'selected' : '' ?>><?= sprintf('%02d:00', $h) ?> SAST</option><?php endforeach; ?></select></div>
        <div class="field"><label>Who can use it</label><label class="consent" style="margin-top:8px"><input type="checkbox" name="shared" value="1" <?= $a['shared'] ? 'checked' : '' ?>><span>Everyone on my team</span></label></div>
      </div>
      <button class="btn btn-primary btn-sm">Save</button>
    </form>
    <div class="panel" id="memory"><h2>Memory</h2>
      <?php if (!$memory): ?><p class="muted small" style="margin-top:8px">Nothing yet. Tell <?= e($a['name']) ?> things like "Remember that our year end is February".</p><?php endif; ?>
      <?php foreach ($memory as $mm): ?><div class="mem-row"><span><?= e($mm['fact']) ?></span><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="memory_delete"><input type="hidden" name="id" value="<?= (int) $mm['id'] ?>"><button class="btn btn-ghost btn-xs">Forget</button></form></div><?php endforeach; ?>
    </div>
  </div>
  <div class="stack">
    <div class="panel" id="knowledge"><h2>Knowledge</h2>
      <p class="muted small" style="margin:6px 0 10px">Documents <?= e($a['name']) ?> answers from: price lists, policies, product sheets, project notes, FAQs. <?= $total ? number_format($total) . ' characters in ' . count($docs) . ' document' . (count($docs) === 1 ? '' : 's') . '.' : '' ?></p>
      <?php foreach ($docs as $d): ?><div class="mem-row"><span><?= icon($d['source'] === 'url' ? 'link' : 'form') ?> <?= e($d['title']) ?> <small class="muted"><?= number_format((int) $d['chars']) ?> chars</small></span><form method="post" class="inline-form" data-confirm="Remove this document?"><?= csrf_field() ?><input type="hidden" name="action" value="doc_delete"><input type="hidden" name="id" value="<?= (int) $d['id'] ?>"><button class="btn btn-ghost btn-xs">Remove</button></form></div><?php endforeach; ?>
      <details class="more" open><summary>Upload a file</summary><form method="post" enctype="multipart/form-data" class="form" style="margin-top:8px"><?= csrf_field() ?><input type="hidden" name="action" value="doc_file"><input type="file" name="file" accept=".docx,.txt,.md,.csv,.html,.htm" required><button class="btn btn-ghost btn-sm">Add file</button><p class="muted small">Word (.docx), text, Markdown, CSV or HTML, up to 10 MB.</p></form></details>
      <details class="more"><summary>Add a web page</summary><form method="post" class="form" style="margin-top:8px"><?= csrf_field() ?><input type="hidden" name="action" value="doc_url"><input name="url" type="url" placeholder="https://yourbusiness.co.za/faq" required><button class="btn btn-ghost btn-sm">Read page</button></form></details>
      <details class="more"><summary>Paste text</summary><form method="post" class="form" style="margin-top:8px"><?= csrf_field() ?><input type="hidden" name="action" value="doc_text"><input name="title" placeholder="Title, e.g. Delivery and returns" required><textarea name="content" rows="6" required></textarea><button class="btn btn-ghost btn-sm">Add text</button></form></details>
    </div>
    <div class="panel" id="share"><h2>Share with customers or partners</h2>
      <p class="muted small" style="margin:6px 0 10px">A link anyone can open to ask <?= e($a['name']) ?> questions about its knowledge. Visitors cannot see your tasks, memory, tickets or drafts, and cannot make it do anything. Their questions use your AI credit.</p>
      <?php if ($a['share_token']): ?>
        <div class="secret"><span id="share-url"><?= e(app_url('/a/' . $a['share_token'])) ?></span><button class="copy-btn" type="button" data-copy="share-url">Copy</button></div>
        <form method="post" style="margin-top:10px" data-confirm="Switch off the shared link? People with the old link lose access."><?= csrf_field() ?><input type="hidden" name="action" value="share_off"><button class="btn btn-ghost btn-sm">Switch off link</button></form>
      <?php else: ?><form method="post"><?= csrf_field() ?><input type="hidden" name="action" value="share_on"><button class="btn btn-ghost btn-sm">Create a shared link</button></form><?php endif; ?>
    </div>
    <div class="panel"><h2>Use it from your own app</h2>
      <p class="muted small" style="margin:6px 0 10px">Send messages with your SeaGeek API key. Replies come back as JSON; pass <span class="code-inline">chat_id</span> to continue a conversation.</p>
      <pre class="snippet">curl <?= e(app_url('/api/v1/assistants/' . $a['public_id'] . '/messages')) ?> \
  -H "Authorization: Bearer sg_live_..." \
  -H "Content-Type: application/json" \
  -d '{"message": "What is due this week?"}'</pre>
    </div>
    <form method="post" class="panel" data-confirm="Delete <?= e($a['name']) ?>? Its conversations, memory and knowledge are removed. Tasks and projects stay."><?= csrf_field() ?><input type="hidden" name="action" value="delete"><h2>Delete</h2><p class="muted small" style="margin:6px 0 10px">Tasks and projects it created stay on your board.</p><button class="btn btn-danger btn-sm">Delete assistant</button></form>
  </div>
</div>
