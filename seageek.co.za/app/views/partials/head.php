<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title><?= e(str_contains($title ?? '', 'SeaGeek') ? $title : (($title ?? '') . ' | SeaGeek')) ?></title>
<meta name="description" content="<?= e($description ?? 'SeaGeek: SMS, email, WhatsApp, identity verification, voice, AI and help desk APIs for South Africa, billed in rand.') ?>">
<meta name="theme-color" content="#04090c">
<meta property="og:title" content="<?= e($title ?? 'SeaGeek') ?>">
<meta property="og:image" content="<?= e(app_url('/assets/img/og-image.png')) ?>">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Urbanist:wght@600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/app.css?v=10">
