const vscode = require('vscode');

const COMPILE_COMMAND_ID = 'amxxPawnAllIn.compileCurrentFile';

function registerLazyCompilerIntegration(context, options = {}) {
    let proxyCommand = null;
    let fullIntegration = null;
    let pendingIntegration = null;
    const integrationOptions = options;

    const ensureCompilerIntegration = async () => {
        if (fullIntegration) return fullIntegration;
        if (pendingIntegration) return pendingIntegration;

        pendingIntegration = Promise.resolve().then(() => {
            const { registerCompilerIntegration } = require('./compiler');
            if (proxyCommand) {
                proxyCommand.dispose();
                proxyCommand = null;
            }
            fullIntegration = registerCompilerIntegration(context, integrationOptions);
            return fullIntegration;
        }).finally(() => {
            pendingIntegration = null;
        });

        return pendingIntegration;
    };

    proxyCommand = vscode.commands.registerCommand(COMPILE_COMMAND_ID, async () => {
        const integration = await ensureCompilerIntegration();
        return integration.compileCurrentFile();
    });
    context.subscriptions.push(proxyCommand);

    return {
        ensureCompilerIntegration
    };
}

module.exports = {
    registerLazyCompilerIntegration
};
