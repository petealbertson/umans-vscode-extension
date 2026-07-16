# Changelog

## 0.2.0

- Fix: vision/image support for umans-coder and umans-kimi-k2.7 (declared `imageInput: true`)
- Fix: convert `LanguageModelDataPart` images to OpenAI `image_url` format instead of silently dropping them
- Prevents 400 errors when images are present in chat history

## 0.1.0

- Initial release
- Registers 4 Umans AI models as VS Code Language Model Chat Providers
- Models: Umans Coder, Umans Kimi K2.7, Umans GLM 5.2, Umans Flash
- Secure API key storage via VS Code SecretStorage
- Streaming responses via SSE
- Full tool calling support
- Configurable endpoint
