<!doctype html>
<html lang="en-ZA">
<head><?php require APP_DIR . '/views/partials/head.php'; ?></head>
<body class="auth-body">
<main class="auth-card">
  <a class="brand" href="/"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>SeaGeek</span></a>
  <?php require APP_DIR . '/views/partials/flash.php'; ?>
  <?= $content ?>
</main>
</body>
</html>
