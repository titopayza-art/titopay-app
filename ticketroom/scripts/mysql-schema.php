<?php
// Builds public_html/api/schema.mysql.sql from schema.sql.
//
//   php ticketroom/scripts/mysql-schema.php          writes the file
//   php ticketroom/scripts/mysql-schema.php --check  fails if it is out of date
//
// schema.sql is loaded into an in-memory SQLite database and read back table
// by table, so the MySQL schema always matches a fresh SQLite install:
// - TEXT columns used in a key, index or foreign key become VARCHAR (40 for times, 191 otherwise),
//   other TEXT columns MEDIUMTEXT; INTEGER becomes BIGINT.
// - SQLite partial indexes (WHERE ...) and expression indexes become indexes
//   on hidden generated columns, so "one open listing per ticket" and the
//   like keep the same guarantee.
// - Triggers become MySQL triggers that SIGNAL the same message.
declare(strict_types=1);

const RESERVED = 'accessible add all alter analyze and as asc asensitive before between bigint binary blob both by call cascade case change char character check collate column condition constraint continue convert create cross cube cume_dist current_date current_role current_time current_timestamp current_user cursor database databases day_hour day_microsecond day_minute day_second dec decimal declare default delayed delete delete_domain_id dense_rank desc describe deterministic distinct distinctrow div do_domain_ids double drop dual each else elseif empty enclosed escaped except exists exit explain false fetch first_value float float4 float8 for force foreign from fulltext function general generated get grant group grouping groups having high_priority hour_microsecond hour_minute hour_second if ignore ignore_domain_ids ignore_server_ids in index infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer intersect interval into io_after_gtids io_before_gtids is iterate join json_table key keys kill lag last_value lateral lead leading leave left like limit linear lines load localtime localtimestamp lock long longblob longtext loop low_priority master_bind master_heartbeat_period master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext middleint minute_microsecond minute_second mod modifies natural not no_write_to_binlog nth_value ntile null numeric of offset on optimize optimizer_costs option optionally or order out outer outfile over page_checksum parse_vcol_expr partition percent_rank position precision primary procedure purge range rank read read_write reads real recursive ref_system_id references regexp release rename repeat replace require resignal restrict return returning revoke right rlike row row_number rows schema schemas second_microsecond select sensitive separator set show signal slow smallint spatial specific sql sql_big_result sql_calc_found_rows sql_small_result sqlexception sqlstate sqlwarning ssl starting stats_auto_recalc stats_persistent stats_sample_pages stored straight_join system table terminated then tinyblob tinyint tinytext to trailing trigger true undo union unique unlock unsigned update usage use using utc_date utc_time utc_timestamp values varbinary varchar varcharacter varying virtual when where while window with write xor year_month zerofill';

$root = dirname(__DIR__) . '/live/public_html/api';
$src = (string) file_get_contents("$root/schema.sql");
$lite = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$lite->exec($src);
$reserved = array_flip(explode(' ', RESERVED));
$q = fn(string $n) => isset($reserved[strtolower($n)]) ? "\"$n\"" : $n;
$quotedNames = [];

$tables = $lite->query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")->fetchAll();
$indexes = $lite->query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY rowid")->fetchAll();
$triggers = $lite->query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid")->fetchAll();

// Columns that must be VARCHAR: keys, indexes, foreign keys (both ends).
$keyed = [];
$mark = function (string $t, string $c) use (&$keyed) { $keyed[$t][$c] = true; };
foreach ($tables as $t) {
    foreach ($lite->query("PRAGMA table_info(\"{$t['name']}\")") as $c) if ($c['pk']) $mark($t['name'], $c['name']);
    foreach ($lite->query("PRAGMA foreign_key_list(\"{$t['name']}\")") as $f) { $mark($t['name'], $f['from']); $mark($f['table'], $f['to'] ?? 'id'); }
    foreach ($lite->query("PRAGMA index_list(\"{$t['name']}\")") as $ix) foreach ($lite->query("PRAGMA index_info(\"{$ix['name']}\")") as $ic) if ($ic['name'] !== null) $mark($t['name'], $ic['name']);
}

// The CHECK (...) clauses of a CREATE TABLE.
function checks(string $sql): array
{
    $out = [];
    $off = 0;
    while (preg_match('/\bCHECK\s*\(/i', $sql, $m, PREG_OFFSET_CAPTURE, $off)) {
        $i = $m[0][1] + strlen($m[0][0]);
        $depth = 0;
        for ($j = $i; $j < strlen($sql); $j++) {
            if ($sql[$j] === "'") { $j = strpos($sql, "'", $j + 1); while ($j !== false && ($sql[$j + 1] ?? '') === "'") $j = strpos($sql, "'", $j + 2); continue; }
            if ($sql[$j] === '(') $depth++;
            elseif ($sql[$j] === ')') { if ($depth === 0) break; $depth--; }
        }
        $out[] = trim(substr($sql, $i, $j - $i));
        $off = $j;
    }
    return $out;
}
function typeof_col(array $c, bool $keyed): string
{
    $t = strtoupper($c['type']);
    if (str_contains($t, 'INT')) return 'BIGINT';
    if (str_contains($t, 'REAL') || str_contains($t, 'FLOA') || str_contains($t, 'DOUB')) return 'DOUBLE';
    if (str_contains($t, 'BLOB')) return 'LONGBLOB';
    // Index entries are limited to 3072 bytes (4 bytes a character): times are
    // short ISO text, everything else in a key fits in 191 characters.
    if (!$keyed) return 'MEDIUMTEXT';
    return str_ends_with($c['name'], '_at') ? 'VARCHAR(40)' : 'VARCHAR(191)';
}
// SQLite expressions used in checks, triggers and generated columns.
function expr(string $e, callable $q): string
{
    $e = preg_replace('/\blength\s*\(/i', 'CHAR_LENGTH(', $e);
    return $e;
}

$out = ["-- TicketRoom schema for MySQL 8 / MariaDB 10.6 and later.\n-- Generated from schema.sql by ticketroom/scripts/mysql-schema.php. Do not edit by hand.\n-- Statements are separated by lines holding only ;;\n"];
$genCols = []; // table => [ddl]
$idxDdl = [];  // table => [ddl]

foreach ($indexes as $ix) {
    $ixSql = trim($ix['sql']);
    if (!preg_match('/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(/is', $ixSql, $m)) throw new RuntimeException("Cannot read index: $ixSql");
    [, $unique, $name, $table] = $m;
    // The column list ends at its matching bracket; a WHERE may follow.
    $open = strlen($m[0]);
    for ($j = $open, $depth = 0; $j < strlen($ixSql); $j++) { if ($ixSql[$j] === '(') $depth++; elseif ($ixSql[$j] === ')') { if (!$depth) break; $depth--; } }
    $colsRaw = substr($ixSql, $open, $j - $open);
    $where = trim((string) preg_replace('/^\s*WHERE\s+/i', '', substr($ixSql, $j + 1)));
    $parts = [];
    $depth = 0; $cur = '';
    foreach (str_split($colsRaw) as $ch) { if ($ch === '(') $depth++; if ($ch === ')') $depth--; if ($ch === ',' && !$depth) { $parts[] = trim($cur); $cur = ''; continue; } $cur .= $ch; }
    $parts[] = trim($cur);
    $cols = [];
    foreach ($parts as $k => $p) {
        $dir = preg_match('/\s+(ASC|DESC)$/i', $p, $dm) ? ' ' . strtoupper($dm[1]) : '';
        $p = preg_replace('/\s+(ASC|DESC)$/i', '', $p);
        $plain = preg_match('/^"?(\w+)"?$/', $p, $pm);
        if ($plain && $where === '') { $cols[] = $q($pm[1]) . $dir; $quotedNames[$pm[1]] = true; continue; }
        // A generated, hidden column holds the expression (or NULL outside the index's WHERE).
        // lower(email) is named email_lc: lib/mysql.php points lower(email) lookups at it.
        $g = (!$plain && $where === '' && preg_match('/^lower\(\s*"?(\w+)"?\s*\)$/i', $p, $em)) ? "{$em[1]}_lc" : substr('g_' . $name, 0, 60) . "_$k";
        $val = $plain ? $q($pm[1]) : expr($p, $q);
        $isInt = $plain && preg_match('/INT/i', (string) $lite->query("SELECT type FROM pragma_table_info('$table') WHERE name = '{$pm[1]}'")->fetchColumn());
        $body = $where === '' ? $val : 'CASE WHEN ' . expr($where, $q) . " THEN $val END";
        $genCols[$table][] = "  $g " . ($isInt ? 'BIGINT' : 'VARCHAR(191)') . " GENERATED ALWAYS AS ($body) STORED INVISIBLE";
        $cols[] = $g . $dir;
    }
    $idxDdl[$table][] = 'CREATE ' . ($unique ? 'UNIQUE ' : '') . "INDEX $name ON $table (" . implode(', ', $cols) . ')';
}

foreach ($tables as $t) {
    $name = $t['name'];
    $lines = [];
    $pk = [];
    $cols = $lite->query("PRAGMA table_info(\"$name\")")->fetchAll();
    $auto = preg_match('/\bAUTOINCREMENT\b/i', $t['sql']) || (count(array_filter($cols, fn($c) => $c['pk'])) === 1 && preg_match('/INTEGER\s+PRIMARY\s+KEY/i', $t['sql']));
    foreach ($cols as $c) {
        $isKey = isset($keyed[$name][$c['name']]);
        $type = typeof_col($c, $isKey);
        if (isset($reserved[strtolower($c['name'])])) $quotedNames[$c['name']] = true;
        $d = '  ' . $q($c['name']) . " $type";
        if ($c['pk']) $pk[(int) $c['pk']] = $q($c['name']);
        $isAuto = $auto && $c['pk'] && str_contains(strtoupper($c['type']), 'INT');
        if ($c['notnull'] || $c['pk']) $d .= ' NOT NULL';
        if ($isAuto) $d .= ' AUTO_INCREMENT';
        if ($c['dflt_value'] !== null) {
            $v = $c['dflt_value'];
            $d .= ' DEFAULT ' . ($type === 'MEDIUMTEXT' ? "($v)" : $v);
        }
        $lines[] = $d;
    }
    ksort($pk);
    if ($pk) $lines[] = '  PRIMARY KEY (' . implode(', ', $pk) . ')';
    // UNIQUE (...) written in the table.
    foreach ($lite->query("PRAGMA index_list(\"$name\")") as $ix) {
        if ($ix['origin'] !== 'u') continue;
        $ic = array_map(fn($r) => $q($r['name']), $lite->query("PRAGMA index_info(\"{$ix['name']}\")")->fetchAll());
        $lines[] = '  UNIQUE KEY ' . substr("uq_{$name}_" . count($lines), 0, 64) . ' (' . implode(', ', $ic) . ')';
    }
    foreach ($genCols[$name] ?? [] as $g) $lines[] = $g;
    $fks = [];
    foreach ($lite->query("PRAGMA foreign_key_list(\"$name\")") as $f) {
        $fks[$f['id']]['table'] = $f['table'];
        $fks[$f['id']]['from'][] = $q($f['from']);
        $fks[$f['id']]['to'][] = $q($f['to'] ?? 'id');
        $fks[$f['id']]['on_delete'] = $f['on_delete'];
        $fks[$f['id']]['on_update'] = $f['on_update'];
    }
    foreach ($fks as $f) {
        $l = '  FOREIGN KEY (' . implode(', ', $f['from']) . ") REFERENCES {$f['table']} (" . implode(', ', $f['to']) . ')';
        if ($f['on_delete'] !== 'NO ACTION') $l .= ' ON DELETE ' . $f['on_delete'];
        if ($f['on_update'] !== 'NO ACTION') $l .= ' ON UPDATE ' . $f['on_update'];
        $lines[] = $l;
    }
    foreach (checks($t['sql']) as $ck) $lines[] = '  CHECK (' . expr($ck, $q) . ')';
    $out[] = "CREATE TABLE $name (\n" . implode(",\n", $lines) . "\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC";
    foreach ($idxDdl[$name] ?? [] as $x) $out[] = $x;
}

foreach ($triggers as $tg) {
    if (!preg_match('/^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+BEFORE\s+(INSERT|UPDATE|DELETE)(?:\s+OF\s+([\w,\s]+?))?\s+ON\s+(\w+)\s*(?:WHEN\s+(.*?))?\s*BEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*(\'[^\']*\')\s*\)\s*;\s*END$/is', trim($tg['sql']), $m)) throw new RuntimeException("Cannot read trigger: {$tg['sql']}");
    [, $name, $ev, $of, $table, $when, $msg] = $m;
    $conds = [];
    if (trim($of) !== '') $conds[] = '(' . implode(' OR ', array_map(fn($c) => 'NOT (NEW.' . $q(trim($c)) . ' <=> OLD.' . $q(trim($c)) . ')', explode(',', $of))) . ')';
    if (trim($when) !== '') $conds[] = '(' . expr(trim($when), $q) . ')';
    $signal = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = $msg";
    $body = $conds ? 'IF ' . implode(' AND ', $conds) . " THEN $signal; END IF;" : "$signal;";
    $out[] = "CREATE TRIGGER $name BEFORE " . strtoupper($ev) . " ON $table FOR EACH ROW BEGIN $body END";
}

$sql = implode("\n;;\n", $out) . "\n;;\n";
$file = "$root/schema.mysql.sql";
ksort($quotedNames);
$names = array_keys(array_filter($quotedNames, fn($k) => isset($reserved[strtolower((string) $k)]), ARRAY_FILTER_USE_KEY));
if (in_array('--names', $argv, true)) { echo implode(' ', $names), "\n"; exit(0); }
if (in_array('--check', $argv, true)) {
    if (!is_file($file) || file_get_contents($file) !== $sql) { fwrite(STDERR, "schema.mysql.sql is out of date: run php ticketroom/scripts/mysql-schema.php\n"); exit(1); }
    echo "schema.mysql.sql is up to date\n";
    exit(0);
}
file_put_contents($file, $sql);
echo 'Wrote ', $file, ' (', count($tables), ' tables, ', count($indexes), ' indexes, ', count($triggers), " triggers)\nReserved column names: ", implode(' ', $names), "\n";
