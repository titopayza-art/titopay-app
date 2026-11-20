<?php
/**
 * Ready-made store plugins. Each download is pre-filled with one store's private link and secret,
 * so a shop owner installs it and order SMS start working with nothing to type.
 */
declare(strict_types=1);

final class StorePlugins
{
    /** platform => [label, file name, short description] */
    public static function forPlatform(string $platform): array
    {
        return match ($platform) {
            'woocommerce' => ['wordpress' => ['WordPress plugin', 'seageek-sms-woocommerce.zip', 'Upload in WordPress under Plugins, Add new, Upload plugin, then activate.']],
            'opencart', 'prestashop', 'magento', 'other' => ['php' => ['PHP drop-in file', 'seageek-store.php', 'One file for any PHP store. Include it and call one function when an order changes.']],
            default => [],
        };
    }

    public static function wordpressZip(array $store): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'sgwp');
        $zip = new ZipArchive();
        $zip->open($tmp, ZipArchive::OVERWRITE);
        $zip->addFromString('seageek-sms/seageek-sms.php', self::wordpressPlugin($store));
        $zip->addFromString('seageek-sms/readme.txt', "=== SeaGeek SMS for WooCommerce ===\nSends order SMS to your customers through SeaGeek: order placed, paid, completed (shipped), cancelled and refunded.\nThis copy is already connected to the store \"{$store['name']}\". Change the messages in your SeaGeek dashboard under Store SMS.\n");
        $zip->close();
        $data = (string) file_get_contents($tmp);
        @unlink($tmp);
        return $data;
    }

    private static function wordpressPlugin(array $store): string
    {
        $hook = var_export(Stores::hookUrl($store), true);
        $secret = var_export((string) Stores::secret($store), true);
        $name = str_replace(['*/', "\n"], '', $store['name']);
        return <<<PHP
<?php
/**
 * Plugin Name: SeaGeek SMS for WooCommerce
 * Description: Order SMS for {$name}, sent through SeaGeek. Messages are set in your SeaGeek dashboard under Store SMS.
 * Version: 1.0.0
 * Author: SeaGeek Technologies
 * Author URI: https://www.seageek.co.za
 * Requires Plugins: woocommerce
 */
if (!defined('ABSPATH')) exit;

const SEAGEEK_STORE_LINK = {$hook};
const SEAGEEK_STORE_SECRET = {$secret};

function seageek_send(string \$event, \$order): void
{
    if (!\$order instanceof WC_Order) return;
    \$body = wp_json_encode([
        'event' => \$event,
        'order' => [
            'id' => (string) \$order->get_id(),
            'number' => (string) \$order->get_order_number(),
            'total' => (string) \$order->get_total(),
            'currency' => (string) \$order->get_currency(),
            'tracking_url' => (string) \$order->get_meta('_tracking_url'),
            'tracking_number' => (string) \$order->get_meta('_tracking_number'),
            'refund_amount' => \$event === 'order.refunded' ? (string) \$order->get_total_refunded() : '',
        ],
        'customer' => [
            'first_name' => (string) \$order->get_billing_first_name(),
            'phone' => (string) (\$order->get_billing_phone() ?: \$order->get_shipping_phone()),
            'email' => (string) \$order->get_billing_email(),
            'accepts_marketing' => \$order->get_meta('_seageek_sms_optin') === 'yes',
        ],
    ]);
    wp_remote_post(SEAGEEK_STORE_LINK, [
        'timeout' => 8,
        'blocking' => false,
        'headers' => ['Content-Type' => 'application/json', 'X-SeaGeek-Signature' => 'sha256=' . hash_hmac('sha256', \$body, SEAGEEK_STORE_SECRET)],
        'body' => \$body,
    ]);
}

add_action('woocommerce_new_order', function (\$id) { seageek_send('order.created', wc_get_order(\$id)); });
add_action('woocommerce_order_status_changed', function (\$id, \$from, \$to) {
    \$map = ['processing' => 'order.paid', 'completed' => 'order.shipped', 'cancelled' => 'order.cancelled', 'refunded' => 'order.refunded'];
    if (isset(\$map[\$to])) seageek_send(\$map[\$to], wc_get_order(\$id));
}, 10, 3);

// Optional tick box at checkout: customers who tick it join your SMS marketing list in SeaGeek.
add_action('woocommerce_review_order_before_submit', function () {
    echo '<p class="form-row"><label><input type="checkbox" name="seageek_sms_optin" value="yes"> Send me SMS offers. Reply STOP to opt out.</label></p>';
});
add_action('woocommerce_checkout_create_order', function (\$order) {
    if (!empty(\$_POST['seageek_sms_optin'])) \$order->update_meta_data('_seageek_sms_optin', 'yes');
});

PHP;
    }

    public static function phpDropIn(array $store): string
    {
        $hook = var_export(Stores::hookUrl($store), true);
        $secret = var_export((string) Stores::secret($store), true);
        return <<<PHP
<?php
/**
 * SeaGeek store SMS drop-in for {$store['name']}.
 * Works with OpenCart, PrestaShop, Magento or any PHP store (PHP 7.4+ with cURL).
 *
 * 1. Upload this file to your store.
 * 2. require_once it where your store saves or updates an order.
 * 3. Call seageek_store_event() with the event, the order and the customer:
 *
 *    seageek_store_event('order.created', ['number' => '1042', 'total' => '899.00'], ['first_name' => 'Thandi', 'phone' => '0821234567']);
 *
 * Events: order.created, order.paid, order.shipped (add 'tracking_url'), order.cancelled,
 * order.refunded (add 'refund_amount'), checkout.abandoned (add \$checkoutUrl).
 * The messages themselves are set in your SeaGeek dashboard under Store SMS.
 */

const SEAGEEK_STORE_LINK = {$hook};
const SEAGEEK_STORE_SECRET = {$secret};

function seageek_store_event(string \$event, array \$order, array \$customer, string \$checkoutUrl = ''): bool
{
    \$body = json_encode(['event' => \$event, 'order' => \$order, 'customer' => \$customer, 'checkout_url' => \$checkoutUrl]);
    \$ch = curl_init(SEAGEEK_STORE_LINK);
    curl_setopt_array(\$ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => \$body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-SeaGeek-Signature: sha256=' . hash_hmac('sha256', \$body, SEAGEEK_STORE_SECRET)],
    ]);
    \$ok = curl_exec(\$ch) !== false && curl_getinfo(\$ch, CURLINFO_HTTP_CODE) < 300;
    curl_close(\$ch);
    return \$ok;
}

PHP;
    }
}
