<?php
$__st = (string) ($status ?? '');
$__cls = match ($__st) {
    'delivered', 'read', 'completed', 'approved', 'paid', 'active', 'verified', 'received', 'sent', 'complete', 'solved' => 'green',
    'queued', 'pending', 'unpaid', 'new', 'open' => 'amber',
    'failed', 'locked', 'rejected', 'void', 'closed', 'expired', 'overdue', 'urgent' => 'red',
    'simulated', 'sandbox', 'test' => 'violet',
    default => 'blue',
};
?><span class="pill <?= $__cls ?>"><?= e(ucfirst($__st ?: 'none')) ?></span>
