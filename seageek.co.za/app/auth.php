<?php
declare(strict_types=1);

/** Sessions live in the database so any web server behind a load balancer can serve any request. */
final class DbSessionHandler implements SessionHandlerInterface
{
    public function open($path, $name): bool { return true; }
    public function close(): bool { return true; }
    public function read($id): string|false
    {
        $row = DB::one('SELECT data FROM sessions WHERE id = ?', [$id]);
        return $row['data'] ?? '';
    }
    public function write($id, $data): bool
    {
        if (DB::one('SELECT id FROM sessions WHERE id = ?', [$id])) {
            DB::update('sessions', ['data' => $data, 'updated_at' => time()], 'id = ?', [$id]);
        } else {
            DB::insert('sessions', ['id' => $id, 'data' => $data, 'updated_at' => time()]);
        }
        return true;
    }
    public function destroy($id): bool { DB::run('DELETE FROM sessions WHERE id = ?', [$id]); return true; }
    public function gc($max): int|false { return DB::run('DELETE FROM sessions WHERE updated_at < ?', [time() - (int) $max])->rowCount(); }
}

final class Auth
{
    private static ?array $user = null;
    private static bool $loaded = false;

    public static function user(): ?array
    {
        if (!self::$loaded) {
            self::$loaded = true;
            $id = $_SESSION['uid'] ?? null;
            self::$user = $id ? DB::one('SELECT * FROM users WHERE id = ?', [$id]) : null;
        }
        return self::$user;
    }

    public static function id(): ?int { $u = self::user(); return $u ? (int) $u['id'] : null; }

    public static function org(): ?array
    {
        $u = self::user();
        if (!$u || !$u['org_id']) return null;
        if (!empty($u['is_admin']) && !empty($_SESSION['act_as_org'])) {
            return DB::one('SELECT * FROM orgs WHERE id = ?', [$_SESSION['act_as_org']]);
        }
        return DB::one('SELECT * FROM orgs WHERE id = ?', [$u['org_id']]);
    }

    public static function attempt(string $email, string $password): string|true
    {
        $u = DB::one('SELECT * FROM users WHERE email = ?', [strtolower($email)]);
        if ($u && $u['locked_until'] && $u['locked_until'] > now()) {
            return 'Too many failed attempts. Try again in 15 minutes or reset your password.';
        }
        if (!$u || !password_verify($password, $u['password_hash'])) {
            if ($u) {
                $fails = (int) $u['failed_logins'] + 1;
                DB::update('users', ['failed_logins' => $fails, 'locked_until' => $fails >= 5 ? ts('+15 minutes') : null], 'id = ?', [$u['id']]);
            }
            return 'That email and password don\'t match.';
        }
        if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
            DB::update('users', ['password_hash' => password_hash($password, PASSWORD_DEFAULT)], 'id = ?', [$u['id']]);
        }
        self::login((int) $u['id']);
        return true;
    }

    public static function login(int $userId): void
    {
        session_regenerate_id(true);
        $_SESSION['uid'] = $userId;
        unset($_SESSION['act_as_org']);
        DB::update('users', ['last_login_at' => now(), 'failed_logins' => 0, 'locked_until' => null], 'id = ?', [$userId]);
        self::$loaded = false;
    }

    public static function logout(): void
    {
        $_SESSION = [];
        session_regenerate_id(true);
        self::$user = null;
    }

    public static function requireUser(): array
    {
        $u = self::user();
        if (!$u) {
            $_SESSION['after_login'] = $_SERVER['REQUEST_URI'] ?? '/dashboard';
            redirect('/login');
        }
        if (!$u['email_verified_at'] && !$u['is_admin']) redirect('/verify-email');
        return $u;
    }

    public static function requireAdmin(): array
    {
        $u = self::requireUser();
        if (empty($u['is_admin'])) { http_response_code(403); exit('Not allowed.'); }
        return $u;
    }

    /** One-time tokens for email verification and password reset. Only the hash is stored. */
    public static function issueToken(int $userId, string $type, string $ttl): string
    {
        $token = Crypto::token(32);
        DB::run('DELETE FROM tokens WHERE user_id = ? AND type = ?', [$userId, $type]);
        DB::insert('tokens', ['user_id' => $userId, 'type' => $type, 'token_hash' => hash('sha256', $token), 'expires_at' => ts($ttl)]);
        return $token;
    }

    public static function useToken(string $token, string $type): ?int
    {
        $row = DB::one('SELECT * FROM tokens WHERE token_hash = ? AND type = ? AND used_at IS NULL AND expires_at > ?', [hash('sha256', $token), $type, now()]);
        if (!$row) return null;
        DB::update('tokens', ['used_at' => now()], 'id = ?', [$row['id']]);
        return (int) $row['user_id'];
    }

    public static function passwordProblem(string $password): ?string
    {
        if (mb_strlen($password) < 10) return 'Use at least 10 characters for your password.';
        if (in_array(strtolower($password), ['password123', '1234567890', 'qwertyuiop'], true)) return 'Choose a less common password.';
        return null;
    }
}

final class ApiKeys
{
    public static function create(int $orgId, string $env, string $label = ''): string
    {
        $secret = 'sg_' . $env . '_' . Crypto::token(24);
        DB::insert('api_keys', [
            'org_id' => $orgId, 'env' => $env, 'prefix' => substr($secret, 0, 14), 'key_hash' => hash('sha256', $secret),
            'label' => $label ?: ($env === 'live' ? 'Live key' : 'Sandbox key'), 'created_at' => now(),
        ]);
        return $secret;
    }

    /** @return array{key:array, org:array}|null */
    public static function resolve(string $secret): ?array
    {
        if (!preg_match('/^sg_(test|live)_[A-Za-z0-9_-]{20,}$/', $secret)) return null;
        $key = DB::one('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [hash('sha256', $secret)]);
        if (!$key) return null;
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$key['org_id']]);
        if (!$org) return null;
        if (!$key['last_used_at'] || $key['last_used_at'] < ts('-5 minutes')) {
            DB::update('api_keys', ['last_used_at' => now()], 'id = ?', [$key['id']]);
        }
        return ['key' => $key, 'org' => $org];
    }
}

function public_id(string $prefix): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    $s = '';
    for ($i = 0; $i < 12; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return $prefix . '_' . $s;
}

function slugify(string $s): string
{
    $s = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($s)), '-');
    return $s !== '' ? substr($s, 0, 60) : 'org';
}
