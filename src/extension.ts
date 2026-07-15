import * as vscode from 'vscode';
import { UmansProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new UmansProvider(context);

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('umans', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('umans.setApiKey', () => provider.setApiKey()),
        vscode.commands.registerCommand('umans.clearApiKey', () => provider.clearApiKey())
    );
}

export function deactivate() { }
