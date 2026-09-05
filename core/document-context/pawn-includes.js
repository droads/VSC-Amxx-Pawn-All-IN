// Pawn include/path resolution belongs to the document-context subsystem because it
// feeds preprocessing, active include tracking, and include declaration caches.
const {
    getDefineStateSignature,
    getIncludeEntriesSignatureHash: buildIncludeEntriesSignatureHash
} = require('../utils/signature');
const { createUtilityCore } = require('../utils/runtime');
const { getEffectiveIncludeFileExtensions } = require('../include-extensions');
const {
    INCLUDE_RESOLUTION_PRIORITY,
    isPreferredIncludeCandidate,
    normalizeIncludePriority
} = require('../include-priority');
const {
    collectConfiguredGlobalIncludeSources: collectConfiguredGlobalIncludeSourcesCore,
    collectExactProjectIncludeSources,
    collectUniqueSources,
    getProjectRootForFile: getSharedProjectRootForFile,
    getWorkspaceRootForFile: getSharedWorkspaceRootForFile,
    isSameOrInsidePath: isSameOrInsidePathCore,
    normalizeProjectIncludeHints,
    resolveConfiguredIncludeSource
} = require('../include-search-paths');
const { splitPawnLines } = require('../syntax/lines');
const { getPreprocessedCtrlCharState } = require('../syntax/preprocessed-state');
const {
    parseDeprecatedPragmaMessage,
    applyDeprecatedPragmaToNextDecl
} = require('../declarations/docs');
const { createIncludeCacheCodec } = require('./include-cache-codec');
const {
    attachIncludeDeclIndexesFromSerializedOrBuild,
    createIncludeDeclAccumulator,
    dedupeIncludeDecls,
    serializeIncludeDeclIndexes
} = require('./include-decl-indexes');
const { createIncludePersistentCache } = require('./include-persistent-cache');

const { normalizeExtensionList: defaultNormalizeExtensionList } = createUtilityCore();
const DEFINE_STATE_DIRECTIVE_RE = /^#\s*(define|undef)\b/;

function createDocumentIncludeSystem(deps) {
    const {
        vscode,
        fs,
        path,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths,
        getProgrammaticIncludePaths = () => [],
        getIncludeFileExtensions,
        normalizeFsPath,
        resolvedIncludePathCache,
        searchPathCache,
        projectIncludeSourceCache,
        preprocessPawnContent,
        withCtrlCharForContent,
        stripLineComment,
        stripCommentsFromLines,
        getIncludeNameFromLine,
        getIncludePreprocessedStateKey,
        getIncludeDeclCacheKey,
        getActiveIncludeDeclsCacheKey,
        getDefineStateKey,
        includeFileDecls,
        getFileStamp,
        readNormalizedFileContent,
        isSameFileStamp,
        getFileSnapshot,
        getCtrlCharStateForContent,
        computeLineDepths,
        extractDocs,
        parseEnumBlock,
        getPotentialDeclarationStartLineKind,
        collectDeclarationText,
        collectDefineDeclarationText,
        parseDeclLine,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        activeIncludeDeclsCache,
        areDependencyStampsFresh,
        buildDependencyStampMap,
        normalizeExtensionList = defaultNormalizeExtensionList,
        persistentIncludeDeclCacheRoot = '',
        persistentIncludeDeclCacheMaxBytes = 24 * 1024 * 1024
    } = deps;
    const directoryFileBaseNameCache = new Map();
    const baseIncludeResolutionCache = new Map();
    const includeSourceKindCache = new Map();
    const includeCompletionSourceCache = new Map();
    const ancestorIncludeBaseDirsCache = new Map();
    const ancestorIncludeHintDirsCache = new Map();
    const searchPathSignatureCache = new Map();
    const searchPathsArraySignatureCache = new Map();
    const searchPathsArrayIdentitySignatureCache = new WeakMap();
    let includeResolutionInfoCache = null;
    let projectIncludeHintsCache = null;
    let searchPathCacheSettingsSignatureCache = null;
    const INCLUDE_SOURCE_KIND_CACHE_TTL_MS = 1500;
    const SEARCH_PATHS_ARRAY_SIGNATURE_CACHE_LIMIT = 128;
    const {
        INCLUDE_DECL_COMPACT_SIGNATURE,
        deserializeDependencyStamps,
        getSerializedIncludeEntryFilePath,
        reviveIncludeDeclCompactObject,
        revivePreprocessedState,
        serializeDependencyStamps,
        serializeIncludeDecls,
        serializePreprocessedState
    } = createIncludeCacheCodec({
        normalizeFsPath,
        getDefineStateKey,
        getDefineStateSignature
    });

    function getSearchPathContextCacheKey(filePath = '') {
        const workspaceRoot = getProjectRootForFile(filePath);
        const fallbackBase = !(vscode.workspace.workspaceFolders || []).length && filePath
            ? path.dirname(filePath)
            : '';
        return [
            normalizeFsPath(workspaceRoot),
            normalizeFsPath(fallbackBase),
            getSearchPathCacheSettingsSignature()
        ].join('::');
    }

    function getSearchPathSignature(filePath = '') {
        const cacheKey = getSearchPathContextCacheKey(filePath);
        const cached = searchPathSignatureCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const searchPathSignature = getSearchPathsArraySignature(getSearchPaths(filePath) || []);
        const signature = `${searchPathSignature}::ext:${getIncludeResolutionExtensionSignature()}`;
        searchPathSignatureCache.set(cacheKey, signature);
        return signature;
    }

    function getSearchPathsArraySignature(searchPaths = []) {
        const paths = Array.isArray(searchPaths) ? searchPaths : [];
        if (!paths.length) return '';
        const identityCached = searchPathsArrayIdentitySignatureCache.get(paths);
        if (identityCached !== undefined) return identityCached;
        const rawKey = paths.join('\0');
        const cached = searchPathsArraySignatureCache.get(rawKey);
        if (cached !== undefined) {
            searchPathsArrayIdentitySignatureCache.set(paths, cached);
            return cached;
        }
        const signature = paths
            .map(sourcePath => normalizeFsPath(sourcePath))
            .filter(Boolean)
            .join('|');
        searchPathsArrayIdentitySignatureCache.set(paths, signature);
        searchPathsArraySignatureCache.set(rawKey, signature);
        if (searchPathsArraySignatureCache.size > SEARCH_PATHS_ARRAY_SIGNATURE_CACHE_LIMIT) {
            const oldestKey = searchPathsArraySignatureCache.keys().next().value;
            searchPathsArraySignatureCache.delete(oldestKey);
        }
        return signature;
    }

    function getRawPathListSignature(values = []) {
        return (Array.isArray(values) ? values : [])
            .map(value => String(value || '').trim())
            .join('|');
    }

    function getProjectIncludeHintsRawSignature() {
        return getRawPathListSignature(getProjectLocalIncludePaths() || []);
    }

    function getSearchPathCacheSettingsSignature() {
        const projectHintsSignature = getProjectIncludeHintsRawSignature();
        const globalPathsSignature = getRawPathListSignature(getGlobalIncludePaths() || []);
        const programmaticPathsSignature = getRawPathListSignature(
            typeof getProgrammaticIncludePaths === 'function' ? (getProgrammaticIncludePaths() || []) : []
        );
        const extensionSignature = getIncludeResolutionExtensionSignature();
        const rawSignature = [
            projectHintsSignature,
            globalPathsSignature,
            programmaticPathsSignature,
            extensionSignature
        ].join('\0');
        if (searchPathCacheSettingsSignatureCache?.rawSignature === rawSignature) {
            return searchPathCacheSettingsSignatureCache.value;
        }
        const value = [
            `project:${projectHintsSignature}`,
            `global:${globalPathsSignature}`,
            `programmatic:${programmaticPathsSignature}`,
            `ext:${extensionSignature}`
        ].join('::');
        searchPathCacheSettingsSignatureCache = { rawSignature, value };
        return value;
    }

    function getActiveFilesSignature(activeFiles) {
        if (!(activeFiles instanceof Set)) return '';
        return [...activeFiles]
            .map(filePath => normalizeFsPath(filePath))
            .filter(Boolean)
            .sort()
            .join('|');
    }

    function getIncludeDeclEnumKey(decl, fallbackFilePath = '') {
        const name = String(decl?.enumName || decl?.enumDisplayName || decl?.name || '');
        if (!name) return '';
        return `${normalizeFsPath(decl?.filePath || fallbackFilePath)}::${name}`;
    }

    function attachLazyIncludeDocsByDeclFile(decls, fallbackFilePath = '') {
        if (!Array.isArray(decls)) return decls;
        const groups = new Map();
        for (const decl of decls) {
            if (!decl || typeof decl !== 'object') continue;
            const resolvedFilePath = decl.filePath || fallbackFilePath;
            const key = normalizeFsPath(resolvedFilePath);
            if (!key) continue;
            const group = groups.get(key);
            if (group) group.push(decl);
            else groups.set(key, [decl]);
        }
        for (const group of groups.values()) {
            attachLazyIncludeDocs(group, group[0]?.filePath || fallbackFilePath);
        }
        return decls;
    }

    function reviveIncludeDecls(serializedDecls = [], filePath = '', options = {}) {
        if (!Array.isArray(serializedDecls)) return [];
        const revivedDecls = serializedDecls.map(item => {
            const decl = reviveIncludeDeclCompactObject(item);
            return {
                ...decl,
                modifiers: Array.isArray(decl.modifiers) ? [...decl.modifiers] : []
            };
        });
        const decls = dedupeIncludeDecls(revivedDecls);
        const indexes = decls.length === revivedDecls.length ? options.indexes : null;
        const enumDeclByName = new Map();
        for (const decl of decls) {
            if (decl?.type !== 'enum') continue;
            const enumKey = getIncludeDeclEnumKey(decl, filePath);
            if (!enumKey || enumDeclByName.has(enumKey)) continue;
            decl.enumMembers = [];
            enumDeclByName.set(enumKey, decl);
        }
        for (const decl of decls) {
            if (decl?.type !== 'enum-item') continue;
            const enumDecl = enumDeclByName.get(getIncludeDeclEnumKey(decl, filePath));
            if (enumDecl) enumDecl.enumMembers.push(decl);
        }
        if (options.groupDocsByDeclFile) {
            attachLazyIncludeDocsByDeclFile(decls, filePath);
        } else {
            attachLazyIncludeDocs(decls, filePath);
        }
        return options.attachIndexes
            ? attachIncludeDeclIndexesFromSerializedOrBuild(decls, indexes)
            : decls;
    }

    function attachLazyIncludeDocs(decls, filePath = '') {
        if (!Array.isArray(decls) || typeof extractDocs !== 'function') return decls;
        let snapshot = null;
        const docsByLine = new Map();
        const getSnapshot = () => {
            if (snapshot !== null) return snapshot;
            const content = readNormalizedFileContent(filePath);
            snapshot = content == null ? false : getFileSnapshot(filePath, content);
            return snapshot;
        };
        const getDocsForLine = lineNumber => {
            if (!Number.isInteger(lineNumber) || lineNumber < 0) return '';
            if (docsByLine.has(lineNumber)) return docsByLine.get(lineNumber);
            const fileSnapshot = getSnapshot();
            const value = fileSnapshot
                ? extractDocs(fileSnapshot.rawLines || [], lineNumber, {
                    includeInline: true,
                    lineCtrlChars: fileSnapshot.lineCtrlChars || []
                })
                : '';
            docsByLine.set(lineNumber, value || '');
            return value || '';
        };
        const enumDeclLineByName = new Map();
        for (const decl of decls) {
            if (decl?.type !== 'enum') continue;
            const enumKey = String(decl.enumName || decl.enumDisplayName || decl.name || '');
            if (enumKey && !enumDeclLineByName.has(enumKey)) {
                enumDeclLineByName.set(enumKey, decl.lineNumber);
            }
        }
        for (const decl of decls) {
            if (!decl || typeof decl !== 'object') continue;
            if (!Object.prototype.hasOwnProperty.call(decl, 'docs')) {
                Object.defineProperty(decl, 'docs', {
                    enumerable: true,
                    configurable: true,
                    get() {
                        const value = getDocsForLine(decl.lineNumber);
                        Object.defineProperty(decl, 'docs', {
                            enumerable: true,
                            configurable: true,
                            writable: true,
                            value
                        });
                        return value;
                    }
                });
            }
            if (
                decl.type === 'enum-item' &&
                !Object.prototype.hasOwnProperty.call(decl, 'enumDocs')
            ) {
                Object.defineProperty(decl, 'enumDocs', {
                    enumerable: true,
                    configurable: true,
                    get() {
                        const value = getDocsForLine(enumDeclLineByName.get(String(decl.enumName || '')));
                        Object.defineProperty(decl, 'enumDocs', {
                            enumerable: true,
                            configurable: true,
                            writable: true,
                            value
                        });
                        return value;
                    }
                });
            }
        }
        return decls;
    }

    const {
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache,
        readPersistentActiveIncludeDeclCache,
        readPersistentIncludeDeclCache,
        readPersistentIncludePreprocessedState,
        writePersistentActiveIncludeDeclCache,
        writePersistentIncludeDeclCache,
        writePersistentIncludePreprocessedState
    } = createIncludePersistentCache({
        fs,
        path,
        normalizeFsPath,
        persistentIncludeDeclCacheRoot,
        persistentIncludeDeclCacheMaxBytes,
        getDefineStateKey,
        getSearchPathSignature,
        getFileStamp,
        isSameFileStamp,
        areDependencyStampsFresh,
        buildDependencyStampMap,
        buildIncludeEntriesSignatureHash,
        getActiveFilesSignature,
        reviveIncludeDecls,
        serializeIncludeDeclIndexes,
        INCLUDE_DECL_COMPACT_SIGNATURE,
        deserializeDependencyStamps,
        getSerializedIncludeEntryFilePath,
        revivePreprocessedState,
        serializeDependencyStamps,
        serializeIncludeDecls,
        serializePreprocessedState
    });

    function mergeUniqueSources(...sourceLists) {
        return collectUniqueSources(sourceLists, {
            path,
            normalizeFsPath,
            getSourceKind: getIncludeSourceKind
        });
    }

    function buildProjectIncludeCacheKey(rootPath = '', hints = []) {
        return [
            normalizeFsPath(rootPath),
            hints.map(h => h.toLowerCase()).join('|'),
            getIncludeResolutionExtensionSignature()
        ].join('::');
    }

    function hasFreshDiscoveredSources(cacheEntry) {
        return !!(
            cacheEntry &&
            cacheEntry.dirty !== true &&
            Array.isArray(cacheEntry.discoveredSources) &&
            Array.isArray(cacheEntry.allSources)
        );
    }

    function clearRootScopedSearchPathCaches(rootPath = '') {
        const normalizedRoot = normalizeFsPath(rootPath);
        if (!normalizedRoot) return;
        for (const cacheKey of searchPathCache.keys()) {
            if (cacheKey.startsWith(`${normalizedRoot}::`)) {
                searchPathCache.delete(cacheKey);
            }
        }
        for (const cacheKey of searchPathSignatureCache.keys()) {
            if (cacheKey.startsWith(`${normalizedRoot}::`)) {
                searchPathSignatureCache.delete(cacheKey);
            }
        }
        baseIncludeResolutionCache.clear();
        resolvedIncludePathCache.clear();
        clearIncludeCompletionSourceCache(rootPath);
    }

    function clearIncludeCompletionSourceCache(rootPath = '') {
        const normalizedRoot = normalizeFsPath(rootPath);
        if (!normalizedRoot) {
            includeCompletionSourceCache.clear();
            return;
        }
        for (const cacheKey of [...includeCompletionSourceCache.keys()]) {
            if (cacheKey.startsWith(`${normalizedRoot}::`)) {
                includeCompletionSourceCache.delete(cacheKey);
            }
        }
    }

    function clearAncestorIncludeDirCaches() {
        ancestorIncludeBaseDirsCache.clear();
        ancestorIncludeHintDirsCache.clear();
    }

    function resolveConfiguredPath(rawPath, docFilePath = '') {
        return resolveConfiguredIncludeSource(rawPath, docFilePath, {
            vscode,
            path,
            getSourceKind: getIncludeSourceKind
        });
    }

    function getConfiguredGlobalIncludeSources(docFilePath = '') {
        return collectConfiguredGlobalIncludeSourcesCore(getGlobalIncludePaths() || [], docFilePath, {
            vscode,
            path,
            normalizeFsPath,
            getSourceKind: getIncludeSourceKind
        });
    }

    function getConfiguredProgrammaticIncludeSources(docFilePath = '') {
        return collectConfiguredGlobalIncludeSourcesCore(
            (typeof getProgrammaticIncludePaths === 'function' ? getProgrammaticIncludePaths() : []) || [],
            docFilePath,
            {
                vscode,
                path,
                normalizeFsPath,
                getSourceKind: getIncludeSourceKind
            }
        );
    }

    function getConfiguredProjectIncludeHints() {
        const rawSignature = getProjectIncludeHintsRawSignature();
        if (projectIncludeHintsCache?.rawSignature === rawSignature) {
            return projectIncludeHintsCache.hints;
        }
        projectIncludeHintsCache = {
            rawSignature,
            hints: normalizeProjectIncludeHints(getProjectLocalIncludePaths())
        };
        return projectIncludeHintsCache.hints;
    }

    function getConfiguredIncludeFileExtensions() {
        const rawExtensions = getIncludeFileExtensions();
        const normalized = normalizeExtensionList(rawExtensions, [], { useFallbackWhenEmpty: false });
        return getEffectiveIncludeFileExtensions(normalized, { useDefaultCustomWhenEmpty: true });
    }

    function getIncludeResolutionRawSignature() {
        const rawExtensions = getIncludeFileExtensions();
        return Array.isArray(rawExtensions)
            ? rawExtensions.map(value => String(value || '').trim()).join('\0')
            : String(rawExtensions ?? '');
    }

    function getIncludeResolutionInfo() {
        const rawSignature = getIncludeResolutionRawSignature();
        if (includeResolutionInfoCache?.rawSignature === rawSignature) {
            return includeResolutionInfoCache;
        }
        const extensions = getConfiguredIncludeFileExtensions();
        includeResolutionInfoCache = {
            rawSignature,
            extensions,
            signature: extensions.join('|'),
            allowedSet: new Set(extensions),
            priorityByExt: new Map(extensions.map((ext, index) => [ext, index]))
        };
        return includeResolutionInfoCache;
    }

    function getIncludeResolutionExtensions() {
        return getIncludeResolutionInfo().extensions;
    }

    function getIncludeResolutionExtensionSignature() {
        return getIncludeResolutionInfo().signature;
    }

    function hasAllowedIncludeExtension(filePath = '') {
        const ext = path.extname(String(filePath || '')).toLowerCase();
        return !!ext && getIncludeResolutionInfo().allowedSet.has(ext);
    }

    function getProjectRootForFile(docFilePath = '') {
        return getSharedProjectRootForFile({ vscode, path }, docFilePath);
    }

    function getWorkspaceRootForFile(docFilePath = '') {
        return getSharedWorkspaceRootForFile({ vscode }, docFilePath);
    }

    function buildProjectIncludeIndexFromRoot(rootPath = '', hints = [], exactSources = [], options = {}) {
        const includeCompletionEntries = options.includeCompletionEntries === true;
        const emptyIndex = {
            discoveredSources: [],
            allSources: mergeUniqueSources(exactSources),
            includeIndex: new Map(),
            includeCompletionEntries: []
        };
        if (!rootPath || getIncludeSourceKind(rootPath) !== 'directory') return emptyIndex;

        const discoveredSources = [];
        const allSources = mergeUniqueSources(exactSources);
        const includeIndex = new Map();
        const includeCompletionEntryMap = includeCompletionEntries ? new Map() : null;
        const includeExtensionInfo = getIncludeResolutionInfo();
        const includeExtensions = includeExtensionInfo.extensions;
        const allowedExtensions = includeExtensionInfo.allowedSet;
        const extensionPriorityByExt = includeExtensionInfo.priorityByExt;
        const seen = new Set(allSources.map(sourcePath => normalizeFsPath(sourcePath)));
        const sourcePriorityByRoot = new Map();
        allSources.forEach((sourcePath, index) => {
            const normalized = normalizeFsPath(sourcePath);
            if (normalized && !sourcePriorityByRoot.has(normalized)) {
                sourcePriorityByRoot.set(normalized, index);
            }
        });
        const hintBaseNames = new Set((hints || []).map(h => path.basename(h)).filter(Boolean));
        const ignoredDirs = new Set(['.git', '.hg', '.svn', 'node_modules']);
        const isIgnoredAutoDiscoveryDir = name => {
            const text = String(name || '');
            return ignoredDirs.has(text) || (text.startsWith('.') && text.length > 1);
        };
        const exactDirSet = new Set();
        const exactFileSources = [];
        for (const sourcePath of exactSources || []) {
            const sourceKind = getIncludeSourceKind(sourcePath);
            if (sourceKind === 'directory') {
                exactDirSet.add(normalizeFsPath(sourcePath));
            } else if (sourceKind === 'file') {
                exactFileSources.push(path.resolve(sourcePath));
            }
        }
        const addDiscoveredIncludeSource = (sourcePath, sourceKind = '') => {
            if (!sourcePath) return;
            const kind = sourceKind || getIncludeSourceKind(sourcePath);
            if (!kind) return;
            const normalized = normalizeFsPath(sourcePath);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            const resolved = path.resolve(sourcePath);
            sourcePriorityByRoot.set(normalized, allSources.length);
            discoveredSources.push(resolved);
            allSources.push(resolved);
        };
        const indexCandidate = (sourceRoot, filePath) => {
            if (!sourceRoot || !filePath) return;
            const resolvedFilePath = path.resolve(filePath);
            const fileExt = path.extname(resolvedFilePath).toLowerCase();
            if (!allowedExtensions.has(fileExt)) return;
            const fileExtensionPriority = extensionPriorityByExt.get(fileExt) ?? Number.MAX_SAFE_INTEGER;
            const normalizedFilePath = normalizeFsPath(resolvedFilePath);
            if (!normalizedFilePath) return;
            const requestKeys = new Set();
            const fileName = path.basename(resolvedFilePath);
            const parsed = path.parse(fileName);
            const relativePath = path.relative(sourceRoot, resolvedFilePath);
            const normalizedRelative = normalizeFsPath(relativePath).replace(/^\.\//, '');
            const completionRelative = String(relativePath || '').replace(/[\\/]+/g, '/').replace(/^\.\//, '');
            const completionRelativeWithoutExt = completionRelative && parsed.ext
                ? completionRelative.slice(0, -parsed.ext.length)
                : completionRelative;
            const normalizedBaseName = normalizeFsPath(parsed.name);
            const normalizedFileName = normalizeFsPath(fileName);
            if (normalizedRelative) {
                requestKeys.add(normalizedRelative);
                if (parsed.ext) {
                    requestKeys.add(normalizedRelative.slice(0, -parsed.ext.length));
                }
            }
            if (normalizedFileName) requestKeys.add(normalizedFileName);
            if (normalizedBaseName) requestKeys.add(normalizedBaseName);

            const sourcePriority = sourcePriorityByRoot.get(normalizeFsPath(sourceRoot)) ?? Number.MAX_SAFE_INTEGER;
            for (const requestKey of requestKeys) {
                if (!requestKey) continue;
                const existing = includeIndex.get(requestKey);
                if (!isPreferredIncludeCandidate({
                    sourcePriority,
                    extensionPriority: fileExtensionPriority
                }, existing)) {
                    continue;
                }
                includeIndex.set(requestKey, {
                    filePath: resolvedFilePath,
                    sourceRoot: path.resolve(sourceRoot),
                    priority: sourcePriority,
                    sourcePriority,
                    extensionPriority: fileExtensionPriority
                });
            }
            if (includeCompletionEntryMap && completionRelativeWithoutExt) {
                const completionKey = completionRelativeWithoutExt.toLowerCase();
                const existing = includeCompletionEntryMap.get(completionKey);
                if (isPreferredIncludeCandidate({
                    sourcePriority,
                    extensionPriority: fileExtensionPriority
                }, existing)) {
                    includeCompletionEntryMap.set(completionKey, {
                        name: completionRelativeWithoutExt,
                        fileName,
                        filePath: resolvedFilePath,
                        sourceRoot: path.resolve(sourceRoot),
                        sourcePriority,
                        extensionPriority: fileExtensionPriority
                    });
                }
            }
        };
        const walk = (currentDir, activeSourceRoot = '') => {
            let entries = [];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    if (isIgnoredAutoDiscoveryDir(entry.name)) continue;
                    const normalizedDir = normalizeFsPath(fullPath);
                    const nextSourceRoot = activeSourceRoot || (
                        exactDirSet.has(normalizedDir) || hintBaseNames.has(entry.name)
                            ? fullPath
                            : ''
                    );
                    if (nextSourceRoot && nextSourceRoot === fullPath) {
                        addDiscoveredIncludeSource(fullPath, 'directory');
                    }
                    walk(fullPath, nextSourceRoot);
                    continue;
                }
                if (entry.isFile() && activeSourceRoot) {
                    indexCandidate(activeSourceRoot, fullPath);
                }
            }
        };
        for (const exactFileSource of exactFileSources) {
            const sourceRoot = path.dirname(exactFileSource);
            indexCandidate(sourceRoot, exactFileSource);
        }
        walk(rootPath, exactDirSet.has(normalizeFsPath(rootPath)) ? rootPath : '');
        return {
            discoveredSources,
            allSources,
            includeIndex,
            includeCompletionEntries: includeCompletionEntryMap
                ? [...includeCompletionEntryMap.values()]
                    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
                : []
        };
    }

    function ensureProjectIncludeCacheEntry(rootPath = '', options = {}) {
        if (!rootPath || getIncludeSourceKind(rootPath) !== 'directory') return null;
        const hints = getConfiguredProjectIncludeHints();
        const cacheKey = buildProjectIncludeCacheKey(rootPath, hints);
        let cacheEntry = projectIncludeSourceCache.get(cacheKey) || null;
        if (!cacheEntry) {
            const exactSources = collectExactProjectIncludeSources(rootPath, hints, {
                path,
                normalizeFsPath,
                getSourceKind: getIncludeSourceKind
            });
            cacheEntry = {
                exactSources: mergeUniqueSources(exactSources),
                discoveredSources: [],
                allSources: [],
                includeIndex: new Map(),
                includeCompletionEntries: [],
                dirty: true
            };
            projectIncludeSourceCache.set(cacheKey, cacheEntry);
        }

        if (options.refresh !== true) {
            return cacheEntry;
        }

        if (options.forceRefresh !== true && hasFreshDiscoveredSources(cacheEntry)) {
            return cacheEntry;
        }

        const indexState = buildProjectIncludeIndexFromRoot(rootPath, hints, cacheEntry.exactSources);
        cacheEntry.discoveredSources = indexState.discoveredSources;
        cacheEntry.allSources = indexState.allSources;
        cacheEntry.includeIndex = indexState.includeIndex;
        cacheEntry.includeCompletionEntries = indexState.includeCompletionEntries;
        cacheEntry.dirty = false;
        projectIncludeSourceCache.set(cacheKey, cacheEntry);
        return cacheEntry;
    }

    function markWorkspaceIncludeSourcesDirty(docFilePath = '') {
        directoryFileBaseNameCache.clear();
        baseIncludeResolutionCache.clear();
        includeSourceKindCache.clear();
        const rootPath = getProjectRootForFile(docFilePath);
        if (!rootPath) {
            for (const cacheEntry of projectIncludeSourceCache.values()) {
                cacheEntry.dirty = true;
            }
            searchPathCache.clear();
            searchPathSignatureCache.clear();
            resolvedIncludePathCache.clear();
            clearIncludeCompletionSourceCache();
            clearAncestorIncludeDirCaches();
            return;
        }
        const hints = getConfiguredProjectIncludeHints();
        const cacheKey = buildProjectIncludeCacheKey(rootPath, hints);
        const cacheEntry = projectIncludeSourceCache.get(cacheKey);
        if (cacheEntry) {
            cacheEntry.dirty = true;
            projectIncludeSourceCache.set(cacheKey, cacheEntry);
        }
        clearRootScopedSearchPathCaches(rootPath);
        clearAncestorIncludeDirCaches();
    }

    function collectProjectIncludeSourcesFromRoot(rootPath = '', options = {}) {
        if (!rootPath || getIncludeSourceKind(rootPath) !== 'directory') return [];
        const includeDiscovered = options.includeDiscovered !== false;
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, {
            refresh: includeDiscovered
        });
        if (!cacheEntry) return [];

        if (!includeDiscovered) {
            return [...cacheEntry.exactSources];
        }
        return hasFreshDiscoveredSources(cacheEntry)
            ? [...cacheEntry.allSources]
            : mergeUniqueSources(cacheEntry.exactSources, cacheEntry.discoveredSources);
    }

    function collectProjectIncludeSources(docFilePath = '', options = {}) {
        return collectProjectIncludeSourcesFromRoot(getProjectRootForFile(docFilePath), options);
    }

    function getCachedProjectIncludeSourceGroupsFromRoot(rootPath = '') {
        const empty = { exactSources: [], discoveredSources: [] };
        if (!rootPath || getIncludeSourceKind(rootPath) !== 'directory') return empty;
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: false });
        if (!cacheEntry) return empty;
        const exactSources = mergeUniqueSources(cacheEntry.exactSources || []);
        const exactKeys = new Set(exactSources.map(sourcePath => normalizeFsPath(sourcePath)).filter(Boolean));
        const discoveredSourceList = hasFreshDiscoveredSources(cacheEntry)
            ? cacheEntry.discoveredSources
            : [];
        const discoveredSources = mergeUniqueSources(discoveredSourceList || [])
            .filter(sourcePath => {
                const key = normalizeFsPath(sourcePath);
                return key && !exactKeys.has(key);
            });
        return { exactSources, discoveredSources };
    }

    function getCachedProjectIncludeSourceGroups(docFilePath = '') {
        return getCachedProjectIncludeSourceGroupsFromRoot(getProjectRootForFile(docFilePath));
    }

    function getCachedProjectIncludeSourcesFromRoot(rootPath = '') {
        if (!rootPath || getIncludeSourceKind(rootPath) !== 'directory') return [];
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: false });
        if (!cacheEntry) return [];
        return hasFreshDiscoveredSources(cacheEntry)
            ? [...cacheEntry.allSources]
            : [...cacheEntry.exactSources];
    }

    function getCachedProjectIncludeSources(docFilePath = '') {
        return getCachedProjectIncludeSourcesFromRoot(getProjectRootForFile(docFilePath));
    }

    function getIncludeCompletionEntriesFromDirectory(sourceRoot = '') {
        if (!sourceRoot || getIncludeSourceKind(sourceRoot) !== 'directory') return [];
        const normalizedRoot = normalizeFsPath(sourceRoot);
        if (!normalizedRoot) return [];
        const stat = getIncludeSourceStat(sourceRoot);
        if (!stat) return [];
        const stamp = `${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}:${getIncludeResolutionExtensionSignature()}`;

        const cacheKey = `${normalizedRoot}::${getIncludeResolutionExtensionSignature()}`;
        const cached = includeCompletionSourceCache.get(cacheKey);
        if (cached?.stamp === stamp && Array.isArray(cached.entries)) {
            return cached.entries;
        }

        const indexState = buildProjectIncludeIndexFromRoot(sourceRoot, [], [sourceRoot], {
            includeCompletionEntries: true
        });
        const entries = Array.isArray(indexState.includeCompletionEntries)
            ? indexState.includeCompletionEntries
            : [];
        includeCompletionSourceCache.set(cacheKey, { stamp, entries });
        return entries;
    }

    function getIncludeCompletionEntriesFromFile(sourcePath = '') {
        if (!sourcePath || getIncludeSourceKind(sourcePath) !== 'file') return [];
        if (!hasAllowedIncludeExtension(sourcePath)) return [];
        const fileName = path.basename(sourcePath);
        const parsed = path.parse(fileName);
        if (!parsed.name) return [];
        return [{
            name: parsed.name,
            fileName,
            filePath: path.resolve(sourcePath),
            sourceRoot: path.dirname(sourcePath),
            sourcePriority: 0,
            extensionPriority: getIncludeResolutionInfo().priorityByExt.get(parsed.ext.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
        }];
    }

    function getIncludeCompletionEntriesFromSource(sourcePath = '') {
        const sourceKind = getIncludeSourceKind(sourcePath);
        if (sourceKind === 'directory') return getIncludeCompletionEntriesFromDirectory(sourcePath);
        if (sourceKind === 'file') return getIncludeCompletionEntriesFromFile(sourcePath);
        return [];
    }

    function collectIncludeCompletionSources(docFilePath = '', delimiter = '') {
        const includeLocalFirst = String(delimiter || '') !== '<>';
        const completionBoundaryRoot = getWorkspaceRootForFile(docFilePath) || getProjectRootForFile(docFilePath);
        const sources = [];
        const seen = new Set();
        const addSource = (sourcePath, sourceKind, options = {}) => {
            if (!sourcePath || !getIncludeSourceKind(sourcePath)) return;
            if (
                completionBoundaryRoot &&
                options.insideWorkspaceOnly &&
                !isSameOrInsidePathCore({ path }, sourcePath, completionBoundaryRoot)
            ) {
                return;
            }
            const sourceKey = normalizeFsPath(sourcePath);
            if (!sourceKey || seen.has(sourceKey)) return;
            seen.add(sourceKey);
            sources.push({ sourcePath, sourceKind });
        };

        if (includeLocalFirst && docFilePath) {
            addSource(path.dirname(docFilePath), 'local');
            for (const ancestorBase of collectAncestorIncludeBaseDirs(docFilePath)) {
                addSource(ancestorBase, 'local', { insideWorkspaceOnly: true });
            }
        }

        if (docFilePath) {
            const hintSourceKind = includeLocalFirst ? 'local' : 'include';
            for (const hintedBase of collectAncestorIncludeHintDirs(docFilePath)) {
                addSource(hintedBase, hintSourceKind, { insideWorkspaceOnly: true });
            }
        }

        for (const sourcePath of getSearchPaths(docFilePath) || []) {
            addSource(sourcePath, 'include');
        }
        return sources;
    }

    function getIncludeCompletionEntries(docFilePath = '', options = {}) {
        const delimiter = String(options.delimiter || '');
        const seenNames = new Set();
        const entries = [];
        for (const source of collectIncludeCompletionSources(docFilePath, delimiter)) {
            const sourcePath = source.sourcePath || '';
            for (const entry of getIncludeCompletionEntriesFromSource(sourcePath)) {
                const name = String(entry?.name || '').replace(/\\/g, '/');
                const nameKey = name.toLowerCase();
                if (!name || seenNames.has(nameKey)) continue;
                seenNames.add(nameKey);
                entries.push({
                    ...entry,
                    name,
                    sourceKind: source.sourceKind
                });
            }
        }
        return entries;
    }

    function warmWorkspaceIncludeSources(docFilePath = '') {
        const roots = collectUniqueSources([
            (vscode.workspace.workspaceFolders || []).map(folder => folder?.uri?.fsPath || '')
        ], {
            path,
            normalizeFsPath,
            getSourceKind: getIncludeSourceKind,
            allowedKinds: ['directory']
        });
        if (!roots.length) {
            const fallbackRoot = getProjectRootForFile(docFilePath);
            if (fallbackRoot) roots.push(fallbackRoot);
        }

        for (const rootPath of roots) {
            const beforeEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: false });
            const beforeSignature = hasFreshDiscoveredSources(beforeEntry)
                ? (beforeEntry.allSources || []).map(sourcePath => normalizeFsPath(sourcePath)).join('|')
                : '';
            const afterEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: true });
            const afterSignature = hasFreshDiscoveredSources(afterEntry)
                ? (afterEntry.allSources || []).map(sourcePath => normalizeFsPath(sourcePath)).join('|')
                : '';
            if (beforeSignature !== afterSignature) {
                clearRootScopedSearchPathCaches(rootPath);
            }
        }
    }

    function tryResolveFromProjectIncludeIndex(name, fromFilePath, options = {}) {
        const rootPath = getProjectRootForFile(fromFilePath);
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: false });
        if (!cacheEntry || !hasFreshDiscoveredSources(cacheEntry)) return null;
        const requestKey = normalizeFsPath(String(name || '').replace(/\\/g, '/'));
        if (!requestKey) return null;
        const indexedEntry = cacheEntry.includeIndex.get(requestKey);
        const indexedPath = typeof indexedEntry === 'string'
            ? indexedEntry
            : indexedEntry?.filePath;
        if (!indexedPath || getIncludeSourceKind(indexedPath) !== 'file') return null;
        if (options.returnMeta) {
            return {
                filePath: indexedPath,
                sourcePath: indexedEntry?.sourceRoot || '',
                sourcePriority: Number.isFinite(indexedEntry?.sourcePriority)
                    ? indexedEntry.sourcePriority
                    : Number.MAX_SAFE_INTEGER,
                resolutionKind: 'project-index'
            };
        }
        return indexedPath;
    }

    function getSearchPaths(docFilePath = '') {
        const cacheKey = getSearchPathContextCacheKey(docFilePath);
        if (searchPathCache.has(cacheKey)) {
            return [...searchPathCache.get(cacheKey)];
        }
        const projectSources = getCachedProjectIncludeSourceGroups(docFilePath);
        const results = mergeUniqueSources(
            projectSources.exactSources,
            getConfiguredProgrammaticIncludeSources(docFilePath),
            getConfiguredGlobalIncludeSources(docFilePath),
            projectSources.discoveredSources
        );
        searchPathCache.set(cacheKey, results);
        return results;
    }

    function getNestedSearchPaths(docFilePath = '', parentSearchPaths = []) {
        return mergeUniqueSources(parentSearchPaths, getSearchPaths(docFilePath));
    }

    function parseRawIncludes(content) {
        const processedContent = preprocessPawnContent(content);
        return withCtrlCharForContent(processedContent, () => {
            const rawLines = splitPawnLines(processedContent);
            const strippedLines = processedContent.includes('/*')
                ? stripCommentsFromLines(rawLines)
                : rawLines;
            return strippedLines
                .map(line => getIncludeNameFromLine(stripLineComment(line).trim()))
                .filter(Boolean);
        });
    }

    function getDirectoryIncludeBaseNameEntry(targetDir, baseName) {
        if (!targetDir || !baseName) return null;
        const targetDirEntry = getIncludeSourceCacheEntry(targetDir);
        if (targetDirEntry.kind !== 'directory') return null;
        const targetDirStat = targetDirEntry.stat;
        if (!targetDirStat) return null;

        const normalizedDir = normalizeFsPath(targetDir);
        if (!normalizedDir) return null;
        const includeExtensionInfo = getIncludeResolutionInfo();
        const includeExtensions = includeExtensionInfo.extensions;
        const includeExtensionSet = includeExtensionInfo.allowedSet;
        const extensionPriority = includeExtensionInfo.priorityByExt;
        const stamp = `${Number(targetDirStat.mtimeMs || 0)}:${Number(targetDirStat.size || 0)}:${includeExtensions.join('|')}`;
        let cachedEntry = directoryFileBaseNameCache.get(normalizedDir);
        if (!cachedEntry || cachedEntry.stamp !== stamp) {
            const byBaseName = new Map();
            const byLowerBaseName = new Map();
            let entries = [];
            try {
                entries = fs.readdirSync(targetDir, { withFileTypes: true });
            } catch {
                return null;
            }
            for (const entry of entries) {
                if (!entry?.name) continue;
                let isFile = entry.isFile();
                if (!isFile && entry.isSymbolicLink?.()) {
                    try {
                        isFile = fs.statSync(path.join(targetDir, entry.name)).isFile();
                    } catch {
                        isFile = false;
                    }
                }
                if (!isFile) continue;
                const entryBaseName = path.parse(entry.name).name;
                const entryExt = path.extname(entry.name).toLowerCase();
                if (!includeExtensionSet.has(entryExt)) continue;
                const priority = extensionPriority.get(entryExt) ?? Number.MAX_SAFE_INTEGER;
                const candidate = { name: entry.name, priority };
                const existing = byBaseName.get(entryBaseName);
                if (!existing || priority < existing.priority) {
                    byBaseName.set(entryBaseName, candidate);
                }
                const lowerKey = entryBaseName.toLowerCase();
                const existingLower = byLowerBaseName.get(lowerKey);
                if (!existingLower || priority < existingLower.priority) {
                    byLowerBaseName.set(lowerKey, candidate);
                }
            }
            cachedEntry = { stamp, byBaseName, byLowerBaseName };
            directoryFileBaseNameCache.set(normalizedDir, cachedEntry);
        }
        return cachedEntry.byBaseName.get(baseName) ||
            cachedEntry.byLowerBaseName?.get(String(baseName || '').toLowerCase()) ||
            null;
    }

    function resolveIncludeFromBase(baseDir, name) {
        const cacheKey = [
            normalizeFsPath(baseDir),
            String(name || '').replace(/\\/g, '/').toLowerCase(),
            getIncludeResolutionExtensionSignature()
        ].join('::');
        if (baseIncludeResolutionCache.has(cacheKey)) {
            return baseIncludeResolutionCache.get(cacheKey) || null;
        }
        const remember = value => {
            baseIncludeResolutionCache.set(cacheKey, value || '');
            return value || null;
        };
        const requestedExt = path.extname(name).toLowerCase();
        if (requestedExt && !hasAllowedIncludeExtension(name)) {
            return remember(null);
        }
        const exactPath = path.join(baseDir, name);
        if (requestedExt && getIncludeSourceKind(exactPath) === 'file') return remember(path.resolve(exactPath));

        if (requestedExt) return remember(null);

        const relDir = path.dirname(name);
        const targetDir = relDir && relDir !== '.'
            ? path.join(baseDir, relDir)
            : baseDir;
        const baseName = path.basename(name);
        const match = getDirectoryIncludeBaseNameEntry(targetDir, baseName)?.name || '';
        if (!match) {
            return remember(null);
        }
        return remember(path.resolve(path.join(targetDir, match)));
    }

    function isPathLikeIncludeName(name = '') {
        const value = String(name || '');
        return value.includes('/') || value.includes('\\');
    }

    function collectAncestorDirs(fromFilePath = '', options = {}) {
        const workspaceRoot = getWorkspaceRootForFile(fromFilePath);
        const workspaceRootKey = workspaceRoot ? normalizeFsPath(workspaceRoot) : '';
        const seen = new Set();
        const results = [];
        let currentBase = path.resolve(options.startDir || path.dirname(fromFilePath));
        for (let depth = 0; currentBase && depth < 24; depth++) {
            const currentKey = normalizeFsPath(currentBase);
            if (!currentKey || seen.has(currentKey)) break;
            seen.add(currentKey);
            results.push(currentBase);

            if (workspaceRootKey && currentKey === workspaceRootKey) break;
            const parent = path.dirname(currentBase);
            if (!parent || parent === currentBase) break;
            currentBase = parent;
        }
        return results;
    }

    function getAncestorDirCacheKey(fromFilePath = '', extra = '') {
        return [
            normalizeFsPath(fromFilePath),
            normalizeFsPath(getWorkspaceRootForFile(fromFilePath)),
            String(extra || '')
        ].join('::');
    }

    function collectAncestorIncludeBaseDirs(fromFilePath = '') {
        if (!fromFilePath) return [];
        const cacheKey = getAncestorDirCacheKey(fromFilePath, 'base');
        const cached = ancestorIncludeBaseDirsCache.get(cacheKey);
        if (cached) return cached.slice();

        const results = collectAncestorDirs(fromFilePath, {
            startDir: path.dirname(path.dirname(fromFilePath))
        });
        ancestorIncludeBaseDirsCache.set(cacheKey, results);
        return results.slice();
    }

    function collectAncestorIncludeHintDirs(fromFilePath = '') {
        if (!fromFilePath) return [];

        const relativeHints = getConfiguredProjectIncludeHints()
            .filter(hint => hint && !path.isAbsolute(hint));
        if (!relativeHints.length) return [];

        const cacheKey = getAncestorDirCacheKey(fromFilePath, `hints:${relativeHints.join('|')}`);
        const cached = ancestorIncludeHintDirsCache.get(cacheKey);
        if (cached) return cached.slice();

        const seenHintDirs = new Set();
        const results = [];
        for (const currentBase of collectAncestorDirs(fromFilePath)) {
            for (const hint of relativeHints) {
                const hintedBase = path.join(currentBase, hint);
                const hintedKey = normalizeFsPath(hintedBase);
                if (!hintedKey || seenHintDirs.has(hintedKey)) continue;
                seenHintDirs.add(hintedKey);
                results.push(hintedBase);
            }
        }
        ancestorIncludeHintDirsCache.set(cacheKey, results);
        return results.slice();
    }

    function resolveIncludeFromAncestorBases(fromFilePath, name) {
        const requestName = String(name || '');
        if (!fromFilePath || !isPathLikeIncludeName(requestName) || path.isAbsolute(requestName)) {
            return null;
        }
        const parts = requestName.replace(/\\/g, '/').split('/');
        if (parts.includes('..')) return null;

        for (const currentBase of collectAncestorIncludeBaseDirs(fromFilePath)) {
            const resolved = resolveIncludeFromBase(currentBase, requestName);
            if (resolved) return resolved;
        }
        return null;
    }

    function resolveIncludeFromAncestorIncludeHints(fromFilePath, name) {
        const requestName = String(name || '');
        if (!fromFilePath || !requestName || path.isAbsolute(requestName)) {
            return null;
        }
        const parts = requestName.replace(/\\/g, '/').split('/');
        if (parts.includes('..')) return null;

        for (const hintedBase of collectAncestorIncludeHintDirs(fromFilePath)) {
            const resolved = resolveIncludeFromBase(hintedBase, requestName);
            if (resolved) return resolved;
        }
        return null;
    }

    function getIncludeSourceCacheEntry(sourcePath) {
        const normalized = normalizeFsPath(sourcePath);
        if (!normalized) return { kind: '', stat: null };
        const now = Date.now();
        const cached = includeSourceKindCache.get(normalized);
        if (cached && (now - cached.at) <= INCLUDE_SOURCE_KIND_CACHE_TTL_MS) {
            return cached;
        }
        let kind = '';
        let stat = null;
        try {
            stat = fs.statSync(sourcePath);
            if (stat.isDirectory()) kind = 'directory';
            else if (stat.isFile()) kind = 'file';
        } catch {
            kind = '';
            stat = null;
        }
        const entry = { kind, stat, at: now };
        includeSourceKindCache.set(normalized, entry);
        return entry;
    }

    function getIncludeSourceKind(sourcePath) {
        return getIncludeSourceCacheEntry(sourcePath).kind;
    }

    function getIncludeSourceStat(sourcePath) {
        return getIncludeSourceCacheEntry(sourcePath).stat;
    }

    function resolveConfiguredIncludeFile(filePath, name, preverifiedFile = false) {
        if (!filePath) return null;
        if (!hasAllowedIncludeExtension(filePath)) return null;
        if (!preverifiedFile) {
            if (getIncludeSourceKind(filePath) !== 'file') return null;
        }

        const fileName = path.basename(filePath);
        const requestBase = path.basename(name);
        if (!requestBase) return null;

        const requestedExt = path.extname(name).toLowerCase();
        if (requestedExt) {
            if (!hasAllowedIncludeExtension(name)) return null;
            return fileName.toLowerCase() === requestBase.toLowerCase()
                ? path.resolve(filePath)
                : null;
        }

        return path.parse(fileName).name.toLowerCase() === requestBase.toLowerCase()
            ? path.resolve(filePath)
            : null;
    }

    function resolveInclude(name, searchPaths, fromFilePath, options = {}) {
        const delimiter = String(options?.delimiter || '');
        const includeLocalFirst = delimiter !== '<>';
        const includeAncestorLocalFallbacks = delimiter !== '<>';
        // Angle includes do not search the source directory, but configured include
        // hints such as "include" can still live under a nested scripting root.
        const includeAncestorHintFallbacks = true;
        const returnMeta = options?.returnMeta === true;
        const makeResolveResult = (filePath, meta = {}) => {
            if (!returnMeta) return filePath;
            return {
                filePath,
                sourcePath: meta.sourcePath || '',
                sourcePriority: normalizeIncludePriority(meta.sourcePriority),
                resolutionKind: meta.resolutionKind || ''
            };
        };
        const makeResolvedIncludeCacheEntry = (filePath, meta = {}) => {
            const resolvedPath = filePath ? path.resolve(filePath) : '';
            if (!resolvedPath) return '';
            return {
                filePath: resolvedPath,
                sourcePath: meta.sourcePath || '',
                sourcePriority: normalizeIncludePriority(meta.sourcePriority),
                resolutionKind: meta.resolutionKind || ''
            };
        };
        const getCachedIncludeFilePath = cachedEntry => {
            if (!cachedEntry) return '';
            return typeof cachedEntry === 'string'
                ? cachedEntry
                : String(cachedEntry.filePath || '');
        };
        const makeCachedResolveResult = cachedEntry => {
            const filePath = getCachedIncludeFilePath(cachedEntry);
            if (!returnMeta) return filePath;
            if (cachedEntry && typeof cachedEntry === 'object') {
                return makeResolveResult(filePath, cachedEntry);
            }
            if (includeLocalFirst && fromFilePath) {
                const baseDir = path.dirname(fromFilePath);
                if (isSameOrInsidePathCore({ path }, filePath, baseDir)) {
                    return makeResolveResult(filePath, {
                        sourcePath: baseDir,
                        sourcePriority: INCLUDE_RESOLUTION_PRIORITY.local,
                        resolutionKind: 'local-cache'
                    });
                }
            }
            const indexedMeta = fromFilePath
                ? tryResolveFromProjectIncludeIndex(name, fromFilePath, { returnMeta: true })
                : null;
            if (indexedMeta && normalizeFsPath(indexedMeta.filePath) === normalizeFsPath(filePath)) {
                return makeResolveResult(filePath, {
                    sourcePath: indexedMeta.sourcePath || '',
                    sourcePriority: indexedMeta.sourcePriority,
                    resolutionKind: 'project-index-cache'
                });
            }
            for (let index = 0; index < (searchPaths || []).length; index++) {
                const sourcePath = searchPaths[index];
                const sourceKind = getIncludeSourceKind(sourcePath);
                const sourceMatches = sourceKind === 'file'
                    ? normalizeFsPath(sourcePath) === normalizeFsPath(filePath)
                    : sourceKind === 'directory'
                    ? isSameOrInsidePathCore({ path }, filePath, sourcePath)
                    : false;
                if (sourceMatches) {
                    return makeResolveResult(filePath, {
                        sourcePath,
                        sourcePriority: INCLUDE_RESOLUTION_PRIORITY.configured + index,
                        resolutionKind: 'search-path-cache'
                    });
                }
            }
            return makeResolveResult(filePath, {
                sourcePriority: Number.MAX_SAFE_INTEGER,
                resolutionKind: 'cache'
            });
        };
        const tryResolveFromSources = (
            sources = [],
            cacheResolvedPath = true,
            basePriority = INCLUDE_RESOLUTION_PRIORITY.configured,
            resolutionKind = 'search-path'
        ) => {
            for (let index = 0; index < (sources || []).length; index++) {
                const sourcePath = sources[index];
                const sourceKind = getIncludeSourceKind(sourcePath);
                const full = sourceKind === 'directory'
                    ? resolveIncludeFromBase(sourcePath, name)
                    : sourceKind === 'file'
                    ? resolveConfiguredIncludeFile(sourcePath, name, true)
                    : null;
                if (!full) continue;
                const meta = {
                    sourcePath,
                    sourcePriority: basePriority + index,
                    resolutionKind
                };
                if (cacheResolvedPath) {
                    resolvedIncludePathCache.set(
                        cacheKey,
                        returnMeta ? makeResolvedIncludeCacheEntry(full, meta) : full
                    );
                }
                return makeResolveResult(full, meta);
            }
            return null;
        };
        const cacheKey = [
            'include-order-v2',
            normalizeFsPath(fromFilePath),
            String(name || ''),
            delimiter,
            getSearchPathsArraySignature(searchPaths),
            getIncludeResolutionExtensionSignature()
        ].join('::');
        if (resolvedIncludePathCache.has(cacheKey)) {
            const cachedEntry = resolvedIncludePathCache.get(cacheKey);
            const cachedPath = getCachedIncludeFilePath(cachedEntry);
            if (!cachedPath) return null;
            if (getIncludeSourceKind(cachedPath) === 'file') return makeCachedResolveResult(cachedEntry);
            resolvedIncludePathCache.delete(cacheKey);
        }

        if (includeLocalFirst && fromFilePath) {
            const baseDir = path.dirname(fromFilePath);
            const localMatch = resolveIncludeFromBase(baseDir, name);
            if (localMatch) {
                const meta = {
                    sourcePath: baseDir,
                    sourcePriority: INCLUDE_RESOLUTION_PRIORITY.local,
                    resolutionKind: 'local'
                };
                resolvedIncludePathCache.set(
                    cacheKey,
                    returnMeta ? makeResolvedIncludeCacheEntry(localMatch, meta) : localMatch
                );
                return makeResolveResult(localMatch, meta);
            }
            if (includeAncestorLocalFallbacks) {
                const ancestorMatch = resolveIncludeFromAncestorBases(fromFilePath, name);
                if (ancestorMatch) {
                    const meta = {
                        sourcePriority: INCLUDE_RESOLUTION_PRIORITY.ancestorLocal,
                        resolutionKind: 'ancestor-local'
                    };
                    resolvedIncludePathCache.set(
                        cacheKey,
                        returnMeta ? makeResolvedIncludeCacheEntry(ancestorMatch, meta) : ancestorMatch
                    );
                    return makeResolveResult(ancestorMatch, meta);
                }
            }
        }

        if (includeAncestorHintFallbacks && fromFilePath) {
            const ancestorHintMatch = resolveIncludeFromAncestorIncludeHints(fromFilePath, name);
            if (ancestorHintMatch) {
                const meta = {
                    sourcePriority: INCLUDE_RESOLUTION_PRIORITY.ancestorHint,
                    resolutionKind: 'ancestor-hint'
                };
                resolvedIncludePathCache.set(
                    cacheKey,
                    returnMeta ? makeResolvedIncludeCacheEntry(ancestorHintMatch, meta) : ancestorHintMatch
                );
                return makeResolveResult(ancestorHintMatch, meta);
            }
        }

        const directMatch = tryResolveFromSources(searchPaths, true);
        if (directMatch) {
            return directMatch;
        }

        const indexedMatch = fromFilePath
            ? tryResolveFromProjectIncludeIndex(name, fromFilePath, { returnMeta: true })
            : null;
        if (indexedMatch) {
            resolvedIncludePathCache.set(cacheKey, makeResolvedIncludeCacheEntry(indexedMatch.filePath, indexedMatch));
            return makeResolveResult(indexedMatch.filePath, indexedMatch);
        }

        if (fromFilePath) {
            const searchPathKeys = new Set((searchPaths || []).map(sourcePath => normalizeFsPath(sourcePath)));
            const discoveredProjectSources = collectProjectIncludeSources(fromFilePath, { includeDiscovered: true })
                .filter(sourcePath => !searchPathKeys.has(normalizeFsPath(sourcePath)));
            const discoveredCacheKey = discoveredProjectSources.length
                ? `${cacheKey}::discovered::${getSearchPathsArraySignature(discoveredProjectSources)}`
                : '';
            const cachedDiscoveredPath = discoveredCacheKey
                ? getCachedIncludeFilePath(resolvedIncludePathCache.get(discoveredCacheKey))
                : '';
            if (cachedDiscoveredPath && getIncludeSourceKind(cachedDiscoveredPath) === 'file') {
                return makeResolveResult(cachedDiscoveredPath, {
                    sourcePriority: INCLUDE_RESOLUTION_PRIORITY.discovered,
                    resolutionKind: 'discovered-cache'
                });
            }
            if (cachedDiscoveredPath && discoveredCacheKey) {
                resolvedIncludePathCache.delete(discoveredCacheKey);
            }
            const discoveredMatch = tryResolveFromSources(
                discoveredProjectSources,
                false,
                INCLUDE_RESOLUTION_PRIORITY.discovered,
                'discovered'
            );
            if (discoveredMatch) {
                if (discoveredCacheKey) {
                    resolvedIncludePathCache.set(
                        discoveredCacheKey,
                        makeResolvedIncludeCacheEntry(
                            returnMeta ? discoveredMatch.filePath : discoveredMatch,
                            returnMeta ? discoveredMatch : {
                                sourcePriority: INCLUDE_RESOLUTION_PRIORITY.discovered,
                                resolutionKind: 'discovered'
                            }
                        )
                    );
                }
                return discoveredMatch;
            }
        }

        resolvedIncludePathCache.set(cacheKey, '');
        return null;
    }

    function parseIncludeFile(filePath, defineDecls = [], precomputedDefineStateKey = '', preprocessedState = null) {
        const defineStateKey = precomputedDefineStateKey || getDefineStateKey(defineDecls);
        const cacheKey = getIncludeDeclCacheKey(filePath, defineDecls, defineStateKey);
        const cachedEntry = includeFileDecls.get(cacheKey) || null;
        const currentFileStamp = getFileStamp(filePath);
        const searchPathSignature = getSearchPathSignature(filePath);
        if (
            cachedEntry &&
            isSameFileStamp(cachedEntry.fileStamp, currentFileStamp) &&
            String(cachedEntry.searchPathSignature || '') === searchPathSignature &&
            cachedEntry.dependencyStamps &&
            areDependencyStampsFresh(cachedEntry.dependencyStamps)
        ) {
            return cachedEntry.decls || [];
        }
        if (cachedEntry) {
            includeFileDecls.delete(cacheKey);
        }
        const persistentEntry = readPersistentIncludeDeclCache(
            filePath,
            defineStateKey,
            currentFileStamp,
            searchPathSignature,
            defineDecls
        );
        if (persistentEntry?.decls) {
            includeFileDecls.set(cacheKey, {
                decls: persistentEntry.decls,
                fileStamp: currentFileStamp,
                searchPathSignature,
                dependencyStamps: persistentEntry.dependencyStamps
            });
            return persistentEntry.decls;
        }
        try {
            let resolvedPreprocessedState = preprocessedState;
            if (!resolvedPreprocessedState) {
                const sourceContent = readNormalizedFileContent(filePath, currentFileStamp);
                if (sourceContent == null) return [];
                const sourceSnapshot = getFileSnapshot(filePath, sourceContent);
                const sourceCtrlCharState = sourceSnapshot.ctrlCharState;
                resolvedPreprocessedState = preprocessPawnContent(sourceContent, {
                    defineDecls,
                    precomputedDefineStateKey: defineStateKey,
                    fromFilePath: filePath,
                    searchPaths: getSearchPaths(filePath),
                    rawLines: sourceSnapshot.rawLines,
                    strippedLines: sourceCtrlCharState.strippedLines || sourceSnapshot.rawLines,
                    lineCtrlChars: sourceCtrlCharState.lineCtrlChars || [],
                    getLineDepths: () => sourceSnapshot.lineDepths,
                    finalCtrlChar: sourceCtrlCharState.finalCtrlChar,
                    directiveCandidateLines: sourceCtrlCharState.directiveCandidateLines || null,
                    returnState: true
                });
            }
            const content  = resolvedPreprocessedState.content;
            const fileName = path.basename(filePath);
            const preprocessedCtrlCharState = getPreprocessedCtrlCharState(resolvedPreprocessedState) || {};
            const rawLines = Array.isArray(resolvedPreprocessedState.rawLines)
                ? resolvedPreprocessedState.rawLines
                : splitPawnLines(content);
            const strippedLines = Array.isArray(preprocessedCtrlCharState.strippedLines)
                ? preprocessedCtrlCharState.strippedLines
                : rawLines;
            const lineCtrlChars = Array.isArray(preprocessedCtrlCharState.lineCtrlChars)
                ? preprocessedCtrlCharState.lineCtrlChars
                : [];
            const depths = resolvedPreprocessedState.lineDepths ||
                computeLineDepths(strippedLines, lineCtrlChars);
            resolvedPreprocessedState.lineDepths = depths;
            const directiveCandidateLines = Array.isArray(resolvedPreprocessedState.directiveCandidateLines)
                ? resolvedPreprocessedState.directiveCandidateLines
                : null;
            const decls = withCtrlCharForContent(content, () => {
                const decls = [];
                let activeDefineDecls = null;
                let pendingDeprecatedMessage = null;
                let directiveCandidateIndex = 0;
                const isDirectiveCandidateLine = lineNumber => {
                    if (!directiveCandidateLines) {
                        return String(strippedLines[lineNumber] || '').indexOf('#') >= 0;
                    }
                    while (
                        directiveCandidateIndex < directiveCandidateLines.length &&
                        directiveCandidateLines[directiveCandidateIndex] < lineNumber
                    ) {
                        directiveCandidateIndex++;
                    }
                    return directiveCandidateLines[directiveCandidateIndex] === lineNumber;
                };
                let i = 0;
                while (i < rawLines.length) {
                    if (depths[i] !== 0) { i++; continue; }
                    const strippedLine = strippedLines[i];
                    if (isDirectiveCandidateLine(i)) {
                        const trimmedDirectiveLine = String(strippedLine || '').trim();
                        const deprecatedMessage = parseDeprecatedPragmaMessage(trimmedDirectiveLine);
                        if (deprecatedMessage != null) {
                            pendingDeprecatedMessage = deprecatedMessage;
                            i++;
                            continue;
                        }
                        if (DEFINE_STATE_DIRECTIVE_RE.test(trimmedDirectiveLine)) {
                            const directive = typeof parsePreprocessorDirectiveLine === 'function'
                                ? parsePreprocessorDirectiveLine(trimmedDirectiveLine)
                                : null;
                            if (directive?.keyword === 'define') {
                                const startI = i;
                                const { text: joined, nextLine } = collectDefineDeclarationText(
                                    rawLines,
                                    i,
                                    lineCtrlChars,
                                    strippedLines
                                );
                                i = nextLine;
                                const parsedDefineDecls = parseDeclLine(
                                    { text: joined, startLine: startI },
                                    rawLines,
                                    filePath,
                                    fileName,
                                    'global'
                                );
                                if (
                                    pendingDeprecatedMessage != null &&
                                    applyDeprecatedPragmaToNextDecl(parsedDefineDecls, pendingDeprecatedMessage)
                                ) {
                                    pendingDeprecatedMessage = null;
                                }
                                const defineDecl = parsedDefineDecls.find(d => d.type === 'define');
                                if (defineDecl?.name) {
                                    if (!activeDefineDecls) activeDefineDecls = new Map();
                                    activeDefineDecls.set(defineDecl.name, defineDecl);
                                }
                                continue;
                            }
                            if (directive?.keyword === 'undef') {
                                const parsedUndef = typeof parsePreprocessorSingleIdentifierPayload === 'function'
                                    ? parsePreprocessorSingleIdentifierPayload(directive)
                                    : null;
                                if (parsedUndef?.name) activeDefineDecls?.delete(parsedUndef.name);
                                i++;
                                continue;
                            }
                        }
                    }
                    const declarationStartKind = getPotentialDeclarationStartLineKind(strippedLine);
                    if (!declarationStartKind) { i++; continue; }
                    if (declarationStartKind === 'enum') {
                        const enumBlock = parseEnumBlock(rawLines, i, filePath, fileName, lineCtrlChars, strippedLines, decls);
                        if (enumBlock) {
                            if (
                                pendingDeprecatedMessage != null &&
                                applyDeprecatedPragmaToNextDecl(enumBlock.decls, pendingDeprecatedMessage)
                            ) {
                                pendingDeprecatedMessage = null;
                            }
                            decls.push(...enumBlock.decls);
                            i = enumBlock.nextLine;
                            continue;
                        }
                    }
                    const startI = i;
                    const { text: joined, nextLine } = collectDeclarationText(rawLines, i, lineCtrlChars, strippedLines);
                    i = nextLine;
                    const parsedDecls = parseDeclLine({ text: joined, startLine: startI }, rawLines, filePath, fileName, 'include');
                    for (const decl of parsedDecls) {
                        if (decl && decl.type === 'variable') {
                            decl.declarationStartLine = startI;
                            decl.declarationNextLine = nextLine;
                        }
                    }
                    if (
                        pendingDeprecatedMessage != null &&
                        applyDeprecatedPragmaToNextDecl(parsedDecls, pendingDeprecatedMessage)
                    ) {
                        pendingDeprecatedMessage = null;
                    }
                    for (const d of parsedDecls) {
                        if (d.type !== 'define') decls.push(d);
                    }
                }
                if (activeDefineDecls?.size) {
                    decls.push(...activeDefineDecls.values());
                }
                const dependencyStamps = buildDependencyStampMap([
                    filePath,
                    ...(resolvedPreprocessedState.includeEntries || []).map(entry => entry.filePath)
                ]);
                includeFileDecls.set(cacheKey, {
                    decls,
                    fileStamp: currentFileStamp || getFileStamp(filePath),
                    searchPathSignature,
                    dependencyStamps
                });
                writePersistentIncludeDeclCache(
                    filePath,
                    defineStateKey,
                    currentFileStamp || getFileStamp(filePath),
                    searchPathSignature,
                    decls,
                    dependencyStamps,
                    defineDecls
                );
                return decls;
            }, filePath, preprocessedCtrlCharState.finalCtrlChar);
            return decls;
        } catch (err) { console.error('parseIncludeFile:', err); }
        return [];
    }

    function collectActiveIncludeEntries(docContent, searchPaths, docFilePath, preprocessedState = null) {
        const sourceSnapshot = preprocessedState ? null : getFileSnapshot(docFilePath, docContent);
        const sourceCtrlCharState = sourceSnapshot?.ctrlCharState || null;
        const resolvedPreprocessedState = preprocessedState || preprocessPawnContent(docContent, {
            fromFilePath: docFilePath,
            searchPaths,
            rawLines: sourceSnapshot?.rawLines,
            strippedLines: sourceCtrlCharState?.strippedLines,
            lineCtrlChars: sourceCtrlCharState?.lineCtrlChars || [],
            finalCtrlChar: sourceCtrlCharState?.finalCtrlChar,
            directiveCandidateLines: sourceCtrlCharState?.directiveCandidateLines || null,
            returnState: true
        });
        return resolvedPreprocessedState.includeEntries || [];
    }

    function getActiveIncludeEntryDedupeKey(entry) {
        const filePath = normalizeFsPath(entry?.filePath || '');
        if (!filePath) return '';
        return `${filePath}\0${String(entry?.defineStateKey || '')}`;
    }

    function getActiveIncludeEntryLogicalKey(entry) {
        const includeName = String(entry?.name || '').trim()
            .replace(/\\/g, '/')
            .toLowerCase();
        if (includeName) return `name:${includeName}`;
        return getActiveIncludeEntryDedupeKey(entry);
    }

    function normalizeActiveIncludeEntries(includeEntries = []) {
        if (!Array.isArray(includeEntries) || includeEntries.length <= 1) {
            return {
                entries: Array.isArray(includeEntries) ? includeEntries : [],
                hasRepeatedFilePath: false
            };
        }
        const seenLogicalKeys = new Set();
        const seenFiles = new Set();
        const seenFilePaths = new Set();
        const result = [];
        let hasRepeatedFilePath = false;
        for (const entry of includeEntries) {
            const logicalKey = getActiveIncludeEntryLogicalKey(entry);
            if (logicalKey && seenLogicalKeys.has(logicalKey)) continue;
            if (logicalKey) seenLogicalKeys.add(logicalKey);
            const key = getActiveIncludeEntryDedupeKey(entry);
            if (key && seenFiles.has(key)) continue;
            if (key) seenFiles.add(key);
            const filePath = normalizeFsPath(entry?.filePath || '');
            if (filePath) {
                if (seenFilePaths.has(filePath)) hasRepeatedFilePath = true;
                else seenFilePaths.add(filePath);
            }
            result.push(entry);
        }
        return {
            entries: result.length === includeEntries.length ? includeEntries : result,
            hasRepeatedFilePath
        };
    }

    function getActiveDecls(docContent, searchPaths, docFilePath, preprocessedState = null) {
        const activeIncludeState = normalizeActiveIncludeEntries(
            collectActiveIncludeEntries(docContent, searchPaths, docFilePath, preprocessedState)
        );
        const includeEntries = activeIncludeState.entries;
        const includeEntriesSignatureHash = buildIncludeEntriesSignatureHash(
            includeEntries,
            normalizeFsPath,
            entry => getDefineStateSignature(entry?.defineDecls || [], entry?.defineStateKey || '')
        );
        const cacheKey = getActiveIncludeDeclsCacheKey(docFilePath, includeEntries, includeEntriesSignatureHash);
        const searchPathSignature = getSearchPathSignature(docFilePath);
        const cached = cacheKey ? activeIncludeDeclsCache.get(cacheKey) : null;
        if (
            cached &&
            String(cached.searchPathSignature || '') === searchPathSignature &&
            areDependencyStampsFresh(cached.dependencyStamps)
        ) {
            return cached.decls;
        }
        const includePreprocessedStates = preprocessedState?.includePreprocessedStates instanceof Map
            ? preprocessedState.includePreprocessedStates
            : null;
        const persistentEntry = readPersistentActiveIncludeDeclCache(
            docFilePath,
            includeEntries,
            searchPathSignature,
            includeEntriesSignatureHash
        );
        if (persistentEntry?.decls) {
            if (includePreprocessedStates) {
                includePreprocessedStates.clear();
                preprocessedState.includePreprocessedStates = null;
            }
            if (cacheKey) {
                activeIncludeDeclsCache.set(cacheKey, {
                    decls: persistentEntry.decls,
                    dependencyStamps: persistentEntry.dependencyStamps,
                    searchPathSignature
                });
            }
            return persistentEntry.decls;
        }
        const declAccumulator = createIncludeDeclAccumulator({
            dedupe: activeIncludeState.hasRepeatedFilePath
        });
        for (const entry of includeEntries) {
            const preparedState = includePreprocessedStates
                ? includePreprocessedStates.get(getIncludePreprocessedStateKey(entry.filePath, entry.defineStateKey, entry.defineDecls || []))
                : null;
            const parsedDecls = parseIncludeFile(entry.filePath, entry.defineDecls, entry.defineStateKey, preparedState) || [];
            declAccumulator.pushDecls(parsedDecls);
        }
        const decls = declAccumulator.finish();
        if (includePreprocessedStates) {
            includePreprocessedStates.clear();
            preprocessedState.includePreprocessedStates = null;
        }

        const dependencyStamps = buildDependencyStampMap((function* () {
            for (const entry of includeEntries) yield entry?.filePath || '';
        })());
        if (cacheKey) {
            activeIncludeDeclsCache.set(cacheKey, {
                decls,
                dependencyStamps,
                searchPathSignature
            });
        }
        writePersistentActiveIncludeDeclCache(
            includeEntries,
            searchPathSignature,
            decls,
            dependencyStamps,
            includeEntriesSignatureHash
        );

        return decls;
    }

    return {
        resolveConfiguredPath,
        getConfiguredGlobalIncludeSources,
        getConfiguredProjectIncludeHints,
        getProjectRootForFile,
        collectProjectIncludeSourcesFromRoot,
        collectProjectIncludeSources,
        getCachedProjectIncludeSourcesFromRoot,
        getCachedProjectIncludeSources,
        getIncludeCompletionEntries,
        clearIncludeCompletionSourceCache,
        markWorkspaceIncludeSourcesDirty,
        warmWorkspaceIncludeSources,
        getSearchPaths,
        getNestedSearchPaths,
        parseRawIncludes,
        readPersistentIncludePreprocessedState,
        writePersistentIncludePreprocessedState,
        resolveIncludeFromBase,
        resolveConfiguredIncludeFile,
        resolveInclude,
        parseIncludeFile,
        collectActiveIncludeEntries,
        getActiveDecls,
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache
    };
}

module.exports = { createDocumentIncludeSystem };
