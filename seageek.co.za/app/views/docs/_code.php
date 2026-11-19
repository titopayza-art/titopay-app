<?php
/** Tabbed code sample. Expects $codeTabs: label => code. */
?>
<div class="code-window" data-tabs>
  <div class="code-head"><div class="tabs" role="tablist"><?php $first = true; foreach (array_keys($codeTabs) as $lang): ?><button class="tab" role="tab" data-lang="<?= e($lang) ?>" aria-selected="<?= $first ? 'true' : 'false' ?>"><?= e($lang) ?></button><?php $first = false; endforeach; ?></div><button class="copy-btn" type="button">Copy</button></div>
  <div class="code-body"><?php $first = true; foreach ($codeTabs as $lang => $code): ?><pre data-lang="<?= e($lang) ?>"<?= $first ? '' : ' hidden' ?>><?= e($code) ?></pre><?php $first = false; endforeach; ?></div>
</div>
