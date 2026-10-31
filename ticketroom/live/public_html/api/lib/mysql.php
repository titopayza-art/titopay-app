<?php
// MySQL / MariaDB support. The queries in TicketRoom are written for SQLite;
// on a MySQL server each one is rewritten once (then cached) by tr_sql_mysql().
// The connection runs in ANSI mode (|| joins text, "x" is a name) with
// backslashes taken literally, as in SQLite.
declare(strict_types=1);

// Words MySQL or MariaDB reserve that TicketRoom uses as column names.
// scripts/mysql-schema.php prints this list (--names) from the schema.
const MYSQL_QUOTED_NAMES = ['key'];

function db_is_mysql(): bool { return (string) cfg('database.driver', 'sqlite') === 'mysql'; }

function db_connect_mysql(): PDO
{
    $c = (array) cfg('database', []);
    $dsn = !empty($c['socket'])
        ? 'mysql:unix_socket=' . $c['socket'] . ';dbname=' . $c['name'] . ';charset=utf8mb4'
        : 'mysql:host=' . ($c['host'] ?? '127.0.0.1') . ';port=' . (int) ($c['port'] ?? 3306) . ';dbname=' . $c['name'] . ';charset=utf8mb4';
    $pdo = new PDO($dsn, (string) ($c['user'] ?? ''), (string) ($c['pass'] ?? ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_STRINGIFY_FETCHES => false,
        // The server's own prepared statements: they read 'a\' as SQLite does
        // (PDO's emulation would take the backslash as an escape).
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 10,
        // Matched rows, not changed rows, as SQLite counts them.
        PDO::MYSQL_ATTR_FOUND_ROWS => true,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_bin, time_zone = '+00:00', SESSION sql_mode = 'PIPES_AS_CONCAT,ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
    ]);
    // Each read sees the latest committed data, as in SQLite; the write lock
    // keeps check-and-update steps in order.
    $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    return $pdo;
}

// ============================================================== write lock
// SQLite lets one write happen at a time, and every check-and-update in
// TicketRoom (seats left, one scan per ticket, wallet balances) relies on
// that. On MySQL the same guarantee comes from one named lock, held for each
// write transaction and each write made outside one.
const MYSQL_WRITE_LOCK = 'ticketroom.write';
function mysql_lock(PDO $pdo, string $name = MYSQL_WRITE_LOCK): void
{
    $got = $pdo->query("SELECT GET_LOCK('" . $name . "', 20)")->fetchColumn();
    if ((int) $got !== 1) throw new RuntimeException('The site is very busy. Please try again in a moment.');
}
function mysql_unlock(PDO $pdo, string $name = MYSQL_WRITE_LOCK): void
{
    try { $pdo->query("SELECT RELEASE_LOCK('" . $name . "')")->fetchColumn(); } catch (Throwable) { /* connection gone: the lock went with it */ }
}
// Writes that never decide anything for a booking, scan or payment skip the
// lock: counters, last seen, and the email queue and job clock, whose claims
// are single compare-and-set statements (UPDATE ... WHERE claimed_until < now).
// Sending thousands of confirmation emails then never slows the on-sale.
const MYSQL_UNLOCKED_TABLES = ['rate_limits', 'recently_viewed_events', 'tracking_links', 'message_outbox', 'job_runs'];
function mysql_needs_lock(string $sql): bool
{
    if (!preg_match('/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b(?:\s+(?:OR\s+\w+\s+)?(?:INTO\s+)?)?\s*"?([a-z_]+)/i', $sql, $m)) return false;
    return !in_array(strtolower($m[2]), MYSQL_UNLOCKED_TABLES, true);
}

// Runs $fn holding a lock of its own (not the write lock).
function mysql_with_lock(string $name, callable $fn)
{
    mysql_lock(db(), $name);
    try { return $fn(); } finally { mysql_unlock(db(), $name); }
}

// ============================================================== results
// SUM and AVG come back from MySQL as DECIMAL text: give them back as numbers.
function mysql_numbers(PDOStatement $st, array $rows): array
{
    if (!$rows) return $rows;
    $dec = [];
    for ($i = 0, $n = $st->columnCount(); $i < $n; $i++) {
        $m = $st->getColumnMeta($i);
        if ($m && in_array($m['native_type'] ?? '', ['NEWDECIMAL', 'DECIMAL'], true)) $dec[] = $m['name'];
    }
    if (!$dec) return $rows;
    foreach ($rows as &$r) foreach ($dec as $k) if (isset($r[$k]) && is_string($r[$k])) $r[$k] = mysql_number($r[$k]);
    return $rows;
}
// One value (val()): a DECIMAL in the first column becomes a number.
function mysql_val(PDOStatement $st, string $v)
{
    $m = $st->getColumnMeta(0);
    return ($m && in_array($m['native_type'] ?? '', ['NEWDECIMAL', 'DECIMAL'], true)) ? mysql_number($v) : $v;
}
function mysql_number(string $v)
{
    if (!is_numeric($v)) return $v;
    $f = (float) $v;
    return (floor($f) == $f && abs($f) < PHP_INT_MAX) ? (int) $f : $f;
}

// ============================================================== SQL dialect
function tr_sql_mysql(string $sql): string
{
    static $cache = [];
    if (isset($cache[$sql])) return $cache[$sql];
    if (count($cache) > 2000) $cache = [];
    // Keep string literals out of every rewrite.
    $lits = [];
    $s = preg_replace_callback("/'(?:[^']|'')*'/", function ($m) use (&$lits) { $lits[] = $m[0]; return "\x01" . (count($lits) - 1) . "\x01"; }, $sql);

    // Upserts.
    $ignore = false;
    $s = preg_replace_callback('/\bON\s+CONFLICT\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*DO\s+(NOTHING|UPDATE\s+SET)\b/i', function ($m) use (&$ignore) {
        if (stripos($m[2], 'NOTHING') === 0) { $ignore = true; return ''; }
        return 'ON DUPLICATE KEY UPDATE';
    }, $s);
    $s = preg_replace('/\bexcluded\.("?)(\w+)\1/i', 'VALUES("$2")', $s);
    $s = preg_replace('/^\s*INSERT\s+OR\s+IGNORE\b/i', 'INSERT IGNORE', $s);
    if ($ignore) $s = preg_replace('/^\s*INSERT\b(?!\s+IGNORE)/i', 'INSERT IGNORE', $s);
    // SQLite's REPLACE INTO and INSERT OR REPLACE are the same in MySQL.
    $s = preg_replace('/^\s*INSERT\s+OR\s+REPLACE\b/i', 'REPLACE', $s);

    // Null-safe equals, NULLS LAST, casts, text length.
    $s = preg_replace('/\bIS\s+\?/', '<=> ?', $s);
    $s = preg_replace('/((?:"?\w+"?\.)?"?\w+"?)\s+NULLS\s+LAST\b/i', '$1 IS NULL, $1', $s);
    $s = preg_replace('/\bAS\s+INTEGER\s*\)/i', 'AS SIGNED)', $s);
    $s = preg_replace('/\bAS\s+REAL\s*\)/i', 'AS DOUBLE)', $s);
    $s = preg_replace('/\bAS\s+TEXT\s*\)/i', 'AS CHAR)', $s);
    $s = preg_replace('/\blength\s*\(/i', 'CHAR_LENGTH(', $s);

    // lower(email) lookups use the indexed email_lc column (users and
    // newsletter_subscribers, the tables with a lower(email) index).
    $s = preg_replace('/\blower\(\s*((?:"?\w+"?\.)?)"?email"?\s*\)/i', '$1email_lc', $s);

    // Functions whose arguments change shape.
    $s = mysql_rewrite_calls($s);

    // Column names MySQL reserves.
    $s = preg_replace('/(?<![\w"$.])(' . implode('|', MYSQL_QUOTED_NAMES) . ')(?![\w"(])/', '"$1"', $s);
    $s = preg_replace('/\.(' . implode('|', MYSQL_QUOTED_NAMES) . ')(?![\w"(])/', '."$1"', $s);

    $s = preg_replace_callback("/\x01(\d+)\x01/", fn($m) => $lits[(int) $m[1]], $s);
    return $cache[$sql] = $s;
}

// max(a, b) and min(a, b) with two or more arguments, group_concat(x, sep)
// and json_extract(...) (MySQL returns JSON text: unquote it as SQLite does).
function mysql_rewrite_calls(string $s): string
{
    $out = '';
    $i = 0;
    $n = strlen($s);
    while ($i < $n) {
        if (preg_match('/\G(?<![\w.])(max|min|group_concat|json_extract)\s*\(/i', $s, $m, 0, $i)) {
            $name = strtolower($m[1]);
            $start = $i + strlen($m[0]);
            [$args, $end] = mysql_split_args($s, $start);
            $args = array_map('mysql_rewrite_calls', $args);
            if (($name === 'max' || $name === 'min') && count($args) > 1) $out .= ($name === 'max' ? 'GREATEST(' : 'LEAST(') . implode(',', $args) . ')';
            elseif ($name === 'group_concat' && count($args) === 2) $out .= 'GROUP_CONCAT(' . $args[0] . ' SEPARATOR ' . trim($args[1]) . ')';
            elseif ($name === 'json_extract') $out .= 'JSON_UNQUOTE(JSON_EXTRACT(' . implode(',', $args) . '))';
            else $out .= $m[1] . '(' . implode(',', $args) . ')';
            $i = $end + 1;
            continue;
        }
        $out .= $s[$i];
        $i++;
    }
    return $out;
}
// Arguments of a call whose "(" ends just before $from; returns [args, index of ")"].
function mysql_split_args(string $s, int $from): array
{
    $depth = 0;
    $args = [];
    $cur = '';
    for ($i = $from, $n = strlen($s); $i < $n; $i++) {
        $c = $s[$i];
        if ($c === '(') $depth++;
        elseif ($c === ')') {
            if ($depth === 0) { $args[] = $cur; return [$args, $i]; }
            $depth--;
        } elseif ($c === ',' && $depth === 0) { $args[] = $cur; $cur = ''; continue; }
        $cur .= $c;
    }
    throw new RuntimeException('Unbalanced SQL: ' . substr($s, 0, 120));
}

// ============================================================== install
// Runs the MySQL schema (statements are separated by lines holding only ";;").
function mysql_install_schema(PDO $pdo): void
{
    $sql = (string) file_get_contents(TR_APP . '/schema.mysql.sql');
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach (preg_split('/^;;\s*$/m', $sql) as $stmt) if (trim(preg_replace('/^--.*$/m', '', $stmt)) !== '') $pdo->exec($stmt);
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
}
function mysql_has_table(string $t): bool
{
    return (bool) val('SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [$t]);
}
