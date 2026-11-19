<?php
[$pageTitle, , $lead] = Docs::guides()[$slug];
require __DIR__ . '/_top.php';
require __DIR__ . '/guides/' . $slug . '.php';
require __DIR__ . '/_bottom.php';
