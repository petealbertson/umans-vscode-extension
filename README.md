# Umans AI for VS Code

Use [Umans AI](https://umans.ai) models in GitHub Copilot Chat.

This extension registers Umans AI models as VS Code Language Model Chat Providers, making them available in the Copilot Chat model picker alongside GitHub's built-in models.

## Available models

| Model | Family | Context window |
|-------|--------|----------------|
| Umans Coder | kimi-k2.7-code | 256K |
| Umans Kimi K2.7 | kimi-k2.7 | 256K |
| Umans GLM 5.2 | glm-5.2 | 400K |
| Umans Flash | qwen3.6-35b | 256K |

All models support tool calling. Umans Coder and Umans Kimi K2.7 also support image input (vision); GLM 5.2 and Flash are text-only.

## Installation

### Option A: Install from VSIX (recommended for now)

1. Download the latest `umans-vscode-extension-0.1.0.vsix` from the [releases page](https://github.com/petealbertson/umans-vscode-extension/releases), or build it yourself (see [Development](#development) below).

2. In VS Code, open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux) and run:
   ```
   Extensions: Install from VSIX...
   ```
3. Select the downloaded `.vsix` file.
4. Reload VS Code when prompted.

### Option B: Build from source

```bash
git clone https://github.com/petealbertson/umans-vscode-extension.git
cd umans-vscode-extension
npm install
npm run compile
npx @vscode/vsce package
```
This produces `umans-vscode-extension-0.1.0.vsix` — install it as described in Option A.

### Using with Remote-SSH

If you're connected to a remote host via Remote-SSH, install the VSIX **after connecting** — run "Extensions: Install from VSIX..." from the Command Palette while in the remote session. VS Code will install it on the remote server side. You'll need to set your API key separately on the remote (see below).

## Setup

1. **Set your API key.** Open the Command Palette and run:
   ```
   Umans: Set API Key
   ```
   Enter your Umans API key (starts with `sk-`). It's stored securely in your OS keychain via VS Code's SecretStorage.

2. **Enable BYOK utility model.** Since Umans is a bring-your-own-key (BYOK) provider, you need to tell Copilot to use your selected model for background utility tasks (titles, summaries). In Settings (`Cmd+,`), search for:
   ```
   chat.byokUtilityModelDefault
   ```
   Set it to **Main Agent Model**. (Without this, you'll get "No utility model is configured for 'copilot-utility-small'" when sending a message.)

3. **Use a model.** Open Copilot Chat, click the model picker (dropdown showing the current model name), and select an Umans model.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `umans.endpoint` | `https://api.code.umans.ai` | Umans API endpoint URL |

Your API key is stored securely in the OS keychain via VS Code's SecretStorage — it never leaves your machine in plaintext and is not included in any telemetry.

## Commands

| Command | Description |
|---------|-------------|
| `Umans: Set API Key` | Store your Umans API key securely |
| `Umans: Clear API Key` | Remove the stored API key |

## Development

```bash
git clone https://github.com/petealbertson/umans-vscode-extension.git
cd umans-vscode-extension
npm install
```

Open the folder in VS Code and press `F5` (or `Fn+F5` on macOS) to launch an Extension Development Host for testing. A `.vscode/launch.json` is included.

To compile without launching:
```bash
npm run compile      # one-time build
npm run watch        # watch mode
```

To package a VSIX for distribution:
```bash
npx @vscode/vsce package
```

## Requirements

- VS Code 1.104 or newer
- An Umans AI API key (get one at [umans.ai](https://umans.ai))
- GitHub Copilot subscription (for Copilot Chat access)

## License

[MIT](LICENSE)
