const { createUtilityCore } = require('../../core/utils/runtime');
const { getEffectiveIncludeFileExtensions } = require('../../core/include-extensions');
const {
    contentChangesCrossLineBoundary,
    getFirstContentChangeStartLine,
    normalizeContentChangeLineRange
} = require('../../core/document-context/incremental-lines');
const {
    createPawnLanguageProbeScanState,
    isPawnLanguageDetectionEligibleDocument,
    readPawnLanguageProbeLine
} = require('../../core/language-detection/pawn-probe');
const { sortUniqueLineNumbers } = require('../../core/syntax/line-number-lists');
const { unrefTimer } = require('../../core/utils/timers');
const { createPrefixedDebugLogger } = require('../../core/utils/debug-logger');

const {
    getDocumentFingerprint: defaultGetDocumentFingerprint,
    normalizeExtensionList: defaultNormalizeExtensionList
} = createUtilityCore();

function createEditorLifecycleFeature(deps) {
    const {
        vscode,
        fs = require('fs'),
        path = require('path'),
        context,
        liveValidationCollection,
        ensureConfiguredPawnLanguage,
        handleOpenedPawnDocument,
        summarizeDocumentEditImpact,
        recordDocumentEditImpact,
        invalidateDocumentCaches,
        normalizeFsPath,
        isPawnDocument,
        getPawnDocumentContext,
        markWorkspaceIncludeSourcesDirty,
        getConfiguredGlobalIncludeSources,
        getProjectRootForFile,
        getExternalIncludeWatchMode,
        normalizeExtensionList = defaultNormalizeExtensionList,
        getPawnFileExtensions = () => ['.sma'],
        getIncludeFileExtensions = () => getEffectiveIncludeFileExtensions(),
        scheduleWarmDocumentContext,
        clearAllScheduledWarmups = () => {},
        getLiveValidationMode,
        getLiveValidationTypingDelayMs = () => 700,
        shouldRunLiveValidationScanOnOpen,
        scheduleLiveValidation,
        resolveEditedValidationPlan,
        lastSavedDocumentVersions,
        getLiveValidationFullCacheKey,
        liveValidationFullResultCache,
        areDependencyStampsFresh = () => false,
        warmDocumentContext,
        warmIncludedDocumentModels,
        clearScheduledLiveValidation,
        handleActivePawnEditor,
        affectsAnyConfiguration,
        SETTINGS_REFRESH_CONFIG_KEYS,
        refreshExtensionSettings,
        CONFIG_KEYS,
        CACHE_RESET_CONFIG_KEYS,
        VALIDATION_DIAGNOSTIC_CONFIG_KEYS = [],
        resetCachesAndWarmActiveDocument,
        isPersistentIncludeDeclarationCacheEnabled,
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache,
        includeDocumentModelWarmCache,
        workspaceIncludeWatcherState,
        bumpDependencyFreshnessVersion,
        THEME_RECOMMENDATION_CONFIG_KEYS,
        themeRecommendationFeature,
        liveValidationTimers,
        getDocumentFingerprint = defaultGetDocumentFingerprint,
        liveValidationOutputChannel = null,
        programmaticIncludePathsService = null
    } = deps;

    const INCLUDE_GRAPH_WATCHER_REFRESH_DELAY_MS = 240;
    const WATCHER_CONTENT_STARTUP_NOISE_GRACE_MS = 1200;
    let startupWarmupTimer = null;
    const getPawnSourceExtensions = () => normalizeExtensionList(getPawnFileExtensions(), ['.sma'], { useFallbackWhenEmpty: true });
    const getPawnIncludeExtensions = () => getEffectiveIncludeFileExtensions(
        normalizeExtensionList(getIncludeFileExtensions(), [], { useFallbackWhenEmpty: false })
    );
    const getIncludeGraphExtensions = () => {
        const result = [];
        for (const ext of [...getPawnSourceExtensions(), ...getPawnIncludeExtensions()]) {
            if (!result.includes(ext)) result.push(ext);
        }
        return result;
    };
    const getFileExtension = filePath => path.extname(String(filePath || '')).toLowerCase();
    const logWatcher = createPrefixedDebugLogger(liveValidationOutputChannel, 'watcher');
    const logLifecycle = createPrefixedDebugLogger(liveValidationOutputChannel, 'lifecycle');
    const getDocumentScheme = document => String(document?.uri?.scheme || '').toLowerCase();
    const isFileBackedLifecycleDocument = document => {
        if (!document) return false;
        const scheme = getDocumentScheme(document);
        return !scheme || scheme === 'file' || scheme === 'untitled';
    };
    const describeWatcherStamp = stamp => {
        if (!stamp) return 'none';
        return `${stamp.kind || ''}:${stamp.mtimeMs ?? ''}:${stamp.size ?? ''}`;
    };
    const isPotentialIncludeGraphFile = filePath => {
        const ext = getFileExtension(filePath);
        return !!ext && getIncludeGraphExtensions().includes(ext);
    };
    const isLiveLifecyclePawnDocument = document => {
        if (!isPawnDocument(document)) return false;
        if (!isFileBackedLifecycleDocument(document)) return false;
        return !/\.git$/i.test(String(document?.fileName || ''));
    };
    const hasPawnLanguageProbeTriggerCandidate = lineText => {
        const lines = String(lineText || '').split(/\r\n|\r|\n/);
        const scanState = createPawnLanguageProbeScanState();
        for (const line of lines) {
            const probe = readPawnLanguageProbeLine(line, scanState);
            if (probe.includeCandidate || probe.syntaxSignal) return true;
        }
        return false;
    };
    const shouldProbePawnLanguageAfterTextChange = (document, contentChanges) => {
        if (!document?.fileName || !Array.isArray(contentChanges) || !contentChanges.length) return false;
        if (!isPawnLanguageDetectionEligibleDocument(document)) return false;
        if (typeof document.lineAt !== 'function') {
            return contentChanges.some(change => hasPawnLanguageProbeTriggerCandidate(change?.text || ''));
        }
        const lineCount = Number.isInteger(document.lineCount) ? document.lineCount : 0;
        if (lineCount <= 0) return false;
        for (const change of contentChanges) {
            const changeText = String(change?.text || '');
            if (hasPawnLanguageProbeTriggerCandidate(changeText)) return true;
            const scanRange = normalizeContentChangeLineRange(change, {
                lineCount,
                paddingBefore: 1,
                paddingAfter: 1,
                includeInsertedLineBreaks: true,
                fallbackLine: null
            });
            if (!scanRange) continue;
            const scanStart = scanRange.startLine;
            const scanEnd = scanRange.endLine;
            for (let lineNumber = scanStart; lineNumber <= scanEnd; lineNumber++) {
                if (hasPawnLanguageProbeTriggerCandidate(document.lineAt(lineNumber)?.text || '')) {
                    return true;
                }
            }
        }
        return false;
    };
    const createIncludeGraphGlob = () => {
        const extensions = getIncludeGraphExtensions()
            .map(ext => ext.replace(/^\./, ''))
            .filter(Boolean);
        if (!extensions.length) return '**/*';
        if (extensions.length === 1) return `**/*.${extensions[0]}`;
        return `**/*.{${extensions.join(',')}}`;
    };
    const normalizeLifecyclePath = filePath => {
        if (!filePath) return '';
        if (typeof normalizeFsPath === 'function') return normalizeFsPath(filePath);
        return path.resolve(String(filePath || '')).replace(/\\/g, '/').toLowerCase();
    };
    const markDependencyGraphChanged = (filePath = '', options = {}) => {
        if (!isPotentialIncludeGraphFile(filePath)) return;
        if (typeof bumpDependencyFreshnessVersion === 'function') {
            bumpDependencyFreshnessVersion(filePath);
        }
        if (options.pathsChanged && typeof markWorkspaceIncludeSourcesDirty === 'function') {
            markWorkspaceIncludeSourcesDirty(filePath);
        }
    };
    const getWatcherKnownFileStamps = () => {
        if (!workspaceIncludeWatcherState.knownFileStamps) {
            workspaceIncludeWatcherState.knownFileStamps = new Map();
        }
        return workspaceIncludeWatcherState.knownFileStamps;
    };
    const readWatcherFileStamp = filePath => {
        const normalized = normalizeLifecyclePath(filePath);
        if (!normalized) return null;
        try {
            const stat = fs.statSync(filePath);
            return {
                kind: 'file',
                mtimeMs: stat?.mtimeMs ?? 0,
                size: stat?.size ?? 0
            };
        } catch {
            return { kind: 'missing', mtimeMs: 0, size: 0 };
        }
    };
    const isSameWatcherFileStamp = (left, right) =>
        !!left &&
        !!right &&
        left.kind === right.kind &&
        left.mtimeMs === right.mtimeMs &&
        left.size === right.size;
    const rememberWatcherFileStamp = filePath => {
        const normalized = normalizeLifecyclePath(filePath);
        if (!normalized || !isPotentialIncludeGraphFile(filePath)) return;
        const stamp = readWatcherFileStamp(filePath);
        if (!stamp) return;
        getWatcherKnownFileStamps().set(normalized, stamp);
    };
    const nowMs = () => Date.now();
    const isWithinWatcherStartupNoiseGrace = () => {
        const until = Number(workspaceIncludeWatcherState.contentStartupNoiseGraceUntil || 0);
        return until > 0 && nowMs() <= until;
    };
    const seedOpenDocumentWatcherFileStamps = () => {
        for (const doc of vscode.workspace.textDocuments || []) {
            if (!isLiveLifecyclePawnDocument(doc)) continue;
            rememberWatcherFileStamp(doc.fileName || '');
            try {
                const ctx = getPawnDocumentContext(doc, undefined);
                for (const entry of ctx?.includeEntries || []) {
                    rememberWatcherFileStamp(entry?.filePath || '');
                }
            } catch {
                // Ignore stamp seeding failures; the watcher will fall back to scheduling.
            }
        }
    };
    const getWatcherContentChangeDecision = filePath => {
        const normalized = normalizeLifecyclePath(filePath);
        if (!normalized) {
            return { schedule: false, reason: 'no-path', normalized, currentStamp: null, previousStamp: null };
        }
        const currentStamp = readWatcherFileStamp(filePath);
        if (!currentStamp || currentStamp.kind === 'missing') {
            return { schedule: true, reason: 'missing-stamp', normalized, currentStamp, previousStamp: null };
        }
        const knownStamps = getWatcherKnownFileStamps();
        const previousStamp = knownStamps.get(normalized) || null;
        knownStamps.set(normalized, currentStamp);
        const graceActive = isWithinWatcherStartupNoiseGrace();
        if (!previousStamp && graceActive) {
            return {
                schedule: false,
                reason: 'startup-no-baseline',
                normalized,
                currentStamp,
                previousStamp,
                graceActive
            };
        }
        if (!previousStamp) {
            return {
                schedule: true,
                reason: 'no-baseline',
                normalized,
                currentStamp,
                previousStamp,
                graceActive
            };
        }
        const sameStamp = isSameWatcherFileStamp(previousStamp, currentStamp);
        return {
            schedule: !sameStamp,
            reason: sameStamp ? 'same-stamp' : 'changed-stamp',
            normalized,
            currentStamp,
            previousStamp,
            graceActive
        };
    };
    const isSameLifecycleDocument = (left, right) => {
        if (!left || !right) return false;
        if (left === right) return true;
        const leftPath = normalizeLifecyclePath(left.fileName || '');
        const rightPath = normalizeLifecyclePath(right.fileName || '');
        return !!leftPath && leftPath === rightPath;
    };
    const isDocumentActive = document =>
        !!document && isSameLifecycleDocument(vscode.window.activeTextEditor?.document || null, document);
    const isDocumentVisible = document =>
        !!document && (vscode.window.visibleTextEditors || []).some(editor =>
            isSameLifecycleDocument(editor?.document || null, document)
        );
    const isHiddenIncludeDocument = document => {
        const docExt = getFileExtension(document?.fileName || '');
        return !!document &&
            !isDocumentActive(document) &&
            !isDocumentVisible(document) &&
            getPawnIncludeExtensions().includes(docExt);
    };
    const isWarmupOnlyIncludeDocument = document => {
        const normalized = normalizeLifecyclePath(document?.fileName || '');
        return !!normalized &&
            isHiddenIncludeDocument(document) &&
            includeDocumentModelWarmCache?.has(normalized);
    };
    const idleVisibleWarmupState = {
        timer: null,
        queue: [],
        queuedKeys: new Set()
    };
    const clearIdleVisibleWarmupTimer = () => {
        if (idleVisibleWarmupState.timer) {
            clearTimeout(idleVisibleWarmupState.timer);
            idleVisibleWarmupState.timer = null;
        }
    };
    const getDocumentQueueKey = document => normalizeLifecyclePath(document?.fileName || '');
    const queueVisibleDocumentWarmup = document => {
        if (!isLiveLifecyclePawnDocument(document) || isDocumentActive(document) || !isDocumentVisible(document)) return;
        const key = getDocumentQueueKey(document);
        if (!key || idleVisibleWarmupState.queuedKeys.has(key)) return;
        idleVisibleWarmupState.queuedKeys.add(key);
        idleVisibleWarmupState.queue.push({ document, key });
    };
    const runNextIdleVisibleWarmup = () => {
        idleVisibleWarmupState.timer = null;
        const next = idleVisibleWarmupState.queue.shift();
        if (!next) return;
        idleVisibleWarmupState.queuedKeys.delete(next.key);
        if (isLiveLifecyclePawnDocument(next.document) && !isDocumentActive(next.document) && isDocumentVisible(next.document)) {
            scheduleWarmDocumentContext(next.document, 0);
        }
        if (idleVisibleWarmupState.queue.length) {
            idleVisibleWarmupState.timer = unrefTimer(setTimeout(runNextIdleVisibleWarmup, 0));
            if (typeof idleVisibleWarmupState.timer.unref === 'function') {
                idleVisibleWarmupState.timer.unref();
            }
        }
    };
    const scheduleVisibleDocumentWarmups = () => {
        for (const editor of vscode.window.visibleTextEditors || []) {
            queueVisibleDocumentWarmup(editor?.document || null);
        }
        if (!idleVisibleWarmupState.timer && idleVisibleWarmupState.queue.length) {
            idleVisibleWarmupState.timer = unrefTimer(setTimeout(runNextIdleVisibleWarmup, 0));
            if (typeof idleVisibleWarmupState.timer.unref === 'function') {
                idleVisibleWarmupState.timer.unref();
            }
        }
    };
    const handleVisibleOrActivePawnDocument = (doc, delayMs = 220) => {
        if (!isLiveLifecyclePawnDocument(doc)) return;
        if (vscode.window.activeTextEditor?.document === doc) {
            handleActivePawnEditor(vscode.window.activeTextEditor, delayMs, liveValidationCollection);
            return;
        }
        if (isDocumentActive(doc) || isDocumentVisible(doc)) {
            handleOpenedPawnDocument(doc, delayMs, liveValidationCollection);
        }
    };
    const ensureAndHandleVisibleOrActivePawnDocument = (doc, delayMs = 220) => {
        if (!doc) return;
        Promise.resolve(ensureConfiguredPawnLanguage(doc))
            .then(pawnDoc => {
                if (!pawnDoc || !isLiveLifecyclePawnDocument(pawnDoc)) return;
                if (!isDocumentActive(pawnDoc) && !isDocumentVisible(pawnDoc)) return;
                handleVisibleOrActivePawnDocument(pawnDoc, delayMs);
            })
            .catch(() => {});
    };
    const getTypingValidationDelayMs = () => {
        const rawDelay = Number(getLiveValidationTypingDelayMs());
        return Number.isFinite(rawDelay)
            ? Math.max(0, Math.min(5000, Math.floor(rawDelay)))
            : 700;
    };
    const getTypingContextWarmupDelayMs = () => {
        const typingDelayMs = getTypingValidationDelayMs();
        if (typingDelayMs <= 0) return 350;
        return Math.min(typingDelayMs, 250);
    };
    const pendingLineChangeValidations = new Map();
    const lastKnownSelectionLineByPath = new Map();
    let lastActiveDocumentPath = normalizeLifecyclePath(vscode.window.activeTextEditor?.document?.fileName || '');
    const getSelectionLine = editor => {
        const line = editor?.selection?.active?.line;
        return Number.isInteger(line) ? line : null;
    };
    const getChangeStartLine = getFirstContentChangeStartLine;
    const didChangeLineBoundary = contentChangesCrossLineBoundary;
    const mergeTextValidationPlans = (left, right) => {
        if (!left) return right || null;
        if (!right) return left;
        if (left.full || right.full) {
            return {
                full: true,
                reason: right.reason || left.reason
            };
        }
        const lines = new Set();
        for (const line of left.lines || []) lines.add(line);
        for (const line of right.lines || []) lines.add(line);
        return {
            lines: sortUniqueLineNumbers(lines),
            reason: right.reason || left.reason,
            editImpact: right.editImpact || left.editImpact
        };
    };
    const scheduleTextValidationPlan = (document, plan, delayMs) => {
        if (!plan) return;
        if (plan.full) {
            scheduleLiveValidation(liveValidationCollection, document, {
                full: true,
                delayMs,
                reason: plan.reason
            });
            return;
        }
        scheduleLiveValidation(liveValidationCollection, document, {
            lines: plan.lines,
            delayMs,
            reason: plan.reason,
            editImpact: plan.editImpact
        });
    };
    const rememberSelectionLine = (document, contentChanges = []) => {
        const key = normalizeLifecyclePath(document?.fileName || '');
        if (!key) return;
        const activeLine = isDocumentActive(document)
            ? getSelectionLine(vscode.window.activeTextEditor)
            : null;
        const fallbackLine = getChangeStartLine(contentChanges);
        const line = activeLine ?? fallbackLine;
        if (Number.isInteger(line)) {
            lastKnownSelectionLineByPath.set(key, line);
        }
        if (Number.isInteger(activeLine)) {
            lastActiveDocumentPath = key;
        }
    };
    const storePendingLineChangeValidation = (document, plan, contentChanges = []) => {
        const key = normalizeLifecyclePath(document?.fileName || '');
        if (!key || !plan) return;
        const existing = pendingLineChangeValidations.get(key);
        pendingLineChangeValidations.set(key, {
            document,
            plan: mergeTextValidationPlans(existing?.plan || null, plan)
        });
        rememberSelectionLine(document, contentChanges);
        logLifecycle(() => `text-change defer-until-line-change file=${document.fileName || ''} reason=${plan.reason || ''}`);
    };
    const takePendingLineChangeValidation = documentOrPath => {
        const key = typeof documentOrPath === 'string'
            ? normalizeLifecyclePath(documentOrPath)
            : normalizeLifecyclePath(documentOrPath?.fileName || '');
        if (!key) return null;
        const entry = pendingLineChangeValidations.get(key) || null;
        pendingLineChangeValidations.delete(key);
        return entry;
    };
    const dropPendingLineChangeValidation = documentOrPath => {
        const key = typeof documentOrPath === 'string'
            ? normalizeLifecyclePath(documentOrPath)
            : normalizeLifecyclePath(documentOrPath?.fileName || '');
        if (!key) return;
        pendingLineChangeValidations.delete(key);
        lastKnownSelectionLineByPath.delete(key);
    };
    const flushPendingLineChangeValidation = (documentOrPath, reason = 'lineChanged') => {
        const entry = takePendingLineChangeValidation(documentOrPath);
        if (!entry?.plan) return false;
        const document = typeof documentOrPath === 'string' ? entry.document : documentOrPath;
        if (!isLiveLifecyclePawnDocument(document)) return false;
        logLifecycle(() => `text-change flush-deferred reason=${reason} file=${document.fileName || ''}`);
        scheduleTextValidationPlan(document, entry.plan, 0);
        return true;
    };

    const hasFreshFullCachedResultForVersion = doc => {
        const fullCacheKey = getLiveValidationFullCacheKey(doc.fileName, doc.version);
        const documentFingerprint = getDocumentFingerprint(doc);
        const cacheKeys = [];
        if (liveValidationFullResultCache.has(fullCacheKey)) {
            cacheKeys.push(fullCacheKey);
        }
        const fullCacheKeyPrefix = `${fullCacheKey}::`;
        for (const key of liveValidationFullResultCache.keys()) {
            if (key.startsWith(fullCacheKeyPrefix)) {
                cacheKeys.push(key);
            }
        }
        for (const key of cacheKeys) {
            const cachedValue = liveValidationFullResultCache.get(key);
            if (!Array.isArray(cachedValue?.diagnostics)) {
                liveValidationFullResultCache.delete(key);
                continue;
            }
            if (!cachedValue.documentFingerprint || cachedValue.documentFingerprint !== documentFingerprint) {
                liveValidationFullResultCache.delete(key);
                continue;
            }
            if (areDependencyStampsFresh(cachedValue.dependencyStamps)) {
                return true;
            }
            liveValidationFullResultCache.delete(key);
        }
        return false;
    };

    const isDocumentAffectedByIncludePath = (doc, changedFilePath = '', options = {}) => {
        if (!isLiveLifecyclePawnDocument(doc)) return false;
        const docPath = normalizeLifecyclePath(doc.fileName);
        const excludedPath = normalizeLifecyclePath(options.excludeFilePath || '');
        if (excludedPath && docPath === excludedPath) return false;
        if (options.pathsChanged) return true;
        const changedPath = normalizeLifecyclePath(changedFilePath);
        if (!changedPath) return false;
        if (docPath === changedPath) return true;
        try {
            const ctx = getPawnDocumentContext(doc, undefined);
            return (ctx?.includeEntries || []).some(entry =>
                normalizeLifecyclePath(entry?.filePath || '') === changedPath
            );
        } catch {
            return false;
        }
    };

    const scheduleOpenPawnDocumentsForDependencyChange = (changedFilePath = '', options = {}) => {
        if (getLiveValidationMode() === 'off') return;
        const scheduledDocumentPaths = new Set();
        for (const doc of vscode.workspace.textDocuments || []) {
            if (isHiddenIncludeDocument(doc)) {
                continue;
            }
            if (!isDocumentAffectedByIncludePath(doc, changedFilePath, options)) continue;
            const freshFullCache = !options.pathsChanged && hasFreshFullCachedResultForVersion(doc);
            if (freshFullCache) {
                continue;
            }
            const documentPath = normalizeLifecyclePath(doc.fileName || '');
            if (documentPath && scheduledDocumentPaths.has(documentPath)) continue;
            if (documentPath) scheduledDocumentPaths.add(documentPath);
            logWatcher(() =>
                `dependency schedule reason=${options.pathsChanged ? 'includePathChanged' : 'includeChanged'} ` +
                `doc=${doc?.fileName || ''} changed=${changedFilePath} pathsChanged=${options.pathsChanged ? 1 : 0}`
            );
            scheduleLiveValidation(liveValidationCollection, doc, {
                full: true,
                delayMs: options.pathsChanged ? 180 : 140,
                reason: options.pathsChanged ? 'includePathChanged' : 'includeChanged'
            });
        }
    };

    const clearPendingLiveDiagnostics = () => {
        liveValidationCollection.clear();
        for (const filePath of liveValidationTimers.keys()) {
            clearScheduledLiveValidation(filePath);
        }
    };

    const refreshOpenPawnDiagnosticsForSettingsChange = (reason = 'configDiagnosticsChanged') => {
        clearPendingLiveDiagnostics();
        const allowWhenModeOff = shouldRunLiveValidationScanOnOpen();
        const mode = getLiveValidationMode();
        if (mode === 'off' && !allowWhenModeOff) return;
        for (const doc of vscode.workspace.textDocuments || []) {
            if (!isLiveLifecyclePawnDocument(doc)) continue;
            scheduleLiveValidation(liveValidationCollection, doc, {
                full: true,
                allowWhenModeOff,
                delayMs: 120,
                reason
            });
        }
    };

    const activatePawnLanguageAfterTextChange = (document, filePath = '') => {
        Promise.resolve(ensureConfiguredPawnLanguage(document))
            .then(pawnDoc => {
                if (!pawnDoc || !isLiveLifecyclePawnDocument(pawnDoc)) {
                    logLifecycle(() =>
                        `language-ensure skip file=${filePath || document?.fileName || ''} ` +
                        `lang=${pawnDoc?.languageId || document?.languageId || ''}`
                    );
                    return;
                }
                const pawnPath = pawnDoc.fileName || filePath;
                logLifecycle(() => `language-ensure ok file=${pawnPath} lang=${pawnDoc.languageId || ''}`);
                markDependencyGraphChanged(pawnPath);
                ensureIncludeGraphWatchers();
                handleVisibleOrActivePawnDocument(pawnDoc, 120);
            })
            .catch(() => {});
    };

    const clearIncludeGraphWatcherRefreshTimer = () => {
        const timer = workspaceIncludeWatcherState.refreshTimer || null;
        if (!timer) return;
        clearTimeout(timer);
        workspaceIncludeWatcherState.refreshTimer = null;
    };

    const scheduleIncludeGraphWatcherRefresh = () => {
        if (typeof vscode.workspace.createFileSystemWatcher !== 'function') return;
        clearIncludeGraphWatcherRefreshTimer();
        const timer = unrefTimer(setTimeout(() => {
            workspaceIncludeWatcherState.refreshTimer = null;
            ensureIncludeGraphWatchers();
        }, INCLUDE_GRAPH_WATCHER_REFRESH_DELAY_MS));
        workspaceIncludeWatcherState.refreshTimer = timer;
    };
    const clearPersistentIncludeDeclCacheIfDisabled = () => {
        if (
            typeof isPersistentIncludeDeclarationCacheEnabled === 'function' &&
            isPersistentIncludeDeclarationCacheEnabled() === false &&
            typeof clearPersistentIncludeDeclCache === 'function'
        ) {
            clearPersistentIncludeDeclCache();
        }
    };
    const prunePersistentIncludeDeclCacheIfEnabled = () => {
        if (
            typeof isPersistentIncludeDeclarationCacheEnabled === 'function' &&
            isPersistentIncludeDeclarationCacheEnabled() !== false &&
            typeof prunePersistentIncludeDeclCache === 'function'
        ) {
            prunePersistentIncludeDeclCache({ force: true });
        }
    };

    const disposeRegisteredIncludeGraphWatchers = () => {
        const watchers = Array.isArray(workspaceIncludeWatcherState.watchers)
            ? workspaceIncludeWatcherState.watchers
            : [];
        for (const watcher of watchers) {
            try {
                watcher?.dispose?.();
            } catch {
                // Ignore watcher disposal failures.
            }
        }
        workspaceIncludeWatcherState.watchers = [];
        workspaceIncludeWatcherState.signature = '';
    };

    const isPathInsideWorkspace = filePath => {
        if (!filePath) return false;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(filePath));
        return !!workspaceFolder?.uri?.fsPath;
    };

    const createWatcherPattern = targetPath => {
        if (!targetPath || typeof vscode.RelativePattern !== 'function') return null;
        try {
            const normalized = path.resolve(targetPath);
            if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
                return new vscode.RelativePattern(path.dirname(normalized), path.basename(normalized));
            }
            return new vscode.RelativePattern(normalized, createIncludeGraphGlob());
        } catch {
            return new vscode.RelativePattern(path.dirname(targetPath), path.basename(targetPath));
        }
    };

    const collectExternalIncludeWatcherTargets = () => {
        const watchMode = typeof getExternalIncludeWatchMode === 'function'
            ? getExternalIncludeWatchMode()
            : 'tracked-resolved-includes';
        if (watchMode === 'workspace-only') {
            return [];
        }

        const results = [];
        const seen = new Set();
        const addTarget = targetPath => {
            const resolved = String(targetPath || '').trim();
            if (!resolved) return;
            const normalized = path.resolve(resolved);
            if (seen.has(normalized)) return;
            seen.add(normalized);
            results.push(normalized);
        };

        for (const sourcePath of getConfiguredGlobalIncludeSources('') || []) {
            addTarget(sourcePath);
        }

        if (watchMode === 'tracked-resolved-includes') {
            for (const doc of vscode.workspace.textDocuments || []) {
                if (isHiddenIncludeDocument(doc)) continue;
                if (!isLiveLifecyclePawnDocument(doc)) continue;
                try {
                    const ctx = getPawnDocumentContext(doc, undefined);
                    for (const entry of ctx?.includeEntries || []) {
                        const includePath = entry?.filePath || '';
                        if (!includePath || isPathInsideWorkspace(includePath)) continue;
                        addTarget(includePath);
                    }
                } catch {
                    // Ignore watcher target collection failures for individual docs.
                }
            }
        }

        if (!(vscode.workspace.workspaceFolders || []).length) {
            const activeDoc = vscode.window.activeTextEditor?.document || null;
            const fallbackRoot = getProjectRootForFile(activeDoc?.fileName || '');
            if (fallbackRoot) {
                addTarget(fallbackRoot);
            }
        }

        return results.filter(targetPath => !isPathInsideWorkspace(targetPath));
    };

    const ensureIncludeGraphWatchers = () => {
        if (typeof vscode.workspace.createFileSystemWatcher !== 'function') return;

        const watcherTargets = ['workspace', ...collectExternalIncludeWatcherTargets()];
        const signature = `${createIncludeGraphGlob()}::${watcherTargets.join('|')}`;
        if (workspaceIncludeWatcherState.signature === signature) {
            return;
        }

        disposeRegisteredIncludeGraphWatchers();
        workspaceIncludeWatcherState.signature = signature;
        workspaceIncludeWatcherState.contentStartupNoiseGraceUntil =
            nowMs() + WATCHER_CONTENT_STARTUP_NOISE_GRACE_MS;
        seedOpenDocumentWatcherFileStamps();
        logWatcher(() =>
            `register targets=${watcherTargets.length} glob=${createIncludeGraphGlob()} ` +
            `graceMs=${WATCHER_CONTENT_STARTUP_NOISE_GRACE_MS} signature=${signature}`
        );

        const handlePathChange = (uri, pathsChanged) => {
            const filePath = uri?.fsPath || uri?.path || '';
            if (!filePath) return;
            if (!isPotentialIncludeGraphFile(filePath)) return;
            let contentDecision = null;
            if (!pathsChanged) {
                contentDecision = getWatcherContentChangeDecision(filePath);
                logWatcher(() =>
                    `event kind=content file=${filePath} schedule=${contentDecision.schedule ? 1 : 0} ` +
                    `reason=${contentDecision.reason} grace=${contentDecision.graceActive ? 1 : 0} ` +
                    `prev=${describeWatcherStamp(contentDecision.previousStamp)} ` +
                    `current=${describeWatcherStamp(contentDecision.currentStamp)}`
                );
            } else {
                logWatcher(() => `event kind=path file=${filePath} schedule=1`);
            }
            if (!pathsChanged && !contentDecision?.schedule) {
                return;
            }
            if (pathsChanged) rememberWatcherFileStamp(filePath);
            markDependencyGraphChanged(filePath, { pathsChanged });
            scheduleOpenPawnDocumentsForDependencyChange(filePath, {
                pathsChanged,
                excludeFilePath: filePath
            });
            scheduleIncludeGraphWatcherRefresh();
        };
        const registerWatcher = pattern => {
            if (!pattern) return;
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            const createSub = watcher.onDidCreate(uri => handlePathChange(uri, true));
            const changeSub = watcher.onDidChange(uri => handlePathChange(uri, false));
            const deleteSub = watcher.onDidDelete(uri => handlePathChange(uri, true));
            workspaceIncludeWatcherState.watchers.push(watcher, createSub, changeSub, deleteSub);
            context.subscriptions.push(watcher, createSub, changeSub, deleteSub);
        };

        registerWatcher(createIncludeGraphGlob());
        for (const targetPath of watcherTargets.slice(1)) {
            registerWatcher(createWatcherPattern(targetPath));
        }
    };

    async function handleDidOpenTextDocument(doc) {
        if (!isFileBackedLifecycleDocument(doc)) return;
        if (isWarmupOnlyIncludeDocument(doc)) return;
        const pawnDoc = await ensureConfiguredPawnLanguage(doc) || doc;
        if (isWarmupOnlyIncludeDocument(pawnDoc)) return;
        const pawnPath = pawnDoc?.fileName || doc?.fileName || '';
        if (isLiveLifecyclePawnDocument(pawnDoc)) {
            invalidateDocumentCaches(pawnPath);
        }
        markDependencyGraphChanged(pawnPath);
        ensureIncludeGraphWatchers();
        handleVisibleOrActivePawnDocument(pawnDoc, 220);
    }

    function handleDidChangeTextDocument(event) {
        const document = event?.document || null;
        if (!isFileBackedLifecycleDocument(document)) return;
        const filePath = document.fileName || '';
        if (!filePath) return;
        if (!Array.isArray(event.contentChanges) || event.contentChanges.length === 0) {
            return;
        }
        const liveDocument = isLiveLifecyclePawnDocument(document);
        const potentialPawnFile = isPotentialIncludeGraphFile(filePath);
        if (liveDocument || potentialPawnFile) {
            logLifecycle(() =>
                `text-change file=${filePath} lang=${document.languageId || ''} ` +
                `mode=${getLiveValidationMode()} live=${liveDocument ? 1 : 0} ` +
                `potential=${potentialPawnFile ? 1 : 0} changes=${event.contentChanges.length}`
            );
        }
        markDependencyGraphChanged(filePath);
        if (potentialPawnFile) {
            scheduleOpenPawnDocumentsForDependencyChange(filePath, { excludeFilePath: filePath });
            scheduleIncludeGraphWatcherRefresh();
        }
        if (!liveDocument) {
            invalidateDocumentCaches(filePath);
            if (
                potentialPawnFile ||
                shouldProbePawnLanguageAfterTextChange(document, event.contentChanges)
            ) {
                logLifecycle(() => `text-change ensure-language file=${filePath} lang=${document.languageId || ''}`);
                activatePawnLanguageAfterTextChange(document, filePath);
            }
            return;
        }

        const editImpact = summarizeDocumentEditImpact(document, event.contentChanges);
        recordDocumentEditImpact(filePath, document.version, editImpact);
        invalidateDocumentCaches(filePath, { editImpact });
        const mode = getLiveValidationMode();
        let validationPlan = null;
        if (mode === 'full') {
            logLifecycle(() => `text-change schedule full file=${filePath}`);
            validationPlan = {
                full: true,
                reason: 'textChangedFull'
            };
        } else if (mode === 'edited') {
            const editedPlan = resolveEditedValidationPlan(document, event.contentChanges, editImpact);
            logLifecycle(() =>
                `text-change schedule edited file=${filePath} full=${editedPlan.full ? 1 : 0} ` +
                `lines=${Array.isArray(editedPlan.lines) ? editedPlan.lines.length : 0} reason=${editedPlan.reason || ''}`
            );
            if (editedPlan.full) {
                validationPlan = {
                    full: true,
                    reason: editedPlan.reason
                };
            } else {
                validationPlan = {
                    lines: editedPlan.lines,
                    reason: editedPlan.reason,
                    editImpact
                };
            }
        } else {
            dropPendingLineChangeValidation(document);
            logLifecycle(() => `text-change skip mode=${mode} file=${filePath}`);
        }
        const typingDelayMs = getTypingValidationDelayMs();
        scheduleWarmDocumentContext(document, getTypingContextWarmupDelayMs());
        if (!validationPlan) return;
        if (typingDelayMs === 0) {
            if (!didChangeLineBoundary(event.contentChanges)) {
                storePendingLineChangeValidation(document, validationPlan, event.contentChanges);
                return;
            }
            const pendingEntry = takePendingLineChangeValidation(document);
            scheduleTextValidationPlan(
                document,
                mergeTextValidationPlans(pendingEntry?.plan || null, validationPlan),
                0
            );
            return;
        }
        const pendingEntry = takePendingLineChangeValidation(document);
        scheduleTextValidationPlan(
            document,
            mergeTextValidationPlans(pendingEntry?.plan || null, validationPlan),
            typingDelayMs
        );
    }

    function handleDidSaveTextDocument(doc) {
        if (!isFileBackedLifecycleDocument(doc)) return;
        if (!doc.fileName) return;
        if (isPotentialIncludeGraphFile(doc.fileName)) {
            markDependencyGraphChanged(doc.fileName);
            scheduleOpenPawnDocumentsForDependencyChange(doc.fileName, { excludeFilePath: doc.fileName });
            scheduleIncludeGraphWatcherRefresh();
            rememberWatcherFileStamp(doc.fileName);
        }
        dropPendingLineChangeValidation(doc);
        const previousSavedVersion = lastSavedDocumentVersions.get(doc.fileName);
        if (previousSavedVersion === doc.version) {
            return;
        }
        if (hasFreshFullCachedResultForVersion(doc)) {
            lastSavedDocumentVersions.set(doc.fileName, doc.version);
            return;
        }
        lastSavedDocumentVersions.set(doc.fileName, doc.version);
        invalidateDocumentCaches(doc.fileName, {
            clearIncludeDecls: true,
            clearAllActiveIncludeDecls: true
        });
        if (isLiveLifecyclePawnDocument(doc)) {
            warmDocumentContext(doc);
            warmIncludedDocumentModels(doc);
            if (getLiveValidationMode() !== 'off') {
                scheduleLiveValidation(liveValidationCollection, doc, { full: true, delayMs: 120, reason: 'saveDocument' });
            }
        }
    }

    function handleDidCloseTextDocument(doc) {
        if (!isFileBackedLifecycleDocument(doc)) return;
        if (isPotentialIncludeGraphFile(doc?.fileName || '') && doc?.isDirty === true) {
            markDependencyGraphChanged(doc?.fileName || '');
            scheduleOpenPawnDocumentsForDependencyChange(doc?.fileName || '', { excludeFilePath: doc?.fileName || '' });
            scheduleIncludeGraphWatcherRefresh();
        }
        if (!isLiveLifecyclePawnDocument(doc)) return;
        dropPendingLineChangeValidation(doc);
        lastSavedDocumentVersions.delete(doc.fileName);
        invalidateDocumentCaches(doc.fileName);
        clearScheduledLiveValidation(doc.fileName);
        liveValidationCollection.delete(doc.uri);
    }

    function handleDidChangeTextEditorSelection(event) {
        if (getTypingValidationDelayMs() !== 0) return;
        const editor = event?.textEditor || null;
        const document = editor?.document || null;
        if (!isLiveLifecyclePawnDocument(document)) return;
        const key = normalizeLifecyclePath(document.fileName || '');
        if (!key) return;
        const nextLine = getSelectionLine(editor);
        if (!Number.isInteger(nextLine)) return;
        const previousLine = lastKnownSelectionLineByPath.get(key);
        lastKnownSelectionLineByPath.set(key, nextLine);
        lastActiveDocumentPath = key;
        if (!pendingLineChangeValidations.has(key)) return;
        if (Number.isInteger(previousLine) && previousLine !== nextLine) {
            flushPendingLineChangeValidation(document, 'selectionLineChanged');
        }
    }

    async function handleDidChangeActiveTextEditor(editor) {
        const nextActivePath = normalizeLifecyclePath(editor?.document?.fileName || '');
        if (getTypingValidationDelayMs() === 0 && lastActiveDocumentPath && lastActiveDocumentPath !== nextActivePath) {
            flushPendingLineChangeValidation(lastActiveDocumentPath, 'activeEditorChanged');
        }
        lastActiveDocumentPath = nextActivePath;
        if (!isFileBackedLifecycleDocument(editor?.document || null)) {
            ensureIncludeGraphWatchers();
            scheduleVisibleDocumentWarmups();
            return;
        }
        const pawnDoc = await ensureConfiguredPawnLanguage(editor?.document || null);
        const targetEditor = pawnDoc && vscode.window.activeTextEditor?.document === pawnDoc
            ? vscode.window.activeTextEditor
            : editor;
        ensureIncludeGraphWatchers();
        handleActivePawnEditor(targetEditor, 160, liveValidationCollection);
        scheduleVisibleDocumentWarmups();
    }

    function handleDidChangeVisibleTextEditors(editors) {
        for (const editor of editors || []) {
            const document = editor?.document || null;
            if (!isFileBackedLifecycleDocument(document)) continue;
            Promise.resolve(ensureConfiguredPawnLanguage(document))
                .then(pawnDoc => {
                    if (!pawnDoc || !isLiveLifecyclePawnDocument(pawnDoc) || isDocumentActive(pawnDoc)) return;
                    queueVisibleDocumentWarmup(pawnDoc);
                    scheduleVisibleDocumentWarmups();
                })
                .catch(() => {});
        }
    }

    function handleDidChangeConfiguration(event) {
        if (affectsAnyConfiguration(event, SETTINGS_REFRESH_CONFIG_KEYS)) {
            refreshExtensionSettings();
        }
        const validationDiagnosticsConfigChanged = affectsAnyConfiguration(
            event,
            VALIDATION_DIAGNOSTIC_CONFIG_KEYS
        );
        if (event.affectsConfiguration(CONFIG_KEYS.persistentIncludeDeclarationCacheMaxMB)) {
            clearPersistentIncludeDeclCacheIfDisabled();
            prunePersistentIncludeDeclCacheIfEnabled();
        }
        if (
            event.affectsConfiguration(CONFIG_KEYS.fileExtensions) ||
            event.affectsConfiguration(CONFIG_KEYS.includeFileExtensions) ||
            event.affectsConfiguration(CONFIG_KEYS.detectPawnLanguageByIncludes)
        ) {
            for (const doc of vscode.workspace.textDocuments) {
                if (!isFileBackedLifecycleDocument(doc)) continue;
                ensureConfiguredPawnLanguage(doc);
            }
        }
        if (affectsAnyConfiguration(event, CACHE_RESET_CONFIG_KEYS)) {
            resetCachesAndWarmActiveDocument();
        }
        if (validationDiagnosticsConfigChanged) {
            refreshOpenPawnDiagnosticsForSettingsChange('configDiagnosticsChanged');
        }
        if (
            event.affectsConfiguration(CONFIG_KEYS.fileExtensions) ||
            event.affectsConfiguration(CONFIG_KEYS.globalIncludePaths) ||
            event.affectsConfiguration(CONFIG_KEYS.projectLocalIncludePaths) ||
            event.affectsConfiguration(CONFIG_KEYS.includeFileExtensions) ||
            event.affectsConfiguration(CONFIG_KEYS.externalIncludeWatchMode)
        ) {
            ensureIncludeGraphWatchers();
        }
        if (event.affectsConfiguration(CONFIG_KEYS.includeDocumentWarmupFileLimit)) {
            includeDocumentModelWarmCache.clear();
            const activeEditor = vscode.window.activeTextEditor;
            if (isLiveLifecyclePawnDocument(activeEditor?.document)) {
                warmIncludedDocumentModels(activeEditor.document);
            }
        }
        if (affectsAnyConfiguration(event, THEME_RECOMMENDATION_CONFIG_KEYS)) {
            const activeEditor = vscode.window.activeTextEditor;
            if (isLiveLifecyclePawnDocument(activeEditor?.document)) {
                themeRecommendationFeature.prompt(activeEditor);
            }
        }
        if (event.affectsConfiguration(CONFIG_KEYS.liveValidationMode)) {
            if (getLiveValidationMode() === 'off') {
                clearPendingLiveDiagnostics();
            } else {
                for (const doc of vscode.workspace.textDocuments) {
                    if (!isLiveLifecyclePawnDocument(doc)) continue;
                    scheduleLiveValidation(liveValidationCollection, doc, { full: true, delayMs: 120, reason: 'configModeChanged' });
                }
            }
        }
        if (event.affectsConfiguration(CONFIG_KEYS.liveValidationScanOnOpen)) {
            const activeDoc = vscode.window.activeTextEditor?.document || null;
            if (shouldRunLiveValidationScanOnOpen() && isLiveLifecyclePawnDocument(activeDoc)) {
                scheduleLiveValidation(liveValidationCollection, activeDoc, {
                    full: true,
                    allowWhenModeOff: true,
                    delayMs: 120,
                    reason: 'configOpenScanEnabled'
                });
            }
        }
    }

    const handleProgrammaticIncludePathsChanged = () => {
        resetCachesAndWarmActiveDocument();
        refreshOpenPawnDiagnosticsForSettingsChange('programmaticIncludePathsChanged');
        ensureIncludeGraphWatchers();
    };

    function register() {
        logLifecycle(() =>
            `register mode=${getLiveValidationMode()} scanOnOpen=${shouldRunLiveValidationScanOnOpen() ? 1 : 0}`
        );
        const subscriptions = [
            vscode.workspace.onDidOpenTextDocument(handleDidOpenTextDocument),
            vscode.workspace.onDidChangeTextDocument(handleDidChangeTextDocument),
            vscode.workspace.onDidSaveTextDocument(handleDidSaveTextDocument),
            vscode.workspace.onDidCloseTextDocument(handleDidCloseTextDocument),
            vscode.window.onDidChangeActiveTextEditor(handleDidChangeActiveTextEditor),
            ...(typeof vscode.window.onDidChangeTextEditorSelection === 'function'
                ? [vscode.window.onDidChangeTextEditorSelection(handleDidChangeTextEditorSelection)]
                : []),
            ...(typeof vscode.window.onDidChangeVisibleTextEditors === 'function'
                ? [vscode.window.onDidChangeVisibleTextEditors(handleDidChangeVisibleTextEditors)]
                : []),
            vscode.workspace.onDidChangeConfiguration(handleDidChangeConfiguration),
            ...(programmaticIncludePathsService?.onDidChangeIncludePaths
                ? [programmaticIncludePathsService.onDidChangeIncludePaths(handleProgrammaticIncludePathsChanged)]
                : [])
        ];

        context.subscriptions.push(...subscriptions);
        context.subscriptions.push({ dispose: disposeLifecycleResources });
    }

    function disposeLifecycleResources() {
        if (startupWarmupTimer) {
            clearTimeout(startupWarmupTimer);
            startupWarmupTimer = null;
        }
        clearIdleVisibleWarmupTimer();
        idleVisibleWarmupState.queue = [];
        idleVisibleWarmupState.queuedKeys.clear();
        pendingLineChangeValidations.clear();
        lastKnownSelectionLineByPath.clear();
        clearIncludeGraphWatcherRefreshTimer();
        disposeRegisteredIncludeGraphWatchers();
        for (const filePath of [...liveValidationTimers.keys()]) {
            clearScheduledLiveValidation(filePath);
        }
        clearAllScheduledWarmups();
    }

    function initialize() {
        const activeDoc = vscode.window.activeTextEditor?.document || null;
        logLifecycle(() =>
            `initialize mode=${getLiveValidationMode()} scanOnOpen=${shouldRunLiveValidationScanOnOpen() ? 1 : 0} ` +
            `active=${activeDoc?.fileName || ''} lang=${activeDoc?.languageId || ''} ` +
            `docs=${(vscode.workspace.textDocuments || []).length} visible=${(vscode.window.visibleTextEditors || []).length}`
        );
        const startupDocumentKeys = new Set();
        const queueStartupDocument = doc => {
            if (!isFileBackedLifecycleDocument(doc)) return;
            const key = normalizeLifecyclePath(doc?.fileName || '');
            if (!key || startupDocumentKeys.has(key)) return;
            startupDocumentKeys.add(key);
            ensureAndHandleVisibleOrActivePawnDocument(doc, 120);
        };
        for (const doc of vscode.workspace.textDocuments) {
            queueStartupDocument(doc);
        }
        for (const editor of vscode.window.visibleTextEditors || []) {
            queueStartupDocument(editor?.document || null);
        }
        if (startupWarmupTimer) clearTimeout(startupWarmupTimer);
        startupWarmupTimer = unrefTimer(setTimeout(() => {
            startupWarmupTimer = null;
            try {
                ensureIncludeGraphWatchers();
            } catch {
                // Ignore include-source warmup failures so startup stays resilient.
            }
        }, 40));
        clearPersistentIncludeDeclCacheIfDisabled();
        resetCachesAndWarmActiveDocument();
        scheduleVisibleDocumentWarmups();
        queueStartupDocument(vscode.window.activeTextEditor?.document || null);
        themeRecommendationFeature.prompt(vscode.window.activeTextEditor || null);
    }

    return {
        register,
        initialize,
        handleDidOpenTextDocument,
        handleDidChangeTextDocument,
        handleDidSaveTextDocument,
        handleDidCloseTextDocument,
        handleDidChangeTextEditorSelection,
        handleDidChangeActiveTextEditor,
        handleDidChangeVisibleTextEditors,
        handleDidChangeConfiguration,
        dispose: disposeLifecycleResources
    };
}

module.exports = { createEditorLifecycleFeature };
