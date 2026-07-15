# Umans AI for VS Code

Use [Umans AI](https://umans.ai) models in GitHub Copilot Chat.

## Features

Registers Umans AI models as VS Code Language Model Chat Providers, making them available in the Copilot Chat model picker.

**Available models:**

| Model | Family | Context |
|-------|--------|---------|
| Umans Coder | kimi-k2.7-code | 256K |
| Umans Kimi K2.7 | kimi-k2.7 | 256K |
| Umans GLM 5.2 | glm-5.2 | 400K |
| Umans Flash | qwen3.6-35b | 256K |

All models support tool calling. Text only (no image input).

## Getting started

1. Install the extension.
2. Run **Umans: Set API Key** from the Command Palette and enter your Umans API key (starts with `sk-`).
3. Open Copilot Chat, click the model picker, and select an Umans model.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `umans.endpoint` | `https://api.code.umans.ai` | Umans API endpoint URL |

Your API key is stored securely in the OS keychain via VS Code's SecretStorage.
