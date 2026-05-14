# Guia: Vozes pt-BR de Alta Qualidade para Leitura de PDFs no Android

## Situação Atual

Você está usando **Piper dii-high** no Sherpa TTS, que é a melhor voz Piper
disponível para pt-BR. Mas ainda é limitada: o Piper usa modelos VITS pequenos
(~64 MB) que não conseguem produzir entonação tão natural para textos longos.

As vozes Piper pt-BR disponíveis:

| Voz | Qualidade | Observação |
|-----|-----------|------------|
| `pt_BR-dii-high` | **Alta (Piper)** | ← **Você está aqui** |
| `pt_BR-miro-high` | Alta (Piper) | Similar ao dii |
| `pt_BR-cadu-medium` | Média | |
| `pt_BR-faber-medium` | Média | |
| `pt_BR-jeff-medium` | Média | |
| `pt_BR-edresson-low` | Baixa | |

Para ir **além do Piper**, a única opção offline de alta qualidade real é
o **Google TTS**. Modelos open-source (Kokoro, Coqui, MeloTTS) ainda não
têm qualidade boa para português brasileiro.

---

## ★ Opção 1: Google TTS Offline (RECOMENDADO)

O **Google TTS** ("Fala do Google") é a única opção offline para Android que
produz voz pt-BR de alta qualidade com entonação natural para leitura de livros.

### Passos:

1. **Instale/atualize** "Fala do Google" (Google Text-to-Speech) da Play Store
2. **Configurações** → Sistema → Idioma e Entrada → Saída de texto
3. Selecione **Google** → toque na ⚙️ engrenagem
4. **Instalar dados de voz** → Português (Brasil) → **voz de alta qualidade**
5. No **Readera**: Configurações → TTS → Selecione "Fala do Google"

### Vantagens:
- **Qualidade neural premium** — entonação natural, prosódia realista
- **Muito rápido** (síntese quase instantânea)
- 100% offline após baixar dados de voz (~200 MB)
- Gratuito

### Desvantagens:
- App proprietário do Google (privacidade — texto não é enviado, mas o app é closed-source)
- Menos controle sobre timbre/personalidade da voz

---

## Opção 2: VoxSherpa TTS + Kokoro-82M (Open-source, mas pt-BR fraco)

O **Kokoro-82M** é um modelo neural de 82M parâmetros. É excelente em **inglês e
chinês**, mas o suporte pt-BR é experimental e a qualidade é **ruim** — entonação
estranha e pronúncia inconsistente.

> **Testado e reprovado para pt-BR.** Só vale se você ler em inglês.

- App: [VoxSherpa TTS](https://play.google.com/store/apps/details?id=com.CodeBySonu.VoxSherpa) (Play Store) ou [GitHub](https://github.com/CodeBySonu95/VoxSherpa-TTS/releases)
- Modelo: baixe dentro do app (aba Models → Kokoro multi-lang)
- Funciona como engine TTS do sistema (compatível com Readera)

---

## Opção 3: Piper miro-high (alternativa ao dii)

Se quiser ficar no Piper, experimente trocar para **miro-high** — é outro
modelo high quality com timbre diferente. Pode soar melhor para certos tipos
de texto.

```bash
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-pt_BR-miro-high.tar.bz2
```

---

## Ranking de Qualidade para Leitura de Livros pt-BR

1. 🥇 **Google TTS pt-BR** — Melhor qualidade + velocidade (proprietário)
2. 🥈 **Piper dii-high / miro-high** — Melhor open-source, mas limitado
3. 🥉 **Piper cadu/faber/jeff-medium** — Aceitável
4. **Kokoro-82M pt-BR** — Modelo grande, mas pt-BR é ruim
5. **Piper edresson-low** — Ruim para livros

> **Nota:** Para leitura em **inglês**, Kokoro-82M é excelente (melhor que Piper).
> O problema é especificamente com português brasileiro.

---

## Dica Extra

No Readera, ajustar a **velocidade para ~0.85-0.95x** melhora a naturalidade
de qualquer voz, pois dá mais tempo para as pausas entre frases.
