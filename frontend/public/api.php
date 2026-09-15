<?php
// PHP reverse-proxy shim for Cloudways deployments.
//
// Nginx (the front-facing layer, even on the "Hybrid" Apache+Nginx stack)
// forwards .php requests straight to PHP-FPM -- verified empirically that
// this bypasses Apache's .htaccess/mod_rewrite/mod_proxy entirely (a hard
// "Require all denied" in .htaccess had zero effect on .php requests). So
// instead of a mod_proxy passthrough, this file does the proxying itself.
//
// Only handles REST. WebSocket (/api/live) cannot work through PHP-FPM's
// request/response model -- see frontend/src/ws.js, which degrades to
// "no live updates, use manual refresh" when this shim is active.

$target = $_GET['_p'] ?? null;
if (!is_string($target) || $target === '' || $target[0] !== '/') {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'bad proxy request']);
    exit;
}

$backend = 'http://127.0.0.1:4311/api' . $target;

$method = $_SERVER['REQUEST_METHOD'];
$body = file_get_contents('php://input');

$headers = [];
foreach (getallheaders() as $k => $v) {
    $lk = strtolower($k);
    if (in_array($lk, ['host', 'content-length', 'connection'], true)) continue;
    $headers[] = "$k: $v";
}

$ch = curl_init($backend);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => true,
    CURLOPT_TIMEOUT => 30,
]);
if ($body !== '') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

$response = curl_exec($ch);
if ($response === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'backend unreachable: ' . curl_error($ch)]);
    curl_close($ch);
    exit;
}

$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$rawHeaders = substr($response, 0, $headerSize);
$respBody = substr($response, $headerSize);
curl_close($ch);

http_response_code($statusCode);
foreach (explode("\r\n", $rawHeaders) as $line) {
    if (stripos($line, 'HTTP/') === 0) continue;
    if (stripos($line, 'Transfer-Encoding:') === 0) continue;
    if (stripos($line, 'Connection:') === 0) continue;
    if (trim($line) === '') continue;
    header($line, false);
}
echo $respBody;
