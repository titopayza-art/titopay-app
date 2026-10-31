#!/usr/bin/env bash
# TicketRoom on your own server: Ubuntu 24.04, run once as root.
#
#   sudo bash setup-ubuntu.sh ticketroom.co.za you@example.com
#
# Installs and locks down nginx, PHP 8.3 (FPM), MariaDB, Let's Encrypt,
# a firewall, fail2ban and automatic security updates; creates the database
# and its user; sets up the site folders, the cron job and nightly encrypted
# backups. Safe to run again: it skips what is already done.
#
# Before running: point the domain's DNS at this server (or at Cloudflare,
# proxied, with SSL mode "Full (strict)"), and log in with an SSH key.
set -euo pipefail

DOMAIN="${1:?usage: setup-ubuntu.sh <domain> <admin email>}"
EMAIL="${2:?usage: setup-ubuntu.sh <domain> <admin email>}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT=/opt/ticketroom   # the kit's own copy: redeploying the site never touches it
SITE=/var/www/ticketroom
DB=ticketroom
DBUSER=ticketroom
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
[ -n "$(ls -A /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null)" ] || { echo "Add an SSH key for your login first: password logins are switched off by this script." >&2; exit 1; }

mkdir -p "$KIT"
cp "$SRC"/*.sh "$SRC"/*.conf "$SRC"/*.cnf "$KIT"/ 2>/dev/null || true
chmod 700 "$KIT"/*.sh
echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx php8.3-fpm php8.3-mysql php8.3-sqlite3 php8.3-curl php8.3-mbstring php8.3-xml php8.3-gd php8.3-zip php8.3-intl php8.3-bcmath \
  mariadb-server certbot python3-certbot-nginx ufw fail2ban unattended-upgrades gnupg

echo "== automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades
cat > /etc/apt/apt.conf.d/52ticketroom-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
EOF

echo "== SSH: keys only, no root password"
cat > /etc/ssh/sshd_config.d/90-ticketroom.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowAgentForwarding no
EOF
sshd -t && systemctl reload ssh

echo "== firewall: SSH, HTTP and HTTPS only"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== kernel network hardening"
cat > /etc/sysctl.d/90-ticketroom.conf <<'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
fs.file-max = 200000
EOF
sysctl --system >/dev/null

echo "== site user and folders"
id ticketroom >/dev/null 2>&1 || useradd --system --home "$SITE" --shell /usr/sbin/nologin ticketroom
mkdir -p "$SITE/public_html" "$SITE/ticketroom-data" /var/www/letsencrypt
chown -R ticketroom:ticketroom "$SITE"
chmod 750 "$SITE/ticketroom-data"
chmod 755 "$SITE" "$SITE/public_html"
usermod -aG ticketroom www-data   # nginx reads the public files, never the data folder

echo "== database"
cp "$KIT/mariadb-ticketroom.cnf" /etc/mysql/mariadb.conf.d/90-ticketroom.cnf
# Size the buffer pool to 40% of memory.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
sed -i "s/^innodb_buffer_pool_size = .*/innodb_buffer_pool_size = $((MEM_MB * 40 / 100))M/" /etc/mysql/mariadb.conf.d/90-ticketroom.cnf
systemctl restart mariadb
# Remove test databases and anonymous users (what mysql_secure_installation does).
mariadb -e "DELETE FROM mysql.global_priv WHERE User=''; DROP DATABASE IF EXISTS test; DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%'; FLUSH PRIVILEGES;"
CRED=/root/.ticketroom-db
if [ ! -f "$CRED" ]; then
  DBPASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
  mariadb -e "CREATE DATABASE IF NOT EXISTS $DB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
    CREATE USER IF NOT EXISTS '$DBUSER'@'localhost' IDENTIFIED BY '$DBPASS';
    GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, TRIGGER, LOCK TABLES, SHOW VIEW ON $DB.* TO '$DBUSER'@'localhost';
    GRANT PROCESS ON *.* TO '$DBUSER'@'localhost';
    FLUSH PRIVILEGES;"
  umask 077; printf 'DBPASS=%s\n' "$DBPASS" > "$CRED"
fi
. "$CRED"

echo "== site settings (database connection)"
CONF="$SITE/ticketroom-data/config.php"
if [ ! -f "$CONF" ]; then
  umask 077
  cat > "$CONF" <<PHP
<?php
// Private settings for this server. Never upload this file anywhere.
return [
    'baseUrl' => 'https://$DOMAIN',
    'database' => ['driver' => 'mysql', 'socket' => '/run/mysqld/mysqld.sock', 'name' => '$DB', 'user' => '$DBUSER', 'pass' => '$DBPASS'],
    // Behind Cloudflare: trust its forwarded visitor IP (nginx already
    // restores it from CF-Connecting-IP; see cloudflare-ips.conf).
];
PHP
  chown ticketroom:ticketroom "$CONF"
  chmod 600 "$CONF"
fi

echo "== PHP"
MAXC=$(( (MEM_MB * 45 / 100) / 64 )); [ "$MAXC" -lt 10 ] && MAXC=10
sed "s/^pm.max_children = .*/pm.max_children = $MAXC/" "$KIT/php-fpm-ticketroom.conf" > /etc/php/8.3/fpm/pool.d/ticketroom.conf
rm -f /etc/php/8.3/fpm/pool.d/www.conf
systemctl restart php8.3-fpm

echo "== nginx"
"$KIT/cloudflare-ips.sh" > /etc/nginx/conf.d/cloudflare-ips.conf || echo "(Cloudflare ranges not fetched; run cloudflare-ips.sh later)"
sed "s/ticketroom\.co\.za/$DOMAIN/g" "$KIT/nginx-ticketroom.conf" > /etc/nginx/sites-available/ticketroom
sed -i 's/^\s*# server_tokens.*//' /etc/nginx/nginx.conf
grep -q "^\s*server_tokens off" /etc/nginx/nginx.conf || sed -i 's/http {/http {\n\tserver_tokens off;/' /etc/nginx/nginx.conf
rm -f /etc/nginx/sites-enabled/default
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  # First a plain HTTP server to answer the certificate check.
  cat > /etc/nginx/sites-enabled/ticketroom-acme <<EOF
server { listen 80; server_name $DOMAIN www.$DOMAIN; location /.well-known/acme-challenge/ { root /var/www/letsencrypt; } }
EOF
  systemctl reload nginx
  certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -d "www.$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
  rm -f /etc/nginx/sites-enabled/ticketroom-acme
fi
ln -sf /etc/nginx/sites-available/ticketroom /etc/nginx/sites-enabled/ticketroom
nginx -t && systemctl reload nginx

echo "== fail2ban"
cp "$KIT/fail2ban-ticketroom.conf" /etc/fail2ban/jail.d/ticketroom.conf
systemctl restart fail2ban

echo "== cron: site jobs every 5 minutes, encrypted backup every night"
cat > /etc/cron.d/ticketroom <<EOF
*/5 * * * * ticketroom /usr/bin/php $SITE/public_html/api/cron.php >/dev/null 2>>$SITE/ticketroom-data/cron-errors.log
40 1 * * * root $KIT/backup-offsite.sh >>/var/log/ticketroom-backup.log 2>&1
20 4 * * 1 root $KIT/cloudflare-ips.sh > /etc/nginx/conf.d/cloudflare-ips.conf && nginx -t && systemctl reload nginx
EOF

echo
echo "Done. Next:"
echo " 1. Open https://$DOMAIN/setup.php and create the owner account (DEPLOY-SERVER.md, step 5)."
echo " 2. Put the backup passphrase and off-site remote in /root/.ticketroom-backup (DEPLOY-SERVER.md, step 6)."
