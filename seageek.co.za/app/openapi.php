<?php
/** OpenAPI 3.1 description generated from the catalogue. Served at /docs/openapi.json. */
$paths = [];
foreach (Catalog::services() as $slug => $s) {
    foreach ($s['endpoints'] as [$m, $p, $title, $desc, $params, $body, $resp]) {
        $op = ['tags' => [$s['name']], 'summary' => $title, 'description' => $desc, 'responses' => ['200' => ['description' => 'OK', 'content' => ['application/json' => ['example' => $resp]]], 'default' => ['$ref' => '#/components/responses/Error']]];
        if (preg_match_all('/\{(\w+)\}/', $p, $mm)) foreach ($mm[1] as $n) $op['parameters'][] = ['name' => $n, 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']];
        if ($m === 'POST') {
            $props = [];
            $req = [];
            foreach ($params as $pr) {
                $t = str_contains($pr['type'], '[]') ? 'array' : (in_array($pr['type'], ['integer', 'boolean', 'object'], true) ? $pr['type'] : 'string');
                $props[$pr['name']] = ['type' => $t, 'description' => $pr['desc']];
                if ($pr['req']) $req[] = $pr['name'];
            }
            $op['requestBody'] = ['required' => true, 'content' => ['application/json' => ['schema' => ['type' => 'object', 'properties' => $props, 'required' => $req], 'example' => $body]]];
            $op['parameters'][] = ['name' => 'Idempotency-Key', 'in' => 'header', 'required' => false, 'schema' => ['type' => 'string']];
        }
        $paths[$p][strtolower($m)] = $op;
    }
}
foreach (Catalog::platformEndpoints() as [$m, $p, $d]) $paths[$p][strtolower($m)] = ['tags' => ['Account'], 'summary' => $d, 'responses' => ['200' => ['description' => 'OK']]];
return [
    'openapi' => '3.1.0',
    'info' => ['title' => 'SeaGeek API', 'version' => '1.0.0', 'description' => 'SMS, Mail, Auth, WhatsApp, Verify, Voice, AI and Desk. Amounts are in ZAR.', 'contact' => ['email' => 'hello@seageek.co.za']],
    'servers' => [['url' => rtrim(app_url('/api'), '/')]],
    'security' => [['bearer' => []]],
    'components' => [
        'securitySchemes' => ['bearer' => ['type' => 'http', 'scheme' => 'bearer', 'description' => 'sg_test_... for sandbox, sg_live_... for live']],
        'responses' => ['Error' => ['description' => 'Error', 'content' => ['application/json' => ['schema' => ['type' => 'object', 'properties' => ['error' => ['type' => 'object', 'properties' => ['type' => ['type' => 'string'], 'message' => ['type' => 'string']]], 'request_id' => ['type' => 'string']]]]]]],
    ],
    'paths' => $paths,
];
