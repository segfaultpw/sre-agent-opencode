#!/usr/bin/env bash
# Prints the environment variable that receives the provider key for a
# model given as provider/model. The names are the ones models.dev, the
# registry opencode loads providers from, lists for each provider; google
# lists three and GOOGLE_GENERATIVE_AI_API_KEY is the one its SDK documents.
# An unknown prefix exits 2 so the workflow fails before opencode starts,
# instead of running with a key nobody reads.
set -euo pipefail

model="${1:-}"
provider="${model%%/*}"
if [ -z "$provider" ] || [ "$provider" = "$model" ]; then
  echo "unknown provider prefix in model '${model}': expected provider/model" >&2
  exit 2
fi

case "$provider" in
  anthropic) echo ANTHROPIC_API_KEY ;;
  openai) echo OPENAI_API_KEY ;;
  google) echo GOOGLE_GENERATIVE_AI_API_KEY ;;
  openrouter) echo OPENROUTER_API_KEY ;;
  xai) echo XAI_API_KEY ;;
  groq) echo GROQ_API_KEY ;;
  mistral) echo MISTRAL_API_KEY ;;
  deepseek) echo DEEPSEEK_API_KEY ;;
  togetherai) echo TOGETHER_API_KEY ;;
  fireworks-ai) echo FIREWORKS_API_KEY ;;
  cerebras) echo CEREBRAS_API_KEY ;;
  moonshotai) echo MOONSHOT_API_KEY ;;
  deepinfra) echo DEEPINFRA_API_KEY ;;
  huggingface) echo HF_TOKEN ;;
  zai) echo ZHIPU_API_KEY ;;
  minimax) echo MINIMAX_API_KEY ;;
  nvidia) echo NVIDIA_API_KEY ;;
  opencode) echo OPENCODE_API_KEY ;;
  vercel) echo AI_GATEWAY_API_KEY ;;
  *)
    echo "unknown provider prefix '${provider}' in model '${model}': see scripts/provider_env.sh for the providers the workflow maps" >&2
    exit 2
    ;;
esac
