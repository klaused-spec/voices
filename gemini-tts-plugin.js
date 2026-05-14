// Plugin Gemini TTS para TTS Server (jing332)
// Após importar, vá em: Mais opções (⋮) → Configurar variáveis
// Defina: url, token, voice (opcional)

var baseUrl = ttsrv.userVars['url'] || ''
var authToken = ttsrv.userVars['token'] || ''
var defaultVoice = ttsrv.userVars['voice'] || 'Kore'

var format = "audio/wav"
var sampleRate = 24000

// Todas as vozes Gemini disponíveis
var geminiVoices = [
    { name: "Zephyr",           desc: "Brilhante",    gender: "F" },
    { name: "Puck",             desc: "Animada",       gender: "M" },
    { name: "Charon",           desc: "Informativa",   gender: "M" },
    { name: "Kore",             desc: "Firme",         gender: "F" },
    { name: "Fenrir",           desc: "Excitante",     gender: "M" },
    { name: "Leda",             desc: "Jovem",         gender: "F" },
    { name: "Orus",             desc: "Firme",         gender: "M" },
    { name: "Aoede",            desc: "Brilhante",     gender: "F" },
    { name: "Callirrhoe",       desc: "Suave",         gender: "F" },
    { name: "Autonoe",          desc: "Brilhante",     gender: "F" },
    { name: "Enceladus",        desc: "Grave",         gender: "M" },
    { name: "Iapetus",          desc: "Clara",         gender: "M" },
    { name: "Umbriel",          desc: "Calma",         gender: "M" },
    { name: "Algieba",          desc: "Suave",         gender: "F" },
    { name: "Despina",          desc: "Suave",         gender: "F" },
    { name: "Erinome",          desc: "Clara",         gender: "F" },
    { name: "Gacrux",           desc: "Madura",        gender: "M" },
    { name: "Laomedeia",        desc: "Animada",       gender: "F" },
    { name: "Pulcherrima",      desc: "Avançada",      gender: "F" },
    { name: "Sulafat",          desc: "Quente",        gender: "F" },
    { name: "Vindemiatrix",     desc: "Delicada",      gender: "F" },
    { name: "Sadachbia",        desc: "Animada",       gender: "M" },
    { name: "Sadaltager",       desc: "Culta",         gender: "M" },
    { name: "Schedar",          desc: "Acolhedora",    gender: "F" },
    { name: "Zubenelgenubi",    desc: "Casual",        gender: "M" },
    { name: "Zubeneschamali",   desc: "Equilibrada",   gender: "M" },
    { name: "Achernar",         desc: "Suave",         gender: "F" },
    { name: "Rasalgethi",       desc: "Informativa",   gender: "M" },
    { name: "Alnilam",          desc: "Firme",         gender: "M" },
    { name: "Sirius",           desc: "Expressiva",    gender: "F" },
]

// Idiomas suportados pelo Gemini TTS
var supportedLocales = [
    "pt-BR", "pt-PT", "en-US", "en-GB", "es-ES", "es-MX",
    "fr-FR", "de-DE", "it-IT", "ja-JP", "ko-KR", "zh-CN",
    "zh-TW", "ru-RU", "ar-XA", "hi-IN", "nl-NL", "pl-PL",
    "sv-SE", "tr-TR", "vi-VN", "th-TH", "id-ID", "uk-UA",
    "cs-CZ", "da-DK", "fi-FI", "el-GR", "he-IL", "hu-HU",
    "nb-NO", "ro-RO", "sk-SK", "bg-BG", "ca-ES", "hr-HR",
    "lt-LT", "lv-LV", "sl-SI", "sr-RS", "af-ZA", "sw-KE",
    "ms-MY", "fil-PH", "bn-IN", "ta-IN", "te-IN", "mr-IN",
    "gu-IN", "kn-IN", "ml-IN", "pa-IN", "ur-PK",
]

let PluginJS = {
    "name": "Gemini TTS",
    "id": "dev.kkirner.gemini-tts",
    "author": "kkirner",
    "description": "Google Gemini TTS via proxy. Suporta pt-BR e 50+ idiomas.",
    "version": 1,

    "vars": {
        url:   { label: "URL do proxy", hint: "Ex: https://api01.meulavoro.com.br/gemini-tts-php" },
        token: { label: "Token de autenticação" },
        voice: { label: "Voz padrão", hint: "Ex: Kore, Sulafat, Charon..." },
    },

    "onLoad": function () {
        baseUrl = ttsrv.userVars['url'] || ''
        // Remove barra final
        while (baseUrl.length > 0 && baseUrl.charAt(baseUrl.length - 1) === '/') {
            baseUrl = baseUrl.substring(0, baseUrl.length - 1)
        }
        authToken = ttsrv.userVars['token'] || ''
        defaultVoice = ttsrv.userVars['voice'] || 'Kore'

        if (!baseUrl) {
            throw "Configure a URL do proxy nas variáveis do plugin."
        }
    },

    "getAudio": function (text, locale, voice, rate, volume, pitch) {
        if (!voice || voice === '') {
            voice = defaultVoice
        }

        var url = baseUrl + '/?voice=' + encodeURIComponent(voice)
        if (authToken) {
            url += '&token=' + encodeURIComponent(authToken)
        }

        var headers = {
            "Content-Type": "text/plain; charset=utf-8",
        }

        // O proxy já faz retry interno com backoff no 429
        var resp = ttsrv.httpPost(url, text, headers)

        if (resp.code() === 200) {
            return resp.body().byteStream()
        }

        if (resp.code() === 429) {
            throw "Quota excedida. Aguarde ou adicione mais API keys no proxy."
        }

        var errBody = ''
        try { errBody = resp.body().string() } catch(e) {}
        throw "Erro " + resp.code() + ": " + errBody
    },
}

let EditorJS = {
    "getAudioSampleRate": function (locale, voice) {
        return sampleRate
    },

    "getLocales": function () {
        return supportedLocales
    },

    "getVoices": function (locale) {
        let mm = {}
        geminiVoices.forEach(function (v) {
            mm[v.name] = new java.lang.String(v.name + ' - ' + v.desc + ' (' + v.gender + ')')
        })
        return mm
    },

    "onLoadData": function () {
        // Vozes são estáticas, não precisa carregar
    },

    "onLoadUI": function (ctx, linearLayout) {
        // UI simples, sem controles extras
    },

    "onVoiceChanged": function (locale, voiceCode) {
        // Nada a fazer
    },
}
