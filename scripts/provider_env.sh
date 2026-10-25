#!/usr/bin/env bash
# Prints the environment variable that receives the provider key for a
# model given as provider/model. The names are the ones models.dev, the
# registry opencode loads providers from, lists for each provider; google
# lists three and GOOGLE_GENERATIVE_AI_API_KEY is the one its SDK documents.
# An unknown prefix exits 2 so the workflow fails before opencode starts,
# instead of running with a key nobody reads.
#
# `provider_env.sh --all` prints every variable in the table, one per line: the
# self-hosted runner trims exactly these where it reads its environment
# (runner/runner.js), and tests/provider_env_test.sh holds the two lists equal.
set -euo pipefail

# provider prefix, then the variable that receives its key.
table='anthropic ANTHROPIC_API_KEY
openai OPENAI_API_KEY
google GOOGLE_GENERATIVE_AI_API_KEY
openrouter OPENROUTER_API_KEY
xai XAI_API_KEY
groq GROQ_API_KEY
mistral MISTRAL_API_KEY
deepseek DEEPSEEK_API_KEY
togetherai TOGETHER_API_KEY
fireworks-ai FIREWORKS_API_KEY
cerebras CEREBRAS_API_KEY
moonshotai MOONSHOT_API_KEY
deepinfra DEEPINFRA_API_KEY
huggingface HF_TOKEN
zai ZHIPU_API_KEY
minimax MINIMAX_API_KEY
nvidia NVIDIA_API_KEY
opencode OPENCODE_API_KEY
vercel AI_GATEWAY_API_KEY'

if [ "${1:-}" = "--all" ]; then
  while read -r _ variable; do echo "$variable"; done <<<"$table"
  exit 0
fi

model="${1:-}"
provider="${model%%/*}"
if [ -z "$provider" ] || [ "$provider" = "$model" ]; then
  echo "unknown provider prefix in model '${model}': expected provider/model" >&2
  exit 2
fi

while read -r prefix variable; do
  if [ "$prefix" = "$provider" ]; then
    echo "$variable"
    exit 0
  fi
done <<<"$table"

echo "unknown provider prefix '${provider}' in model '${model}': see scripts/provider_env.sh for the providers the workflow maps" >&2
exit 2
