const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCompilerDiagnosticService } = require('./compiler-diagnostics');
const { createRuntimeLocalization } = require('./localization');
const { createUtilityCore } = require('../core/utils/runtime');
const {
    collectCompilerIncludeDirectories,
    defaultNormalizeFsPath
} = require('../core/include-search-paths');
const {
    showTimedErrorMessage,
    showTimedInformationMessage,
    showTimedWarningMessage
} = require('./notifications');

const EXTENSION_CONFIG_NS = 'amxxPawnAllIn';
const COMPILE_COMMAND_ID = 'amxxPawnAllIn.compileCurrentFile';
const COMPILER_DIAGNOSTIC_COLLECTION_ID = 'amxxPawnAllInCompiler';
const LIVE_VALIDATION_DIAGNOSTIC_SOURCE = 'AMXX Pawn All-In';
const AMXX_PAWN_LANGUAGE_ID = 'amxxpawn';
const DEFAULT_PAWN_SOURCE_EXTENSIONS = ['.sma'];
const COMPILER_OUTPUT_ENCODINGS = ['ibm866', 'windows-1251', 'utf-8'];
const COMPILER_EXECUTABLE_NAMES = ['amxxpc.exe', 'amxxpc'];
const COMPILER_CLOSE_FALLBACK_MS = 1500;
const COMMON_PROJECT_COMPILER_PATHS = [
    'amxxpc.exe',
    path.join('compiler', 'amxxpc.exe'),
    path.join('scripting', 'amxxpc.exe'),
    path.join('addons', 'amxmodx', 'scripting', 'amxxpc.exe'),
    path.join('pawncc', 'amxxpc.exe')
];
const IGNORED_COMPILER_SEARCH_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    '.vscode',
    'node_modules'
]);
const MAX_PROJECT_COMPILER_SEARCH_DEPTH = 4;
const activeCompileJobs = new Map();
let programmaticIncludePathsGetter = null;
const { t } = createRuntimeLocalization(vscode);
const {
    normalizeExtensionList,
    isPawnIdentifierBoundaryChar: isIdentifierBoundaryChar
} = createUtilityCore();
const COMPILER_OUTPUT_CHANNEL_NAME = t('compiler.outputChannelName');
const compilerSettings = {
    pawnFileExtensions: DEFAULT_PAWN_SOURCE_EXTENSIONS,
    globalCompilerPath: '',
    compilerOutputDirectory: 'compiled',
    compilerOutputDirectoryBase: 'project-root-if-available',
    compilerOptions: [],
    globalIncludePaths: [],
    projectLocalIncludePaths: ['include'],
    compileRevealTarget: 'all-issues-priority',
    compileStartToastMode: 'never',
    compileResultToastMode: 'issues',
    compilerOutputRevealMode: 'issues',
    liveValidationMode: 'edited'
};

function normalizeCompilerFsPath(filePath) {
    return defaultNormalizeFsPath(path, filePath);
}

function hasConfiguredPawnSourceExtension(filePath, extensions = compilerSettings.pawnFileExtensions) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return !!ext && normalizeExtensionList(extensions).includes(ext);
}

function isCompilablePawnDocument(document) {
    if (!document) return false;
    return document.languageId === AMXX_PAWN_LANGUAGE_ID &&
        hasConfiguredPawnSourceExtension(document.fileName);
}

function isPawnDocumentForCompilerDiagnosticInvalidation(document) {
    return !!document?.fileName && document.languageId === AMXX_PAWN_LANGUAGE_ID;
}

function getExtensionConfig() {
    return vscode.workspace.getConfiguration(EXTENSION_CONFIG_NS);
}

function refreshCompilerSettings() {
    const config = getExtensionConfig();
    compilerSettings.pawnFileExtensions = normalizeExtensionList(
        config.get('fileExtensions', DEFAULT_PAWN_SOURCE_EXTENSIONS),
        DEFAULT_PAWN_SOURCE_EXTENSIONS
    );
    compilerSettings.globalCompilerPath = String(config.get('globalCompilerPath', '') || '');
    compilerSettings.compilerOutputDirectory = String(config.get('compilerOutputDirectory', 'compiled') || 'compiled');
    compilerSettings.compilerOutputDirectoryBase = resolveCompilerOutputDirectoryBase(config);
    compilerSettings.compilerOptions = Array.isArray(config.get('compilerOptions', []))
        ? config.get('compilerOptions', [])
        : [];
    const rawGlobalIncludePaths = config.get('globalIncludePaths', []);
    compilerSettings.globalIncludePaths = Array.isArray(rawGlobalIncludePaths)
        ? rawGlobalIncludePaths
        : [];
    const rawProjectLocalIncludePaths = config.get('projectLocalIncludePaths', ['include']);
    compilerSettings.projectLocalIncludePaths =
        Array.isArray(rawProjectLocalIncludePaths)
            ? rawProjectLocalIncludePaths
            : ['include'];
    compilerSettings.compileRevealTarget = resolveCompileRevealTarget(config);
    compilerSettings.compileStartToastMode = resolveCompileStartToastMode(config);
    compilerSettings.compileResultToastMode = resolveCompileResultToastMode(config);
    compilerSettings.compilerOutputRevealMode = resolveCompilerOutputRevealMode(config);
    const rawLiveValidationMode = String(config.get('liveValidationMode', 'edited') || 'edited').trim().toLowerCase();
    compilerSettings.liveValidationMode =
        rawLiveValidationMode === 'edited' || rawLiveValidationMode === 'full'
            ? rawLiveValidationMode
            : 'edited';
}

function resolveCompilerOutputDirectoryBase(config) {
    const validModes = new Set(['project-root-if-available', 'source-file', 'compiler-root-if-available']);
    const rawMode = String(config.get('compilerOutputDirectoryBase', '') || '').trim().toLowerCase();
    if (validModes.has(rawMode)) {
        return rawMode;
    }
    return 'project-root-if-available';
}

function resolveCompilerOutputRevealMode(config) {
    const validModes = new Set(['never', 'warnings', 'errors', 'issues', 'always']);
    const rawMode = String(config.get('compilerOutputRevealMode', '') || '').trim().toLowerCase();
    if (validModes.has(rawMode)) {
        return rawMode;
    }
    return 'issues';
}

function getCompilerOutputRevealMode() {
    return compilerSettings.compilerOutputRevealMode;
}

function resolveCompileRevealTarget(config) {
    const validTargets = new Set([
        'never',
        'live-errors',
        'compiler-errors',
        'compiler-warnings',
        'live-then-compiler',
        'all-issues-priority'
    ]);
    const rawTarget = String(config.get('compileRevealTarget', '') || '').trim().toLowerCase();
    if (validTargets.has(rawTarget)) {
        return rawTarget;
    }
    return 'all-issues-priority';
}

function getCompileRevealTarget() {
    return compilerSettings.compileRevealTarget;
}

function resolveCompileStartToastMode(config) {
    const validModes = new Set(['never', 'always']);
    const rawMode = String(config.get('compileStartToastMode', '') || '').trim().toLowerCase();
    if (validModes.has(rawMode)) {
        return rawMode;
    }
    return 'never';
}

function getCompileStartToastMode() {
    return compilerSettings.compileStartToastMode;
}

function resolveCompileResultToastMode(config) {
    const validModes = new Set(['never', 'success', 'warnings', 'errors', 'issues', 'success-or-issues']);
    const rawMode = String(config.get('compileResultToastMode', '') || '').trim().toLowerCase();
    if (validModes.has(rawMode)) {
        return rawMode;
    }
    return 'issues';
}

function getCompileResultToastMode() {
    return compilerSettings.compileResultToastMode;
}

function shouldShowCompileStartToast() {
    return getCompileStartToastMode() === 'always';
}

function shouldPublishCompilerErrorDiagnostics() {
    return compilerSettings.liveValidationMode === 'off';
}

function shouldRevealCompilerOutputForResult({ hasErrors = false, hasWarnings = false } = {}) {
    switch (getCompilerOutputRevealMode()) {
    case 'never':
        return false;
    case 'warnings':
        return hasWarnings;
    case 'errors':
        return hasErrors;
    case 'always':
        return true;
    case 'issues':
    default:
        return hasErrors || hasWarnings;
    }
}

function asCompilerExecutablePath(candidatePath) {
    if (!candidatePath) return '';

    try {
        const stat = fs.statSync(candidatePath);
        if (stat.isDirectory()) {
            for (const executableName of COMPILER_EXECUTABLE_NAMES) {
                const full = path.join(candidatePath, executableName);
                if (fs.existsSync(full)) return path.resolve(full);
            }
            return '';
        }
        return path.resolve(candidatePath);
    } catch {
        return '';
    }
}

function resolveConfiguredCompilerPath(rawPath, documentFilePath) {
    const value = String(rawPath || '').trim();
    if (!value) return '';

    const candidates = [];
    if (path.isAbsolute(value)) {
        candidates.push(value);
    } else {
        const owningWorkspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(documentFilePath));
        if (owningWorkspaceFolder) {
            candidates.push(path.join(owningWorkspaceFolder.uri.fsPath, value));
        }
        for (const folder of vscode.workspace.workspaceFolders || []) {
            if (owningWorkspaceFolder && folder.uri.fsPath === owningWorkspaceFolder.uri.fsPath) continue;
            candidates.push(path.join(folder.uri.fsPath, value));
        }
        candidates.push(path.join(path.dirname(documentFilePath), value));
    }

    for (const candidate of candidates) {
        const compilerPath = asCompilerExecutablePath(candidate);
        if (compilerPath && fs.existsSync(compilerPath)) return compilerPath;
    }

    return '';
}

function findCompilerInDirectory(baseDir, relativeCandidates = COMMON_PROJECT_COMPILER_PATHS) {
    if (!baseDir || !fs.existsSync(baseDir)) return '';
    for (const relativeCandidate of relativeCandidates) {
        const compilerPath = asCompilerExecutablePath(path.join(baseDir, relativeCandidate));
        if (compilerPath && fs.existsSync(compilerPath)) return compilerPath;
    }
    return '';
}

function findCompilerRecursively(baseDir, maxDepth = MAX_PROJECT_COMPILER_SEARCH_DEPTH) {
    if (!baseDir || !fs.existsSync(baseDir)) return '';

    const visited = new Set();
    const queue = [{ dir: path.resolve(baseDir), depth: 0 }];

    while (queue.length) {
        const current = queue.shift();
        const normalizedDir = normalizeCompilerFsPath(current.dir);
        if (!normalizedDir || visited.has(normalizedDir)) continue;
        visited.add(normalizedDir);

        const directMatch = findCompilerInDirectory(current.dir, COMPILER_EXECUTABLE_NAMES);
        if (directMatch) return directMatch;
        if (current.depth >= maxDepth) continue;

        let entries = [];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }

        const subdirs = entries
            .filter(entry => entry.isDirectory() && !IGNORED_COMPILER_SEARCH_DIRS.has(entry.name.toLowerCase()))
            .map(entry => path.join(current.dir, entry.name))
            .sort((left, right) => {
                const leftName = path.basename(left).toLowerCase();
                const rightName = path.basename(right).toLowerCase();
                const leftScore = /(compiler|amxx|amxmodx|scripting|pawn)/.test(leftName) ? 0 : 1;
                const rightScore = /(compiler|amxx|amxmodx|scripting|pawn)/.test(rightName) ? 0 : 1;
                return leftScore - rightScore || leftName.localeCompare(rightName);
            });

        for (const subdir of subdirs) {
            queue.push({ dir: subdir, depth: current.depth + 1 });
        }
    }

    return '';
}

function findProjectCompiler(documentFilePath) {
    const documentUri = vscode.Uri.file(documentFilePath);
    const owningWorkspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    const workspaceFolders = owningWorkspaceFolder
        ? [owningWorkspaceFolder, ...(vscode.workspace.workspaceFolders || []).filter(folder =>
            folder.uri.fsPath !== owningWorkspaceFolder.uri.fsPath
        )]
        : (vscode.workspace.workspaceFolders || []);

    for (const folder of workspaceFolders) {
        const workspaceRoot = folder.uri.fsPath;
        const commonMatch = findCompilerInDirectory(workspaceRoot);
        if (commonMatch) return commonMatch;
        const recursiveMatch = findCompilerRecursively(workspaceRoot);
        if (recursiveMatch) return recursiveMatch;
    }

    return '';
}

function getFileFolderCompilerCandidates() {
    return [
        'amxxpc.exe',
        path.join('compiler', 'amxxpc.exe')
    ];
}

function findNearbyFileCompiler(documentFilePath) {
    const fileDir = path.dirname(documentFilePath);
    if (!fileDir || !fs.existsSync(fileDir)) return '';

    const directMatch = findCompilerInDirectory(fileDir, getFileFolderCompilerCandidates());
    if (directMatch) return directMatch;

    return findCompilerRecursively(fileDir, 2);
}

function resolveCompilerPath(documentFilePath) {
    const projectCompiler = findProjectCompiler(documentFilePath);
    if (projectCompiler) {
        return { compilerPath: projectCompiler, source: 'project' };
    }

    const nearbyCompiler = findNearbyFileCompiler(documentFilePath);
    if (nearbyCompiler) {
        return { compilerPath: nearbyCompiler, source: 'file' };
    }

    const configuredCompiler = resolveConfiguredCompilerPath(
        compilerSettings.globalCompilerPath,
        documentFilePath
    );
    if (configuredCompiler) {
        return { compilerPath: configuredCompiler, source: 'config' };
    }

    return { compilerPath: '', source: '' };
}

const {
    applyCompilerDiagnostics,
    collectCompilerDiagnostics,
    filterPublishedCompilerDiagnostics,
    findFirstCompilerDiagnostic,
    findFirstLiveValidationDiagnostic,
    hasCompilerErrors,
    parseCompilerIssueLine,
    updateCompilerDiagnosticsForDocumentChange
} = createCompilerDiagnosticService({
    fs,
    isIdentifierBoundaryChar,
    isPawnDocumentForCompilerDiagnosticInvalidation,
    LIVE_VALIDATION_DIAGNOSTIC_SOURCE,
    normalizeCompilerFsPath,
    path,
    shouldPublishCompilerErrorDiagnostics,
    vscode
});

function isDocumentVersionStillCurrent(document, expectedVersion) {
    if (!document || !Number.isInteger(expectedVersion)) return true;
    return document.version === expectedVersion;
}

function pickCompileRevealIssue({
    document,
    diagnosticsByFile
}) {
    const firstLiveError = findFirstLiveValidationDiagnostic(
        document,
        vscode.DiagnosticSeverity.Error
    );
    const firstCompilerError = findFirstCompilerDiagnostic(
        diagnosticsByFile,
        vscode.DiagnosticSeverity.Error
    );
    const firstCompilerWarning = findFirstCompilerDiagnostic(
        diagnosticsByFile,
        vscode.DiagnosticSeverity.Warning
    );

    switch (getCompileRevealTarget()) {
    case 'never':
        return null;
    case 'live-errors':
        return firstLiveError;
    case 'compiler-errors':
        return firstCompilerError;
    case 'compiler-warnings':
        return firstCompilerWarning;
    case 'live-then-compiler':
        return firstLiveError || firstCompilerError;
    case 'all-issues-priority':
    default:
        return firstLiveError || firstCompilerError || firstCompilerWarning;
    }
}

async function showCompileResultToast({
    outputChannel,
    hasCompiledOutput = false,
    hasErrors = false,
    hasWarnings = false
}) {
    const mode = getCompileResultToastMode();
    const isSuccess = hasCompiledOutput && !hasErrors && !hasWarnings;
    const isWarningResult = hasWarnings && !hasErrors;
    const isErrorResult = hasErrors;
    let shouldShowToast = false;

    switch (mode) {
    case 'never':
        shouldShowToast = false;
        break;
    case 'success':
        shouldShowToast = isSuccess;
        break;
    case 'warnings':
        shouldShowToast = isWarningResult;
        break;
    case 'errors':
        shouldShowToast = isErrorResult;
        break;
    case 'success-or-issues':
        shouldShowToast = isSuccess || isWarningResult || isErrorResult;
        break;
    case 'issues':
    default:
        shouldShowToast = isWarningResult || isErrorResult;
        break;
    }

    if (!shouldShowToast) return;

    const showOutputLabel = t('compiler.showOutput');
    let selection;
    if (isErrorResult) {
        selection = await showTimedErrorMessage(vscode,
            t('compiler.failure.toast'),
            showOutputLabel
        );
    } else if (isWarningResult) {
        selection = await showTimedWarningMessage(vscode,
            t('compiler.warning.toast'),
            showOutputLabel
        );
    } else {
        selection = await showTimedInformationMessage(vscode,
            t('compiler.success.toast'),
            showOutputLabel
        );
    }

    if (selection === showOutputLabel) {
        outputChannel.show(true);
    }
}

async function revealCompilerDiagnostic(issue) {
    if (!issue?.filePath || !issue.diagnostic?.range) return;

    try {
        const uri = vscode.Uri.file(issue.filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
            selection: issue.diagnostic.range,
            viewColumn: vscode.ViewColumn.Active,
            preview: false
        });
    } catch {
        // Ignore navigation failures and keep the compiler output visible.
    }
}

function beginCompileSession(outputChannel) {
    outputChannel.clear();
}

function appendCompileSessionSummary(outputChannel, compileContext, compilerPath, resolverSource, exitCode) {
    const resolverLabel = resolverSource
        ? t(`compiler.resolver.${resolverSource}`, null, resolverSource)
        : t('compiler.summary.unknownResolver');
    outputChannel.appendLine('');
    outputChannel.appendLine('-----');
    outputChannel.appendLine(`${t('compiler.summary.compiler')}: ${compilerPath}`);
    outputChannel.appendLine(`${t('compiler.summary.source')}: ${compileContext.sourceFilePath}`);
    outputChannel.appendLine(`${t('compiler.summary.resolver')}: ${resolverLabel}`);
    outputChannel.appendLine(`${t('compiler.summary.output')}: ${compileContext.compileOutputFilePath}`);
    outputChannel.appendLine(`${t('compiler.summary.exitCode')}: ${exitCode}`);
}

function runPostCompileUi({ outputChannel, hasCompiledOutput, hasErrors, hasWarnings, issueToReveal }) {
    Promise.resolve()
        .then(() => showCompileResultToast({
            outputChannel,
            hasCompiledOutput,
            hasErrors,
            hasWarnings
        }))
        .catch(() => {});

    Promise.resolve()
        .then(() => revealCompilerDiagnostic(issueToReveal))
        .catch(() => {});
}

async function promptConfigureCompilerPath() {
    const selection = await showTimedErrorMessage(vscode,
        t('compiler.notFound.message'),
        t('common.openSettings')
    );
    if (selection === t('common.openSettings')) {
        vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'amxxPawnAllIn.globalCompilerPath'
        );
    }
}

function resolveCompileOutputDirectoryForCompiler(sourceFilePath, compilerPath = '') {
    const configuredValue = String(compilerSettings.compilerOutputDirectory || '').trim();
    if (!configuredValue) return path.dirname(sourceFilePath);
    const documentUri = vscode.Uri.file(sourceFilePath);
    const owningWorkspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    const relativeBaseDir = (() => {
        if (
            compilerSettings.compilerOutputDirectoryBase === 'compiler-root-if-available' &&
            compilerPath
        ) {
            return path.dirname(compilerPath);
        }
        if (
            compilerSettings.compilerOutputDirectoryBase === 'project-root-if-available' &&
            owningWorkspaceFolder?.uri?.fsPath
        ) {
            return owningWorkspaceFolder.uri.fsPath;
        }
        return path.dirname(sourceFilePath);
    })();
    return path.isAbsolute(configuredValue)
        ? path.resolve(configuredValue)
        : path.resolve(relativeBaseDir, configuredValue);
}

function getCompilerOptionArgs() {
    const rawOptions = compilerSettings.compilerOptions;
    if (!Array.isArray(rawOptions)) return [];
    const result = [];
    for (let index = 0; index < rawOptions.length; index++) {
        const option = String(rawOptions[index] || '').trim();
        if (!option) continue;
        if (/^-o$/i.test(option)) {
            index++;
            continue;
        }
        if (/^-o/i.test(option)) continue;
        result.push(option);
    }
    return result;
}

function collectConfiguredCompilerIncludeDirectories(sourceFilePath = '') {
    return collectCompilerIncludeDirectories({
        vscode,
        fs,
        path,
        sourceFilePath,
        projectLocalIncludePaths: compilerSettings.projectLocalIncludePaths,
        programmaticIncludePaths: typeof programmaticIncludePathsGetter === 'function'
            ? (programmaticIncludePathsGetter() || [])
            : [],
        globalIncludePaths: compilerSettings.globalIncludePaths,
        normalizeFsPath: normalizeCompilerFsPath
    });
}

function stripWrappingQuotes(value = '') {
    const text = String(value || '').trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
            return text.slice(1, -1);
        }
    }
    return text;
}

function resolveCompilerOptionIncludeDirectory(rawValue = '', sourceFilePath = '') {
    const value = stripWrappingQuotes(rawValue);
    if (!value) return '';
    const baseDir = sourceFilePath ? path.dirname(sourceFilePath) : process.cwd();
    const candidate = path.isAbsolute(value)
        ? value
        : path.resolve(baseDir, value);
    try {
        return fs.statSync(candidate).isDirectory()
            ? path.resolve(candidate)
            : '';
    } catch {
        return '';
    }
}

function getCompilerOptionIncludeValue(option = '', nextOption = '') {
    const text = String(option || '').trim();
    if (!text) return null;
    if (/^-i$/i.test(text)) {
        return { separate: true, value: String(nextOption || '').trim() };
    }
    const match = text.match(/^-i(.+)$/i);
    if (!match) return null;
    return { separate: false, value: String(match[1] || '').trim() };
}

function filterDuplicateCompilerIncludeOptions(options = [], managedIncludeDirectories = [], sourceFilePath = '') {
    const seenIncludeDirectories = new Set(
        (managedIncludeDirectories || [])
            .map(normalizeCompilerFsPath)
            .filter(Boolean)
    );
    const result = [];
    for (let index = 0; index < options.length; index++) {
        const option = options[index];
        const includeValue = getCompilerOptionIncludeValue(option, options[index + 1]);
        if (!includeValue) {
            result.push(option);
            continue;
        }

        const resolvedDirectory = resolveCompilerOptionIncludeDirectory(includeValue.value, sourceFilePath);
        const normalizedDirectory = normalizeCompilerFsPath(resolvedDirectory);
        if (normalizedDirectory && seenIncludeDirectories.has(normalizedDirectory)) {
            if (includeValue.separate) index++;
            continue;
        }
        if (normalizedDirectory) {
            seenIncludeDirectories.add(normalizedDirectory);
        }
        result.push(option);
        if (includeValue.separate && index + 1 < options.length) {
            result.push(options[index + 1]);
            index++;
        }
    }
    return result;
}

function getCompilerIncludePathArgs(sourceFilePath = '') {
    return collectConfiguredCompilerIncludeDirectories(sourceFilePath)
        .map(includeDir => `-i${includeDir}`);
}

function getCompilerArgs(compileContext) {
    const includeDirectories = collectConfiguredCompilerIncludeDirectories(compileContext.sourceFilePath);
    const compilerOptions = filterDuplicateCompilerIncludeOptions(
        getCompilerOptionArgs(),
        includeDirectories,
        compileContext.sourceFilePath
    );
    return [
        ...includeDirectories.map(includeDir => `-i${includeDir}`),
        ...compilerOptions,
        compileContext.compileFilePath,
        `-o${compileContext.compileOutputFilePath}`
    ];
}

function ensureDirectoryExists(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function createCompileContext(document, compilerPath = '') {
    const sourceFilePath = document.fileName;
    const outputDir = resolveCompileOutputDirectoryForCompiler(sourceFilePath, compilerPath);
    ensureDirectoryExists(outputDir);

    const outputFilePath = path.join(
        outputDir,
        `${path.parse(sourceFilePath).name}.amxx`
    );

    return {
        sourceFilePath,
        compileFilePath: sourceFilePath,
        compileOutputFilePath: outputFilePath,
        outputDir
    };
}

function scoreDecodedCompilerText(text) {
    const source = String(text || '');
    if (!source) return Number.POSITIVE_INFINITY;

    let score = 0;
    const replacementMatches = source.match(/\uFFFD/g);
    if (replacementMatches) score += replacementMatches.length * 100;
    const suspiciousQuestionMarks = source.match(/\?/g);
    if (suspiciousQuestionMarks) score += suspiciousQuestionMarks.length * 2;
    const suspiciousControlChars = source.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
    if (suspiciousControlChars) score += suspiciousControlChars.length * 25;
    return score;
}

function decodeCompilerChunk(chunk) {
    if (chunk == null) return '';
    if (typeof chunk === 'string') return chunk;

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let bestText = buffer.toString('utf8');
    let bestScore = scoreDecodedCompilerText(bestText);

    for (const encoding of COMPILER_OUTPUT_ENCODINGS) {
        try {
            const decoded = new TextDecoder(encoding).decode(buffer);
            const score = scoreDecodedCompilerText(decoded);
            if (score < bestScore) {
                bestText = decoded;
                bestScore = score;
            }
        } catch {
            // Ignore unsupported encodings in the current runtime.
        }
    }

    return bestText;
}

function registerCompilerIntegration(context, options = {}) {
    programmaticIncludePathsGetter = typeof options.getProgrammaticIncludePaths === 'function'
        ? options.getProgrammaticIncludePaths
        : null;
    refreshCompilerSettings();
    const outputChannel = vscode.window.createOutputChannel(COMPILER_OUTPUT_CHANNEL_NAME);
    const diagnosticCollection = vscode.languages.createDiagnosticCollection(COMPILER_DIAGNOSTIC_COLLECTION_ID);
    context.subscriptions.push(outputChannel, diagnosticCollection);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(EXTENSION_CONFIG_NS)) {
                refreshCompilerSettings();
            }
        })
    );
    if (typeof vscode.workspace.onDidChangeTextDocument === 'function') {
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (Array.isArray(event?.contentChanges) && event.contentChanges.length === 0) return;
                updateCompilerDiagnosticsForDocumentChange(diagnosticCollection, event);
            })
        );
    }

    const compileCurrentFile = async () => {
        const editor = vscode.window.activeTextEditor;
        const document = editor?.document || null;

        if (!isCompilablePawnDocument(document)) {
            showTimedErrorMessage(vscode, t('compiler.invalidDocument.message'));
            return;
        }

        const compileJobKey = normalizeCompilerFsPath(document.fileName);
        if (activeCompileJobs.has(compileJobKey)) {
            return;
        }
        activeCompileJobs.set(compileJobKey, true);

        try {
            await document.save();
            const compiledDocumentVersion = Number.isInteger(document.version)
                ? document.version
                : null;

            const { compilerPath, source } = resolveCompilerPath(document.fileName);
            if (!compilerPath || !fs.existsSync(compilerPath)) {
                await promptConfigureCompilerPath();
                return;
            }

            if (shouldShowCompileStartToast()) {
                showTimedInformationMessage(vscode,
                    t('compiler.startNotification', {
                        fileName: path.basename(document.fileName)
                    })
                );
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: t('compiler.progressTitle', {
                    fileName: path.basename(document.fileName)
                }),
                cancellable: false
            }, async () => {
                diagnosticCollection.clear();
                beginCompileSession(outputChannel);
                const compileContext = createCompileContext(document, compilerPath);

                const compileCwd = path.dirname(document.fileName);
                const compilerArgs = getCompilerArgs(compileContext);

                await new Promise(resolve => {
                    const child = spawn(compilerPath, compilerArgs, {
                        cwd: compileCwd,
                        windowsHide: true
                    });

                    const outputChunks = [];
                    let finished = false;
                    let closeFallbackTimer = null;

                    const appendChunk = chunk => {
                        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
                        outputChunks.push(buffer);
                        const text = decodeCompilerChunk(chunk);
                        if (!text) return;
                        outputChannel.append(text);
                    };

                    child.stdout.on('data', appendChunk);
                    child.stderr.on('data', appendChunk);

                    const finishWithSpawnError = error => {
                        if (finished) return;
                        finished = true;
                        if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
                        outputChannel.appendLine('');
                        outputChannel.appendLine(t('compiler.spawnFailed.output', { message: error.message }));
                        showTimedErrorMessage(vscode, t('compiler.spawnFailed.toast'));
                        resolve();
                    };

                    const finishWithCompilerResult = exitCode => {
                        if (finished) return;
                        finished = true;
                        if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
                        const combinedOutput = outputChunks.length
                            ? decodeCompilerChunk(Buffer.concat(outputChunks))
                            : '';
                        const diagnosticsByFile = collectCompilerDiagnostics(combinedOutput, compileCwd);
                        const publishedDiagnosticsByFile = filterPublishedCompilerDiagnostics(diagnosticsByFile);
                        if (isDocumentVersionStillCurrent(document, compiledDocumentVersion)) {
                            applyCompilerDiagnostics(diagnosticCollection, publishedDiagnosticsByFile);
                        }

                        const hasCompiledOutput = exitCode === 0 && fs.existsSync(compileContext.compileOutputFilePath);
                        const hasErrors = exitCode !== 0 || hasCompilerErrors(diagnosticsByFile);
                        const hasWarnings = [...diagnosticsByFile.values()].some(entry =>
                            entry.diagnostics.some(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Warning)
                        );
                        appendCompileSessionSummary(outputChannel, compileContext, compilerPath, source, exitCode);

                        const shouldRevealOutput = shouldRevealCompilerOutputForResult({
                            hasErrors,
                            hasWarnings
                        });
                        if (shouldRevealOutput) {
                            outputChannel.show(true);
                        }

                        const issueToReveal = pickCompileRevealIssue({
                            document,
                            diagnosticsByFile
                        });
                        runPostCompileUi({
                            outputChannel,
                            hasCompiledOutput,
                            hasErrors,
                            hasWarnings,
                            issueToReveal
                        });
                        resolve();
                    };

                    child.on('error', finishWithSpawnError);
                    child.on('exit', exitCode => {
                        closeFallbackTimer = setTimeout(
                            () => finishWithCompilerResult(exitCode),
                            COMPILER_CLOSE_FALLBACK_MS
                        );
                    });
                    child.on('close', finishWithCompilerResult);
                });
            });
        } finally {
            activeCompileJobs.delete(compileJobKey);
        }
    };

    const compileCommand = vscode.commands.registerCommand(COMPILE_COMMAND_ID, compileCurrentFile);
    context.subscriptions.push(compileCommand);

    return {
        compileCurrentFile
    };
}

module.exports = {
    registerCompilerIntegration,
    _test: {
        collectCompilerDiagnostics,
        parseCompilerIssueLine,
        decodeCompilerChunk,
        collectConfiguredCompilerIncludeDirectories,
        filterDuplicateCompilerIncludeOptions,
        getCompilerArgs,
        getCompilerIncludePathArgs,
        hasConfiguredPawnSourceExtension,
        isCompilablePawnDocument,
        normalizeExtensionList
    }
};
