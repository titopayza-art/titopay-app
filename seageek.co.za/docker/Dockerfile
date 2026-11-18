# SeaGeek web + API container. Stateless: config comes from SG_* environment variables,
# sessions and data live in MySQL, so you can run as many copies as you need.
FROM php:8.3-apache

RUN apt-get update && apt-get install -y --no-install-recommends libcurl4-openssl-dev libonig-dev \
 && docker-php-ext-install pdo_mysql mbstring curl \
 && a2enmod rewrite headers expires deflate \
 && rm -rf /var/lib/apt/lists/*

RUN { echo 'expose_php=Off'; echo 'memory_limit=256M'; echo 'max_execution_time=60'; echo 'upload_max_filesize=10M'; echo 'post_max_size=12M'; } > /usr/local/etc/php/conf.d/seageek.ini \
 && sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf

WORKDIR /var/www/html
COPY . /var/www/html
RUN rm -f app/config.php && chown -R www-data:www-data storage

HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost/health || exit 1
