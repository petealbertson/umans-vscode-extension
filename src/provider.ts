import * as vscode from 'vscode';

const SECRET_KEY = 'umans.apiKey';

interface UmansModelDef {
    id: string;
    name: string;
    family: string;
    maxInputTokens: number;
    maxOutputTokens: number;
}

const MODELS: UmansModelDef[] = [
    { id: 'umans-coder',     name: 'Umans Coder',    family: 'kimi-k2.7-code', maxInputTokens: 256000, maxOutputTokens: 8192 },
    { id: 'umans-kimi-k2.7', name: 'Umans Kimi K2.7', family: 'kimi-k2.7',     maxInputTokens: 256000, maxOutputTokens: 8192 },
    { id: 'umans-glm-5.2',   name: 'Umans GLM 5.2',  family: 'glm-5.2',        maxInputTokens: 400000, maxOutputTokens: 8192 },
    { id: 'umans-flash',     name: 'Umans Flash',     family: 'qwen3.6-35b',    maxInputTokens: 256000, maxOutputTokens: 8192 },
];

// OpenAI message types
interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}
interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    name?: string;
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
                imageInput: false,
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
        const url = `${endpoint}/v1/chat/completions`;

        const body: Record<string, unknown> = {
            model: model.id,
            messages: this.convertMessages(messages),
            stream: true,
        };

        // tools
        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema ?? {},
                },
            }));
            if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
                body.tool_choice = 'required';
            }
        }

        // model options (temperature, etc.)
        const RESERVED_KEYS = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice']);
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
                    'Authorization': `Bearer ${apiKey}`,
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

    // --- message conversion ---

    private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
        const out: OpenAIMessage[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
            let textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            const toolResults: { id: string; content: string }[] = [];

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push({
                        id: part.callId,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: JSON.stringify(part.input ?? {}),
                        },
                    });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    const resultText = part.content
                        .map(c => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
                        .join('\n');
                    toolResults.push({ id: part.callId, content: resultText });
                }
            }

            // Tool results go as separate 'tool' role messages
            for (const tr of toolResults) {
                out.push({ role: 'tool', content: tr.content, tool_call_id: tr.id });
            }

            // If the message had only tool results, they're already pushed as 'tool' messages — skip the empty wrapper
            if (textParts.length === 0 && toolCalls.length === 0 && toolResults.length > 0) {
                continue;
            }

            const message: OpenAIMessage = { role, content: textParts.join('') || null };
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
                // assistant messages with tool calls can have null content
            }
            if (msg.name) {
                message.name = msg.name;
            }
            out.push(message);
        }
        return out;
    }

    // --- SSE parsing ---

    private async parseSSE(
        body: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // accumulate tool call arguments by index
        const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();

        try {
            while (true) {
                if (token.isCancellationRequested) { break; }
                const { done, value } = await reader.read();
                if (done) { break; }
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (line === '' || line.startsWith(':')) { continue; }
                    if (!line.startsWith('data:')) { continue; }
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') {
                        this.flushToolCalls(toolCallBuffers, progress);
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const choice = json.choices?.[0];
                        if (!choice) { continue; }
                        const delta = choice.delta;
                        if (!delta) { continue; }

                        // text content
                        if (typeof delta.content === 'string' && delta.content.length > 0) {
                            progress.report(new vscode.LanguageModelTextPart(delta.content));
                        }

                        // tool calls — accumulate
                        if (Array.isArray(delta.tool_calls)) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                const existing = toolCallBuffers.get(idx);
                                const id = tc.id ?? existing?.id ?? `call_${idx}`;
                                const name = tc.function?.name ?? existing?.name ?? '';
                                const argsFragment = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
                                if (existing) {
                                    existing.args += argsFragment;
                                } else {
                                    toolCallBuffers.set(idx, { id, name, args: argsFragment });
                                }
                            }
                        }

                        // if finish_reason indicates tool calls, flush
                        if (choice.finish_reason === 'tool_calls') {
                            this.flushToolCalls(toolCallBuffers, progress);
                        }
                    } catch {
                        // skip unparseable lines
                    }
                }
            }
            // stream ended — flush any remaining tool calls
            this.flushToolCalls(toolCallBuffers, progress);
        } finally {
            reader.releaseLock();
        }
    }

    private flushToolCalls(
        buffers: Map<number, { id: string; name: string; args: string }>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): void {
        if (buffers.size === 0) { return; }
        const sorted = [...buffers.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, tc] of sorted) {
            let input: object = {};
            if (tc.args.length > 0) {
                try {
                    input = JSON.parse(tc.args);
                } catch {
                    UmansProvider.outputChannel.appendLine(`Warning: could not parse tool call arguments for "${tc.name}": ${tc.args.slice(0, 200)}`);
                }
            }
            progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input));
        }
        buffers.clear();
    }
}
