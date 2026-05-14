<?php
/**
 * Proxy que traduz requisições OpenAI TTS → Gemini TTS.
 * Hospede na Hostinger e aponte o TTS Server pra cá.
 *
 * Endpoint: https://seudominio.com/tts/index.php/v1/audio/speech
 * Ou com .htaccess: https://seudominio.com/tts/v1/audio/speech
 */

// ─── Carrega secrets ─────────────────────────────────────
$envPaths = [
    dirname($_SERVER['DOCUMENT_ROOT'] ?? '') . '/.env.php',  // acima do public_html
    __DIR__ . '/.env.php',                                   // mesma pasta
];
foreach ($envPaths as $envFile) {
    if (file_exists($envFile)) { require $envFile; break; }
}

// ─── Configuração ───────────────────────────────────────────
define('DEFAULT_MODEL', 'gemini-2.5-flash-preview-tts');
define('DEFAULT_VOICE', 'Kore');
define('CACHE_DIR', __DIR__ . '/cache');
define('CACHE_TTL', 86400 * 7); // 7 dias

// Pool de API keys — preencha no .env.php com putenv('GEMINI_KEY_1=...') etc.
$apiKeys = array_filter([
    getenv('GEMINI_API_KEY') ?: '',
    getenv('GEMINI_KEY_1') ?: '',
    getenv('GEMINI_KEY_2') ?: '',
    getenv('GEMINI_KEY_3') ?: '',
    getenv('GEMINI_KEY_4') ?: '',
    getenv('GEMINI_KEY_5') ?: '',
    getenv('GEMINI_KEY_6') ?: '',
    getenv('GEMINI_KEY_7') ?: '',
    getenv('GEMINI_KEY_8') ?: '',
    getenv('GEMINI_KEY_9') ?: '',
    getenv('GEMINI_KEY_10') ?: '',
]);
$apiKeys = array_values(array_unique($apiKeys));

// Token de autenticação simples — defina algo secreto aqui
// O TTS Server envia como header: Authorization: Bearer SEU_TOKEN
define('AUTH_TOKEN', getenv('AUTH_TOKEN') ?: '');

// ─── Mapeamento vozes OpenAI → Gemini ───────────────────────
$voiceMap = [
    'alloy'   => 'Kore',
    'echo'    => 'Charon',
    'fable'   => 'Puck',
    'onyx'    => 'Enceladus',
    'nova'    => 'Zephyr',
    'shimmer' => 'Sulafat',
];

// ─── Roteamento ─────────────────────────────────────────────
$uri = $_SERVER['REQUEST_URI'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Extrai apenas a parte relevante do path (a partir de /v1/...)
$path = parse_url($uri, PHP_URL_PATH);
// Remove prefixo do diretório (ex: /gemini-tts-php/) e index.php
if (preg_match('#(/v1/.*)$#', $path, $m)) {
    $path = $m[1];
} else {
    $path = preg_replace('#^.*/index\.php#', '', $path);
    $path = rtrim($path, '/');
    if ($path === '') $path = '/';
}

if ($method === 'GET' && ($path === '/health' || $path === '')) {
    header('Content-Type: text/plain');
    echo 'ok';
    exit;
}

if ($method === 'GET' && $path === '/v1/voices') {
    $voices = ['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
        'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba',
        'Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat',
        'Vindemiatrix','Sadachbia','Sadaltager','Schedar','Zubenelgenubi',
        'Zubeneschamali','Achernar','Rasalgethi','Alnilam','Sirius'];
    header('Content-Type: application/json');
    echo json_encode(['voices' => array_map(fn($v) => ['name' => $v, 'voice_id' => $v], $voices)]);
    exit;
}

// Aceita GET e POST para síntese

// ─── Debug: retorna tudo que o servidor recebeu ─────────────
if (isset($_GET['debug'])) {
    header('Content-Type: application/json');
    echo json_encode([
        'method'       => $method,
        'path'         => $path,
        'query_string' => $_SERVER['QUERY_STRING'] ?? '',
        'get_params'   => $_GET,
        'post_params'  => $_POST,
        'raw_body'     => file_get_contents('php://input'),
        'content_type' => $_SERVER['CONTENT_TYPE'] ?? '',
        'headers'      => getallheaders(),
        'request_uri'  => $_SERVER['REQUEST_URI'] ?? '',
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    exit;
}

// ─── Autenticação (header ou query param ?token=) ───────────
if (AUTH_TOKEN !== '') {
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    $tokenFromHeader = str_replace('Bearer ', '', $authHeader);
    $tokenFromQuery = $_GET['token'] ?? '';
    if ($tokenFromHeader !== AUTH_TOKEN && $tokenFromQuery !== AUTH_TOKEN) {
        http_response_code(401);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Token inválido']);
        exit;
    }
}

// ─── Leitura dos parâmetros (GET, POST JSON, POST form, POST raw) ───
$data = [];
$rawBody = '';

if ($method === 'POST' || $method === 'GET') {
    $rawBody = file_get_contents('php://input');
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';

    if (str_contains($contentType, 'application/json')) {
        $data = json_decode($rawBody, true) ?: [];
    } elseif (!empty($rawBody) && str_contains($rawBody, '=')) {
        // form-urlencoded: input=texto&voice=Kore
        parse_str($rawBody, $data);
    }
    // Se não é JSON nem form-encoded, o body raw é o próprio texto
}

// Prioridade: data[input] > GET[input] > GET[text] > body raw
$text = $data['input'] ?? $_GET['input'] ?? $_GET['text'] ?? '';
if (empty($text) && !empty($rawBody) && !str_contains($rawBody, '=') && !str_contains($rawBody, '{')) {
    $text = $rawBody;
}

if (empty($text)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Texto vazio. Envie via body, input= ou ?text=']);
    exit;
}

$voiceKey = $data['voice'] ?? $_GET['voice'] ?? DEFAULT_VOICE;
$model = $data['model'] ?? $_GET['model'] ?? '';
$responseFormat = $data['response_format'] ?? $_GET['format'] ?? 'wav';
$speed = $data['speed'] ?? $_GET['speed'] ?? '1.0';

// Mapeia voz OpenAI → Gemini, ou usa direto
$voice = $voiceMap[$voiceKey] ?? $voiceKey;

// Escolhe modelo Gemini
if (str_contains($model, 'pro') || str_contains($model, 'hd')) {
    $geminiModel = 'gemini-2.5-pro-preview-tts';
} elseif (str_contains($model, '3.1') || str_contains($model, 'flash-3')) {
    $geminiModel = 'gemini-3.1-flash-tts-preview';
} else {
    $geminiModel = DEFAULT_MODEL;
}

// ─── Cache: verifica se já temos o áudio ────────────────────
$cacheKey = md5($text . $voice . $geminiModel);
$cacheFile = CACHE_DIR . '/' . substr($cacheKey, 0, 2) . '/' . $cacheKey . '.pcm';

if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < CACHE_TTL) {
    $pcmData = file_get_contents($cacheFile);
} else {
    // ─── Chamada à API Gemini com fallback de keys ───────────────
    if (empty($apiKeys)) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Nenhuma API key configurada']);
        exit;
    }

    $payload = json_encode([
        'contents' => [['parts' => [['text' => $text]]]],
        'generationConfig' => [
            'responseModalities' => ['AUDIO'],
            'speechConfig' => [
                'voiceConfig' => [
                    'prebuiltVoiceConfig' => ['voiceName' => $voice]
                ]
            ]
        ]
    ]);

    // Round-robin com retry+backoff quando todas as keys retornam 429
    $startIndex = crc32($text) % count($apiKeys);
    $audioB64 = null;
    $lastError = '';
    $maxRetries = 2;         // tentativas extras após esgotar todas as keys
    $retryDelaySec = 3;      // 3s entre retries — mantém resposta total < 15s

    for ($retry = 0; $retry <= $maxRetries; $retry++) {
        $all429 = true;

        for ($attempt = 0; $attempt < count($apiKeys); $attempt++) {
            $keyIndex = ($startIndex + $attempt) % count($apiKeys);
            $key = $apiKeys[$keyIndex];
            $url = "https://generativelanguage.googleapis.com/v1beta/models/{$geminiModel}:generateContent?key={$key}";

            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => $payload,
                CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 60,
                CURLOPT_CONNECTTIMEOUT => 10,
            ]);

            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlError = curl_error($ch);
            curl_close($ch);

            if ($curlError) {
                $lastError = "Erro de conexão: {$curlError}";
                $all429 = false;
                continue;
            }

            // 429 (quota) → tenta próxima key
            if ($httpCode === 429) {
                $lastError = "Key #{$keyIndex} retornou 429 (quota)";
                continue;
            }

            // 403 (key inválida) → tenta próxima key
            if ($httpCode === 403) {
                $lastError = "Key #{$keyIndex} retornou 403";
                $all429 = false;
                continue;
            }

            $all429 = false;

            if ($httpCode !== 200) {
                $lastError = "HTTP {$httpCode}: {$response}";
                continue;
            }

            $result = json_decode($response, true);
            $audioB64 = $result['candidates'][0]['content']['parts'][0]['inlineData']['data'] ?? null;

            if ($audioB64) break 2; // sucesso — sai dos dois loops
            $lastError = 'Resposta sem áudio';
        }

        // Se todas as keys deram 429 e ainda temos retries, espera e tenta de novo
        if ($all429 && $retry < $maxRetries) {
            sleep($retryDelaySec);
        } else {
            break;
        }
    }

    if (!$audioB64) {
        http_response_code(502);
        header('Content-Type: application/json');
        echo json_encode(['error' => "Falha após " . ($retry + 1) . " tentativa(s). Último erro: {$lastError}"]);
        exit;
    }

    $pcmData = base64_decode($audioB64);

    // Salva no cache
    $cacheSubdir = dirname($cacheFile);
    if (!is_dir($cacheSubdir)) mkdir($cacheSubdir, 0755, true);
    file_put_contents($cacheFile, $pcmData);
}

// ─── Retorna áudio ──────────────────────────────────────────
if ($responseFormat === 'pcm') {
    header('Content-Type: audio/pcm');
    echo $pcmData;
} else {
    // Monta header WAV
    $sampleRate = 24000;
    $bitsPerSample = 16;
    $channels = 1;
    $dataSize = strlen($pcmData);
    $byteRate = $sampleRate * $channels * $bitsPerSample / 8;
    $blockAlign = $channels * $bitsPerSample / 8;

    $wav = pack('A4VA4', 'RIFF', 36 + $dataSize, 'WAVE');
    $wav .= pack('A4VvvVVvv', 'fmt ', 16, 1, $channels, $sampleRate, $byteRate, $blockAlign, $bitsPerSample);
    $wav .= pack('A4V', 'data', $dataSize);
    $wav .= $pcmData;

    header('Content-Type: audio/wav');
    header('Content-Length: ' . strlen($wav));
    echo $wav;
}
