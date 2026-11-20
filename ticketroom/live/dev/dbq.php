<?php
// Tests only: runs one SQL statement against a local test site's database,
// SQLite or MySQL, as the site itself would (MySQL queries go through the
// same translator). Prints the rows as JSON.
//
//   php dev/dbq.php <ticketroom-data dir> <sql> [params as JSON]
//   php dev/dbq.php <ticketroom-data dir> --driver      prints sqlite or mysql
//   php dev/dbq.php <ticketroom-data dir> --tables      lists the tables
declare(strict_types=1);

$dir = $argv[1];
$GLOBALS['TR_CONFIG'] = require "$dir/config.php";
function cfg(?string $key = null, $default = null)
{
    $cur = $GLOBALS['TR_CONFIG'];
    if ($key === null) return $cur;
    foreach (explode('.', $key) as $p) { if (!is_array($cur) || !array_key_exists($p, $cur)) return $default; $cur = $cur[$p]; }
    return $cur;
}
require __DIR__ . '/../public_html/api/lib/mysql.php';
$mysql = db_is_mysql();
if (($argv[2] ?? '') === '--driver') { echo $mysql ? 'mysql' : 'sqlite'; exit(0); }
$db = $mysql ? db_connect_mysql() : new PDO("sqlite:$dir/ticketroom.sqlite", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
if (!$mysql) $db->exec('PRAGMA busy_timeout = 10000');
if (($argv[2] ?? '') === '--tables') {
    $sql = $mysql ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()' : "SELECT name FROM sqlite_master WHERE type = 'table'";
    echo json_encode($db->query($sql)->fetchAll(PDO::FETCH_COLUMN));
    exit(0);
}
$sql = $argv[2];
if ($mysql) $sql = tr_sql_mysql(preg_replace('/,\s*rowid(\s+DESC)?/i', '', $sql));
$st = $db->prepare($sql);
$st->execute(json_decode($argv[3] ?? '[]', true) ?: []);
echo json_encode($st->columnCount() ? $st->fetchAll() : []);
