#!/usr/bin/env bash
# Each provider prefix is pinned to the variable its SDK reads, as models.dev
# (the registry opencode loads providers from) names it. A wrong name here
# hands the customer's key to nobody and the run fails at the first request.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/provider_env.sh"
fail=0

expect() {
  local model="$1" want="$2" got rc=0
  got="$(bash "$script" "$model" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then echo "ok   $model -> $want"; else echo "FAIL $model: expected $want, got '$got' (exit $rc)"; fail=1; fi
}

refuse() {
  local model="$1" got rc=0
  got="$(bash "$script" "$model" 2>&1)" || rc=$?
  if [ "$rc" -eq 2 ] && [[ "$got" == *"unknown provider prefix"* ]]; then echo "ok   refuses '$model'"; else echo "FAIL '$model': expected exit 2 with 'unknown provider prefix', got exit $rc: $got"; fail=1; fi
}

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

expect anthropic/claude-sonnet-4-5 ANTHROPIC_API_KEY
expect openai/gpt-5 OPENAI_API_KEY
expect google/gemini-2.5-pro GOOGLE_GENERATIVE_AI_API_KEY
expect openrouter/anthropic/claude-sonnet-4-5 OPENROUTER_API_KEY
expect openrouter/deepseek/deepseek-v4-pro OPENROUTER_API_KEY
expect xai/grok-4 XAI_API_KEY
expect groq/llama-3.3-70b-versatile GROQ_API_KEY
expect mistral/devstral-medium MISTRAL_API_KEY
expect deepseek/deepseek-chat DEEPSEEK_API_KEY
expect togetherai/moonshotai/Kimi-K2-Instruct TOGETHER_API_KEY
expect fireworks-ai/accounts/fireworks/models/kimi-k2-instruct FIREWORKS_API_KEY
expect cerebras/qwen-3-coder-480b CEREBRAS_API_KEY
expect moonshotai/kimi-k2 MOONSHOT_API_KEY
expect deepinfra/deepseek-ai/DeepSeek-V3 DEEPINFRA_API_KEY
expect huggingface/moonshotai/Kimi-K2-Instruct HF_TOKEN
expect zai/glm-4.5 ZHIPU_API_KEY
expect minimax/MiniMax-M1 MINIMAX_API_KEY
expect nvidia/moonshotai/kimi-k2-instruct NVIDIA_API_KEY
expect opencode/kimi-k2 OPENCODE_API_KEY
expect vercel/anthropic/claude-sonnet-4-5 AI_GATEWAY_API_KEY

refuse amazon-bedrock/anthropic.claude-sonnet-4-5
refuse azure/gpt-5
refuse ollama/llama3
refuse claude-sonnet-4-5
refuse ""
refuse /gpt-5

exit $fail
