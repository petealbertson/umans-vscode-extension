import * as vscode from 'vscode';

const SECRET_KEY = 'umans.apiKey';

interface UmansModelDef {
    id: string;
    name: string;
    family: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    imageInput: boolean;
}

const MODELS: UmansModelDef[] = [
    { id: 'umans-coder',     name: 'Umans Coder',    family: 'kimi-k2.7-code', maxInputTokens: 256000, maxOutputTokens: 32768, imageInput: true },
    { id: 'umans-kimi-k2.7', name: 'Umans Kimi K2.7', family: 'kimi-k2.7',     maxInputTokens: 256000, maxOutputTokens: 32768, imageInput: true },
    { id: 'umans-glm-5.2',   name: 'Umans GLM 5.2',  family: 'glm-5.2',        maxInputTokens: 400000, maxOutputTokens: 32768, imageInput: false },
    { id: 'umans-flash',     name: 'Umans Flash',     family: 'qwen3.6-35b',    maxInputTokens: 256000, maxOutputTokens: 32768, imageInput: false },
];

// --- Anthropic Messages API types ---

interface AnthropicContentBlock {
    type: 'text' | 'image' | 'tool_use' | 'tool_result';
    text?: string;
    source?: { type: 'base64'; media_type: string; data: string };
    id?: string;
    name?: string;
    input?: object;
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
    name: string;
    description: string;
    input_schema: object;
}

export class UmansProvider implements vscode.LanguageModelChatProvider {

    private static outputChannel = vscode.window.createOutputChannel('Umans');

    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    // --- credential management ---

    async getApiKey(): Promise<string | undefined> {
        return this.context.secrets.get(SECRET_KEY);
    }

    async setApiKey(): Promise<void> {
        const key = await vscode.window.showInputBox({
            prompt: 'Enter your Umans API key',
            password: true,
            placeHolder: 'sk-...',
            ignoreFocusOut: true,
        });
        if (key === undefined) { return; }
        const trimmed = key.trim();
        if (trimmed.length === 0) {
            vscode.window.showWarningMessage('Umans: No API key entered.');
            return;
        }
        if (!trimmed.startsWith('sk-')) {
            const action = await vscode.window.showWarningMessage(
                'Umans: API key does not start with "sk-". Save anyway?',
                'Save', 'Cancel'
            );
            if (action !== 'Save') { return; }
        }
        await this.context.secrets.store(SECRET_KEY, trimmed);
        this._onDidChange.fire();
        vscode.window.showInformationMessage('Umans: API key saved.');
    }

    async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_KEY);
        this._onDidChange.fire();
        vscode.window.showInformationMessage('Umans: API key cleared.');
    }

    private getEndpoint(): string {
        return vscode.workspace.getConfiguration('umans').get<string>('endpoint', 'https://api.code.umans.ai');
    }

    // --- LanguageModelChatProvider ---

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const apiKey = await this.getApiKey();
        if (!apiKey && options.silent) {
            return [];
        }
        return MODELS.map(m => ({
            id: m.id,
            name: m.name,
            family: m.family,
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            version: '1.0.0',
            capabilities: {
                toolCalling: true,
                imageInput: m.imageInput,
            },
        }));
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }
        let chars = 0;
        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                chars += part.value.length;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                chars += JSON.stringify(part.input ?? {}).length;
                chars += part.name.length;
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                for (const c of part.content) {
                    if (c instanceof vscode.LanguageModelTextPart) {
                        chars += c.value.length;
                    }
                }
            }
        }
        return Math.ceil(chars / 4);
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Umans: No API key set. Run "Umans: Set API Key" from the Command Palette.');
        }

        const endpoint = this.getEndpoint().replace(/\/+$/, '');
        if (!endpoint.startsWith('https://') && !endpoint.startsWith('http://localhost') && !endpoint.startsWith('http://127.0.0.1')) {
            throw new Error('Umans: endpoint must use HTTPS (or http://localhost for development). Check the "umans.endpoint" setting.');
        }
        const url = `${endpoint}/v1/messages`;

        const modelDef = MODELS.find(m => m.id === model.id);
        const maxTokens = modelDef?.maxOutputTokens ?? 32768;

        const body: Record<string, unknown> = {
            model: model.id,
            messages: this.convertMessages(messages),
            max_tokens: maxTokens,
            stream: true,
        };

        // tools (Anthropic format)
        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema ?? { type: 'object', properties: {} },
            }));
            if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
                body.tool_choice = { type: 'any' };
            }
        }

        // model options (temperature, etc.) — filter reserved keys
        const RESERVED_KEYS = new Set(['model', 'messages', 'max_tokens', 'stream', 'tools', 'tool_choice']);
        if (options.modelOptions) {
            for (const [k, v] of Object.entries(options.modelOptions)) {
                if (!RESERVED_KEYS.has(k)) {
                    body[k] = v;
                }
            }
        }

        const controller = new AbortController();
        const cancelSub = token.onCancellationRequested(() => controller.abort());
        const timeout = setTimeout(() => controller.abort(), 120_000);

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'Authorization': `Bearer ${apiKey}`,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timeout);
            cancelSub.dispose();
            if (controller.signal.aborted) { return; }
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Umans: request failed — ${msg}`);
        }

        if (!response.ok) {
            clearTimeout(timeout);
            cancelSub.dispose();
            let detail = '';
            try {
                const text = await response.text();
                try {
                    const parsed = JSON.parse(text);
                    detail = parsed.error?.message ?? parsed.message ?? text;
                } catch {
                    detail = text;
                }
                if (detail.length > 500) {
                    detail = detail.slice(0, 500) + '...';
                }
            } catch { /* ignore */ }

            let hint = '';
            if (response.status === 401 || response.status === 403) {
                hint = ' Check your API key (run "Umans: Set API Key").';
            } else if (response.status === 429) {
                hint = ' Rate limit exceeded. Please retry shortly.';
            } else if (response.status >= 500) {
                hint = ' Server error. Please retry.';
            }
            throw new Error(`Umans: API error ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}${hint}`);
        }

        if (!response.body) {
            clearTimeout(timeout);
            cancelSub.dispose();
            throw new Error('Umans: no response body from API.');
        }

        try {
            await this.parseSSE(response.body, progress, token);
        } finally {
            clearTimeout(timeout);
            cancelSub.dispose();
        }
    }

    // --- message conversion (VS Code → Anthropic) ---

    private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): AnthropicMessage[] {
        const out: AnthropicMessage[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
            const textParts: string[] = [];
            const imageBlocks: AnthropicContentBlock[] = [];
            const toolUseBlocks: AnthropicContentBlock[] = [];
            const toolResultBlocks: AnthropicContentBlock[] = [];

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelDataPart) {
                    // Convert image data to Anthropic image block format
                    if (part.mimeType.startsWith('image/')) {
                        const base64 = UmansProvider.uint8ToBase64(part.data);
                        imageBlocks.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: part.mimeType,
                                data: base64,
                            },
                        });
                    }
                    // Non-image data parts are skipped
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolUseBlocks.push({
                        type: 'tool_use',
                        id: part.callId,
                        name: part.name,
                        input: part.input ?? {},
                    });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    const resultText = part.content
                        .map(c => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
                        .join('\n');
                    toolResultBlocks.push({
                        type: 'tool_result',
                        tool_use_id: part.callId,
                        content: resultText,
                    });
                }
            }

            // Tool results must be in a user-role message
            if (toolResultBlocks.length > 0) {
                out.push({
                    role: 'user',
                    content: toolResultBlocks,
                });
            }

            // Build the message content
            const contentBlocks: AnthropicContentBlock[] = [];

            // Text
            const textContent = textParts.join('');
            if (textContent.length > 0) {
                contentBlocks.push({ type: 'text', text: textContent });
            }

            // Images (user messages only, per Anthropic spec)
            if (imageBlocks.length > 0 && role === 'user') {
                contentBlocks.push(...imageBlocks);
            }

            // Tool use (assistant messages)
            if (toolUseBlocks.length > 0) {
                contentBlocks.push(...toolUseBlocks);
            }

            // Only push if we have content blocks
            if (contentBlocks.length > 0) {
                out.push({ role, content: contentBlocks });
            }
        }
        return out;
    }

    private static uint8ToBase64(data: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
        }
        return btoa(binary);
    }

    // --- SSE parsing (Anthropic event format) ---

    private async parseSSE(
        body: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Track tool calls by index (Anthropic streams tool_use blocks with an index)
        const toolCallBuffers: Map<number, { id: string; name: string; partialJson: string }> = new Map();

        // SSE state: Anthropic uses named events (event: type\ndata: json\n\n)
        let currentEvent = '';
        let currentData = '';

        try {
            while (true) {
                if (token.isCancellationRequested) { break; }
                const { done, value } = await reader.read();
                if (done) { break; }
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const rawLine of lines) {
                    const line = rawLine.replace(/\r$/, '');

                    // Empty line = event boundary — process the accumulated event
                    if (line === '') {
                        if (currentData) {
                            this.handleSSEEvent(currentEvent, currentData, progress, toolCallBuffers);
                        }
                        currentEvent = '';
                        currentData = '';
                        continue;
                    }

                    // Comment line
                    if (line.startsWith(':')) { continue; }

                    // Event type
                    if (line.startsWith('event:')) {
                        currentEvent = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        const data = line.slice(5).trim();
                        if (currentData) {
                            currentData += '\n' + data;
                        } else {
                            currentData = data;
                        }
                    }
                }
            }
            // Process any remaining buffered event
            if (currentData) {
                this.handleSSEEvent(currentEvent, currentData, progress, toolCallBuffers);
            }
            // Flush any remaining tool calls
            this.flushToolCalls(toolCallBuffers, progress);
        } finally {
            reader.releaseLock();
        }
    }

    private handleSSEEvent(
        event: string,
        data: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        toolCallBuffers: Map<number, { id: string; name: string; partialJson: string }>
    ): void {
        let json: any;
        try {
            json = JSON.parse(data);
        } catch {
            return; // skip unparseable
        }

        switch (json.type) {
            case 'content_block_start': {
                const block = json.content_block;
                const index = json.index;
                if (block?.type === 'tool_use') {
                    toolCallBuffers.set(index, {
                        id: block.id ?? `call_${index}`,
                        name: block.name ?? '',
                        partialJson: '',
                    });
                }
                break;
            }
            case 'content_block_delta': {
                const delta = json.delta;
                const index = json.index;
                if (!delta) { break; }

                if (delta.type === 'text_delta') {
                    if (typeof delta.text === 'string' && delta.text.length > 0) {
                        progress.report(new vscode.LanguageModelTextPart(delta.text));
                    }
                } else if (delta.type === 'input_json_delta') {
                    // Accumulate tool call JSON fragments
                    const existing = toolCallBuffers.get(index);
                    if (existing) {
                        const fragment = typeof delta.partial_json === 'string' ? delta.partial_json : '';
                        existing.partialJson += fragment;
                    }
                }
                break;
            }
            case 'content_block_stop': {
                // Tool call is complete — flush it
                const index = json.index;
                if (toolCallBuffers.has(index)) {
                    this.flushToolCall(index, toolCallBuffers, progress);
                }
                break;
            }
            case 'message_delta': {
                // Check stop reason
                if (json.delta?.stop_reason === 'tool_use') {
                    this.flushToolCalls(toolCallBuffers, progress);
                }
                break;
            }
            case 'message_stop':
                this.flushToolCalls(toolCallBuffers, progress);
                break;
            case 'error':
                UmansProvider.outputChannel.appendLine(`Umans API error: ${JSON.stringify(json.error ?? json)}`);
                break;
        }
    }

    private flushToolCall(
        index: number,
        buffers: Map<number, { id: string; name: string; partialJson: string }>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): void {
        const tc = buffers.get(index);
        if (!tc) { return; }
        let input: object = {};
        if (tc.partialJson.length > 0) {
            try {
                input = JSON.parse(tc.partialJson);
            } catch {
                UmansProvider.outputChannel.appendLine(`Warning: could not parse tool call arguments for "${tc.name}": ${tc.partialJson.slice(0, 200)}`);
            }
        }
        progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input));
        buffers.delete(index);
    }

    private flushToolCalls(
        buffers: Map<number, { id: string; name: string; partialJson: string }>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): void {
        for (const index of [...buffers.keys()].sort((a, b) => a - b)) {
            this.flushToolCall(index, buffers, progress);
        }
    }
}
