<?php [$prev, $next] = Docs::neighbours($slug); ?>
    <nav class="docs-pager" aria-label="Previous and next page">
      <?php if ($prev): ?><a href="<?= e($prev['href']) ?>" class="prev"><span>Previous</span><b><?= e($prev['title']) ?></b></a><?php else: ?><span></span><?php endif; ?>
      <?php if ($next): ?><a href="<?= e($next['href']) ?>" class="next"><span>Next</span><b><?= e($next['title']) ?></b></a><?php endif; ?>
    </nav>
    <p class="docs-help">Stuck? Write to <a class="link" href="mailto:hello@seageek.co.za">hello@seageek.co.za</a> or open the chat in the corner. Quote the request ID from the <code>X-Request-Id</code> header and we can trace the call.</p>
  </article>
  <aside class="docs-toc" aria-label="On this page"><h4>On this page</h4><nav data-toc></nav></aside>
</div>
<script src="/assets/js/docs.js?v=2" defer></script>
