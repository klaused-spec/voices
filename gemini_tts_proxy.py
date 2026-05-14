#!/usr/bin/env python3
"""
Proxy que traduz requisições no formato OpenAI TTS → Gemini TTS.
O TTS Server (Android) aponta pra cá como se fosse um endpoint Azure OpenAI.

Uso:
    export GEMINI_API_KEY=sua_chave
    python gemini_tts_proxy.py

O TTS Server deve apontar para: http://<ip-do-pc>:5000/v1/audio/speech
"""

import os
import base64
import struct
import json
import logging
from flask import Flask, request, Response
import requests as http_requests

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

API_KEY = os.environ.get("GEMINI_API_KEY", "")
DEFAULT_MODEL = "gemini-2.5-flash-preview-tts"

# Mapeamento vozes OpenAI → Gemini (pode usar nomes Gemini direto também)
VOICE_MAP = {
    "alloy": "Kore",       # Firma
    "echo": "Charon",      # Informativa
    "fable": "Puck",       # Animada
    "onyx": "Enceladus",   # Grave/breathy
    "nova": "Zephyr",      # Brilhante
    "shimmer": "Sulafat",  # Quente
}

# Todas as vozes Gemini disponíveis (use direto no campo "voice" do TTS Server)
GEMINI_VOICES = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda",
    "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus",
    "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome",
    "Gacrux", "Laomedeia", "Pulcherrima", "Sulafat", "Vindemiatrix",
    "Sadachbia", "Sadaltager", "Schedar", "Zubenelgenubi",
    "Zubeneschamali", "Achernar", "Rasalgethi", "Alnilam", "Sirius",
]


def pcm_to_wav(pcm_data: bytes, sample_rate: int = 24000,
               bits_per_sample: int = 16, channels: int = 1) -> bytes:
    """Adiciona header WAV aos dados PCM raw do Gemini."""
    data_size = len(pcm_data)
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + data_size, b'WAVE',
        b'fmt ', 16, 1, channels,
        sample_rate, byte_rate, block_align, bits_per_sample,
        b'data', data_size,
    )
    return header + pcm_data


@app.route("/v1/audio/speech", methods=["POST"])
def synthesize():
    """Endpoint compatível com OpenAI TTS API."""
    data = request.json or {}
    text = data.get("input", "")
    voice_key = data.get("voice", "Kore")
    model = data.get("model", "")

    if not text:
        return Response(
            json.dumps({"error": "Campo 'input' vazio"}),
            status=400, mimetype="application/json",
        )

    # Mapeia voz OpenAI → Gemini, ou usa direto se já for nome Gemini
    voice = VOICE_MAP.get(voice_key, voice_key)

    # Escolhe modelo Gemini: "pro" ou "hd" → qualidade alta, senão flash
    if "pro" in model or "hd" in model:
        gemini_model = "gemini-2.5-pro-preview-tts"
    elif "3.1" in model or "flash-3" in model:
        gemini_model = "gemini-3.1-flash-tts-preview"
    else:
        gemini_model = DEFAULT_MODEL

    logging.info("TTS: voz=%s modelo=%s texto=%d chars", voice, gemini_model, len(text))

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{gemini_model}:generateContent?key={API_KEY}"
    )

    payload = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": voice}
                }
            },
        },
    }

    try:
        resp = http_requests.post(url, json=payload, timeout=60)
    except http_requests.RequestException as e:
        logging.error("Erro na requisição Gemini: %s", e)
        return Response(
            json.dumps({"error": str(e)}),
            status=502, mimetype="application/json",
        )

    if resp.status_code != 200:
        logging.error("Gemini retornou %d: %s", resp.status_code, resp.text[:200])
        return Response(resp.text, status=resp.status_code, mimetype="application/json")

    result = resp.json()

    try:
        audio_b64 = result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    except (KeyError, IndexError):
        logging.error("Resposta inesperada: %s", json.dumps(result)[:300])
        return Response(
            json.dumps({"error": "Resposta inesperada da API Gemini"}),
            status=500, mimetype="application/json",
        )

    pcm_data = base64.b64decode(audio_b64)

    # Retorna no formato solicitado (WAV por padrão)
    fmt = data.get("response_format", "wav")
    if fmt == "pcm":
        return Response(pcm_data, mimetype="audio/pcm")
    else:
        wav_data = pcm_to_wav(pcm_data)
        return Response(wav_data, mimetype="audio/wav")


@app.route("/v1/voices", methods=["GET"])
def list_voices():
    """Lista vozes disponíveis (endpoint auxiliar)."""
    voices = [{"name": v, "voice_id": v} for v in GEMINI_VOICES]
    return Response(json.dumps({"voices": voices}), mimetype="application/json")


@app.route("/health", methods=["GET"])
def health():
    return Response("ok", mimetype="text/plain")


if __name__ == "__main__":
    if not API_KEY:
        print("=" * 60)
        print("  Defina a chave da API Gemini:")
        print("  export GEMINI_API_KEY=sua_chave")
        print()
        print("  Pegue em: https://aistudio.google.com/apikey")
        print("=" * 60)
        exit(1)

    import socket
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)
    print("=" * 60)
    print(f"  Gemini TTS Proxy rodando!")
    print(f"  Modelo padrão: {DEFAULT_MODEL}")
    print()
    print(f"  Endpoint para o TTS Server:")
    print(f"  http://{local_ip}:5000/v1/audio/speech")
    print()
    print(f"  Vozes: {', '.join(GEMINI_VOICES[:6])}...")
    print("=" * 60)
    app.run(host="0.0.0.0", port=5000)
