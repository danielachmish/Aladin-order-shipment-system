<?php
// This file exists only so Nginx's .php routing rule forwards requests here
// to Apache (see .htaccess in this same directory, which is what actually
// handles every request -- mod_rewrite intercepts before this file ever
// runs). If you're seeing this response, .htaccess/mod_proxy isn't active;
// check that mod_rewrite/mod_proxy are enabled and AllowOverride is set.
http_response_code(502);
header('Content-Type: application/json');
echo json_encode(['error' => 'proxy misconfigured: .htaccess did not intercept this request']);
