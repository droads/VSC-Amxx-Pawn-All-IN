function getWorkspaceFolders(vscode) {
    return Array.isArray(vscode?.workspace?.workspaceFolders)
        ? vscode.workspace.workspaceFolders.filter(folder => folder?.uri?.fsPath)
        : [];
}

function getWorkspaceFolderForFile(vscode, docFilePath = '') {
    if (!docFilePath || typeof vscode?.workspace?.getWorkspaceFolder !== 'function') return null;
    try {
        return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(docFilePath)) || null;
    } catch {
        return null;
    }
}

function getProjectRootForFile({ vscode, path }, docFilePath = '') {
    if (docFilePath) {
        const workspaceFolder = getWorkspaceFolderForFile(vscode, docFilePath);
        if (workspaceFolder?.uri?.fsPath) return workspaceFolder.uri.fsPath;
        return path.dirname(docFilePath);
    }
    return getWorkspaceFolders(vscode)?.[0]?.uri?.fsPath || '';
}

function getWorkspaceRootForFile({ vscode }, docFilePath = '') {
    if (!docFilePath) return getWorkspaceFolders(vscode)?.[0]?.uri?.fsPath || '';
    const workspaceFolder = getWorkspaceFolderForFile(vscode, docFilePath);
    return workspaceFolder?.uri?.fsPath || '';
}

function normalizeProjectIncludeHints(rawHints, fallback = ['include']) {
    const source = Array.isArray(rawHints) ? rawHints : fallback;
    return source
        .map(value => String(value || '').trim())
        .filter(Boolean);
}

function defaultNormalizeFsPath(path, filePath = '') {
    if (!filePath) return '';
    try {
        return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
    } catch {
        return String(filePath || '').replace(/\\/g, '/').toLowerCase();
    }
}

function getSourceKind(sourcePath = '', deps = {}) {
    if (!sourcePath) return '';
    if (typeof deps.getSourceKind === 'function') {
        return deps.getSourceKind(sourcePath) || '';
    }
    try {
        const stat = deps.fs?.statSync?.(sourcePath);
        if (stat?.isDirectory?.()) return 'directory';
        if (stat?.isFile?.()) return 'file';
    } catch {
        return '';
    }
    return '';
}

function isAllowedSourceKind(kind = '', allowedKinds = null) {
    if (!kind) return false;
    if (!Array.isArray(allowedKinds) || !allowedKinds.length) {
        return kind === 'directory' || kind === 'file';
    }
    return allowedKinds.includes(kind);
}

function normalizePathKey(sourcePath = '', deps = {}) {
    const normalize = typeof deps.normalizeFsPath === 'function'
        ? deps.normalizeFsPath
        : value => defaultNormalizeFsPath(deps.path, value);
    return normalize(sourcePath);
}

function pushUniqueSource(results, seen, sourcePath = '', deps = {}) {
    const kind = getSourceKind(sourcePath, deps);
    if (!isAllowedSourceKind(kind, deps.allowedKinds)) return;
    const key = normalizePathKey(sourcePath, deps);
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(deps.path.resolve(sourcePath));
}

function collectUniqueSources(sourceLists = [], deps = {}) {
    const seen = new Set();
    const results = [];
    for (const sourceList of sourceLists || []) {
        const entries = Array.isArray(sourceList) ? sourceList : [sourceList];
        for (const sourcePath of entries) {
            pushUniqueSource(results, seen, sourcePath, deps);
        }
    }
    return results;
}

function isSameOrInsidePath({ path }, candidatePath = '', rootPath = '') {
    if (!candidatePath || !rootPath) return false;
    let relative = '';
    try {
        relative = path.relative(rootPath, candidatePath);
    } catch {
        return false;
    }
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveConfiguredIncludeSource(rawPath, docFilePath = '', deps = {}) {
    const value = String(rawPath || '').trim();
    if (!value) return '';

    const candidates = [];
    if (deps.path.isAbsolute(value)) {
        candidates.push(value);
    } else {
        for (const folder of getWorkspaceFolders(deps.vscode)) {
            candidates.push(deps.path.join(folder.uri.fsPath, value));
        }
        if (!getWorkspaceFolders(deps.vscode).length && docFilePath) {
            candidates.push(deps.path.join(deps.path.dirname(docFilePath), value));
        }
    }

    for (const candidate of candidates) {
        const kind = getSourceKind(candidate, deps);
        if (isAllowedSourceKind(kind, deps.allowedKinds)) return deps.path.resolve(candidate);
    }
    return '';
}

function collectConfiguredGlobalIncludeSources(rawPaths = [], docFilePath = '', deps = {}) {
    const resolvedPaths = [];
    for (const rawPath of rawPaths || []) {
        const resolved = resolveConfiguredIncludeSource(rawPath, docFilePath, deps);
        if (resolved) resolvedPaths.push(resolved);
    }
    return collectUniqueSources([resolvedPaths], deps);
}

function collectExactProjectIncludeSources(rootPath = '', hints = [], deps = {}) {
    if (!rootPath) return [];
    const exactPaths = [];
    for (const hint of normalizeProjectIncludeHints(hints)) {
        exactPaths.push(deps.path.isAbsolute(hint) ? hint : deps.path.join(rootPath, hint));
    }
    return collectUniqueSources([exactPaths], deps);
}

function collectCompilerIncludeDirectories(options = {}) {
    const {
        vscode,
        fs,
        path,
        sourceFilePath = '',
        projectLocalIncludePaths = ['include'],
        programmaticIncludePaths = [],
        globalIncludePaths = []
    } = options;
    const deps = {
        vscode,
        fs,
        path,
        normalizeFsPath: options.normalizeFsPath,
        allowedKinds: ['directory']
    };
    const projectRoot = getProjectRootForFile({ vscode, path }, sourceFilePath);
    return collectUniqueSources([
        collectExactProjectIncludeSources(
            projectRoot,
            normalizeProjectIncludeHints(projectLocalIncludePaths),
            deps
        ),
        collectConfiguredGlobalIncludeSources(programmaticIncludePaths, sourceFilePath, deps),
        collectConfiguredGlobalIncludeSources(globalIncludePaths, sourceFilePath, deps)
    ], deps);
}

module.exports = {
    collectCompilerIncludeDirectories,
    collectConfiguredGlobalIncludeSources,
    collectExactProjectIncludeSources,
    collectUniqueSources,
    defaultNormalizeFsPath,
    getProjectRootForFile,
    getWorkspaceRootForFile,
    isSameOrInsidePath,
    normalizePathKey,
    normalizeProjectIncludeHints,
    resolveConfiguredIncludeSource
};
