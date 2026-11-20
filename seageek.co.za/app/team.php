<?php
/**
 * Team access: what each person in a company can see and change. Owners always have everything.
 * Every dashboard page belongs to one area; the check runs before the page does.
 */
declare(strict_types=1);

final class Team
{
    public const AREAS = [
        'overview' => ['Overview', 'The home page with the day\'s numbers and what needs doing'],
        'money' => ['Money', 'Invoices, payments, statements, credit, quotes and services you buy'],
        'api' => ['API and developers', 'API keys, webhooks, usage and the developer tools'],
        'desk' => ['Support desk', 'Tickets, replies, the help centre and desk reports'],
        'marketing' => ['Marketing and plug-ins', 'Campaigns, contacts, forms, QR codes, store SMS, links, monitors, chat and WhatsApp templates'],
        'assistants' => ['Assistants and tasks', 'AI assistants, projects and the task board'],
        'team' => ['Team, privacy and activity', 'Staff accounts, data protection settings, the activity log and company details'],
    ];
    public const LEVELS = ['none' => 0, 'view' => 1, 'edit' => 2];
    public const ROLES = ['owner' => 'Owner', 'agent' => 'Support agent', 'billing' => 'Accountant', 'developer' => 'Developer', 'viewer' => 'Viewer'];

    /** Starting access for each role. Used until someone changes it for a person. */
    private static function defaults(): array
    {
        $all = fn(string $l) => array_fill_keys(array_keys(self::AREAS), $l);
        return [
            'owner' => $all('edit'),
            'agent' => ['overview' => 'view', 'desk' => 'edit', 'assistants' => 'edit', 'marketing' => 'view', 'money' => 'none', 'api' => 'none', 'team' => 'none'],
            'billing' => ['overview' => 'view', 'money' => 'edit', 'api' => 'view', 'desk' => 'none', 'marketing' => 'none', 'assistants' => 'none', 'team' => 'none'],
            'developer' => ['overview' => 'view', 'api' => 'edit', 'desk' => 'view', 'marketing' => 'none', 'money' => 'none', 'assistants' => 'none', 'team' => 'none'],
            'viewer' => $all('view') + ['team' => 'none'],
        ];
    }

    /** Which area a dashboard address belongs to. Anything not listed is the overview. */
    public static function areaFor(string $path): string
    {
        $rules = [
            'money' => ['/dashboard/billing', '/dashboard/invoice', '/dashboard/invoices', '/dashboard/cart', '/dashboard/quote', '/dashboard/pay', '/dashboard/statement', '/dashboard/services', '/dashboard/service/'],
            'api' => ['/dashboard/keys', '/dashboard/usage', '/dashboard/webhooks'],
            'desk' => ['/dashboard/desk', '/dashboard/help-centre'],
            'marketing' => ['/dashboard/campaigns', '/dashboard/contacts', '/dashboard/qr', '/dashboard/stores', '/dashboard/chat', '/dashboard/forms', '/dashboard/links', '/dashboard/monitors', '/dashboard/plugins', '/dashboard/wa-templates'],
            'assistants' => ['/dashboard/assistants', '/dashboard/work'],
            'team' => ['/dashboard/settings', '/dashboard/activity', '/dashboard/privacy'],
        ];
        foreach ($rules as $area => $prefixes) foreach ($prefixes as $p) {
            if ($path === rtrim($p, '/') || str_starts_with($path, $p)) return $area;
        }
        return 'overview';
    }

    /** Full access map for a person: area => none|view|edit. */
    public static function map(array $u): array
    {
        if (($u['role'] ?? '') === 'owner') return self::defaults()['owner'];
        $base = self::defaults()[$u['role'] ?? ''] ?? ['overview' => 'view'];
        $custom = json_decode((string) ($u['team_access'] ?? ''), true);
        $map = is_array($custom) ? array_merge(array_fill_keys(array_keys(self::AREAS), 'none'), array_intersect_key($custom, self::AREAS)) : $base;
        $map['overview'] = $map['overview'] === 'none' ? 'view' : $map['overview'];
        return $map;
    }

    public static function level(array $u, string $area): string
    {
        return self::map($u)[$area] ?? 'none';
    }

    public static function allows(array $u, string $area, string $need = 'view'): bool
    {
        return self::LEVELS[self::level($u, $area)] >= self::LEVELS[$need];
    }

    /** Save a person's access. Levels are validated; owners keep full access whatever is stored. */
    public static function save(int $userId, array $levels): void
    {
        $clean = [];
        foreach (array_keys(self::AREAS) as $a) $clean[$a] = isset(self::LEVELS[$levels[$a] ?? '']) ? $levels[$a] : 'none';
        DB::update('users', ['team_access' => json_encode($clean)], 'id = ?', [$userId]);
    }

    /** The levels a role starts with, for pre-filling the invite form. */
    public static function defaultsFor(string $role): array
    {
        return self::defaults()[$role] ?? self::defaults()['viewer'];
    }
}

/** The area-by-area access picker. Used on the invite form and on each member's access editor. */
function render_access_fields(array $levels): void
{
    echo '<div class="access-grid">';
    foreach (Team::AREAS as $k => [$label, $desc]) {
        $cur = $levels[$k] ?? 'none';
        echo '<label class="access-row"><span><b>' . e($label) . '</b><small>' . e($desc) . '</small></span><select name="lvl[' . e($k) . ']" aria-label="' . e($label) . '">';
        foreach (Team::LEVELS as $lv => $_) echo '<option value="' . $lv . '"' . ($lv === $cur ? ' selected' : '') . '>' . e(['none' => 'No access', 'view' => 'Can see', 'edit' => 'Can see and change'][$lv]) . '</option>';
        echo '</select></label>';
    }
    echo '</div>';
}

function render_access_form(int $userId, array $levels, string $name): void
{
    echo '<form method="post" class="form" style="margin-top:10px">' . csrf_field() . '<input type="hidden" name="action" value="perms"><input type="hidden" name="id" value="' . $userId . '">';
    render_access_fields($levels);
    echo '<button class="btn btn-ghost btn-sm" style="margin-top:10px">Save access for ' . e($name) . '</button></form>';
}
