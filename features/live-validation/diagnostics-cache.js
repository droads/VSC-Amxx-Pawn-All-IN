const {
    getDefineStateSignature,
    getIncludeEntriesSignatureHash,
    getSortedTuplesSignatureHash
} = require('../../core/utils/signature');
const { createUtilityCore } = require('../../core/utils/runtime');
const { isDebugOutputChannelEnabled } = require('../../core/utils/debug-logger');
const { makeLiveValidationDiagnosticKey } = require('./diagnostic-key');
const {
    getDiagnosticLineSpan,
    getDiagnosticStartLine
} = require('./diagnostic-line-filter');
const {
    LIVE_VALIDATION_DIAGNOSTIC_ENGINE_SIGNATURE
} = require('./diagnostic-engine-signature');

const EDITED_VALIDATION_RESULT_CACHE_LIMIT = 128;
const DOCUMENT_DIAGNOSTICS_CACHE_LIMIT = 64;
const {
    getDocumentFingerprint: defaultGetDocumentFingerprint,
    normalizeLiveValidationIssueMode: defaultNormalizeLiveValidationIssueMode
} = createUtilityCore();

function createLiveDiagnosticsCache(deps) {
    const {
        vscode,
        liveValidationFullResultCache,
        normalizeFsPath,
        isPawnDocument,
        getLiveValidationFullCacheKey,
        getPawnDocumentContext,
        buildDependencyStampMap = () => new Map(),
        getDependencyFreshnessVersion = () => 0,
        areDependencyStampsFresh = () => false,
        settingsService,
        readPersistentLiveDiagnosticsCache = null,
        normalizeLiveValidationIssueMode = defaultNormalizeLiveValidationIssueMode,
        getDocumentFingerprint: computeDocumentFingerprint = defaultGetDocumentFingerprint,
        liveValidationOutputChannel = null
    } = deps;

    const diagnosticsCacheByDocument = new Map();
    const documentFingerprintCache = new WeakMap();
    let editedValidationResultCacheSize = 0;
    const getCachedDocumentFingerprint = document => computeDocumentFingerprint(document, documentFingerprintCache);
    const resolveValidationCacheSettingsSignature = options =>
        typeof options?.settingsSignature === 'string'
            ? options.settingsSignature
            : getValidationCacheSettingsSignature();

    function isCachedDiagnosticEntryFresh(document, cachedValue, expectedFingerprint) {
        const diagnostics = Array.isArray(cachedValue?.diagnostics)
            ? cachedValue.diagnostics
            : null;
        if (!diagnostics) return false;
        if (!cachedValue.documentFingerprint || cachedValue.documentFingerprint !== expectedFingerprint) {
            return false;
        }
        return areDependencyStampsFresh(cachedValue.dependencyStamps);
    }

    function getCurrentWorkspaceDocument(document) {
        const openDocuments = vscode?.workspace?.textDocuments;
        if (!document || !Array.isArray(openDocuments) || !openDocuments.length) {
            return document || null;
        }

        const uriText = document.uri?.toString?.() || '';
        const normalizedFilePath = normalizeFsPath(document.fileName || '');
        for (const candidate of openDocuments) {
            if (candidate === document) return candidate;
            if (uriText && candidate?.uri?.toString?.() === uriText) return candidate;
            if (normalizedFilePath && normalizeFsPath(candidate?.fileName || '') === normalizedFilePath) {
                return candidate;
            }
        }
        return document;
    }

    function isDocumentSnapshotCurrent(document, expectedVersion, expectedFingerprint) {
        if (!document) return false;
        if (Number.isInteger(expectedVersion) && document.version !== expectedVersion) {
            return false;
        }
        const currentDocument = getCurrentWorkspaceDocument(document);
        if (!currentDocument) return false;
        if (Number.isInteger(expectedVersion) && currentDocument.version !== expectedVersion) {
            return false;
        }
        return getCachedDocumentFingerprint(currentDocument) === expectedFingerprint;
    }

    function getIncludeEntriesSignature(includeEntries = []) {
        return getIncludeEntriesSignatureHash(
            includeEntries,
            normalizeFsPath,
            entry => getDefineStateSignature(entry?.defineDecls || [], entry?.defineStateKey || '', {
                fallbackPrefix: ''
            })
        );
    }

    function* getIncludeEntryFilePaths(includeEntries = []) {
        for (const entry of includeEntries || []) {
            yield entry?.filePath || '';
        }
    }

    function buildDocumentDependencyCacheState(document, options = {}) {
        const rootCtx = getPawnDocumentContext(document, undefined, {
            includeDecls: options.includeDecls !== false
        });
        const includeEntries = rootCtx?.includeEntries || [];
        const dependencyStamps = buildDependencyStampMap(getIncludeEntryFilePaths(includeEntries));
        return {
            dependencyStamps,
            includeSignature: getIncludeEntriesSignature(includeEntries),
            dependencySignature: getDependencyStampsSignature(dependencyStamps)
        };
    }

    function getDependencyStampsSignature(dependencyStamps) {
        if (!(dependencyStamps instanceof Map)) return '0:';
        const tuples = [...dependencyStamps.entries()]
            .map(([filePath, stamp]) => [
                normalizeFsPath(filePath),
                stamp?.kind || '',
                stamp?.version ?? '',
                stamp?.mtimeMs ?? '',
                stamp?.size ?? ''
            ]);
        return getSortedTuplesSignatureHash(tuples, { count: dependencyStamps.size });
    }

    function hydratePersistentDiagnosticEntry(document, cachedValue, expectedFingerprint) {
        const diagnostics = Array.isArray(cachedValue?.diagnostics)
            ? cachedValue.diagnostics
            : null;
        if (!diagnostics) return null;
        if (!cachedValue.documentFingerprint || cachedValue.documentFingerprint !== expectedFingerprint) {
            return null;
        }
        const currentDependencyState = buildDocumentDependencyCacheState(document, {
            includeDecls: false
        });
        if (String(cachedValue?.dependencySignature || '') !== currentDependencyState.dependencySignature) {
            return null;
        }
        return {
            ...cachedValue,
            dependencyStamps: currentDependencyState.dependencyStamps,
            dependencySignature: currentDependencyState.dependencySignature
        };
    }

    function getDocumentDiagnosticsCache(documentOrFilePath, options = {}) {
        const filePath = typeof documentOrFilePath === 'string'
            ? documentOrFilePath
            : documentOrFilePath?.fileName || '';
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return null;
        let cache = diagnosticsCacheByDocument.get(normalized) || null;
        if (!cache && options.create !== false) {
            cache = {
                full: null,
                edited: new Map(),
                published: null
            };
            diagnosticsCacheByDocument.set(normalized, cache);
        } else if (cache) {
            diagnosticsCacheByDocument.delete(normalized);
            diagnosticsCacheByDocument.set(normalized, cache);
        }
        while (diagnosticsCacheByDocument.size > DOCUMENT_DIAGNOSTICS_CACHE_LIMIT) {
            const oldestKey = diagnosticsCacheByDocument.keys().next().value;
            const oldestCache = diagnosticsCacheByDocument.get(oldestKey);
            editedValidationResultCacheSize -= oldestCache?.edited?.size || 0;
            diagnosticsCacheByDocument.delete(oldestKey);
        }
        return cache;
    }

    function pruneEditedDiagnosticsCache() {
        while (editedValidationResultCacheSize > EDITED_VALIDATION_RESULT_CACHE_LIMIT) {
            let pruned = false;
            for (const documentCache of diagnosticsCacheByDocument.values()) {
                if (!documentCache?.edited?.size) continue;
                const oldestEditedKey = documentCache.edited.keys().next().value;
                documentCache.edited.delete(oldestEditedKey);
                editedValidationResultCacheSize--;
                pruned = true;
                break;
            }
            if (!pruned) {
                editedValidationResultCacheSize = 0;
                return;
            }
        }
    }

    function rememberFullResult(document, fullCacheKey, cacheEntry) {
        const documentCache = getDocumentDiagnosticsCache(document);
        if (documentCache) {
            documentCache.full = {
                fullCacheKey,
                cacheEntry
            };
        }
    }

    function forgetFullResult(documentOrFilePath, fullCacheKey = '') {
        const documentCache = getDocumentDiagnosticsCache(documentOrFilePath, { create: false });
        if (!documentCache?.full) return;
        if (!fullCacheKey || documentCache.full.fullCacheKey === fullCacheKey) {
            documentCache.full = null;
        }
    }

    function getCachedPublishedDiagnosticsEntry(document, expectedFingerprint, options = {}) {
        const documentCache = getDocumentDiagnosticsCache(document, { create: false });
        const cachedValue = documentCache?.published || null;
        const settingsSignature = resolveValidationCacheSettingsSignature(options);
        if (!cachedValue) return null;
        if (
            cachedValue.version !== document.version ||
            cachedValue.settingsSignature !== settingsSignature ||
            cachedValue.dependencyFreshnessVersion !== getDependencyFreshnessVersion() ||
            !isCachedDiagnosticEntryFresh(document, cachedValue, expectedFingerprint)
        ) {
            documentCache.published = null;
            return null;
        }
        return cachedValue;
    }

    function shouldAllowPublishedDiagnosticsReuse(reason) {
        return reason === 'openDocument' ||
            reason === 'activeEditorChanged' ||
            reason === 'startup' ||
            reason === 'configOpenScanEnabled' ||
            reason === 'configModeChanged';
    }

    function getCachedFullResultEntry(document, options = {}) {
        const baseFullCacheKey = getLiveValidationFullCacheKey(document.fileName, document.version);
        const settingsSignature = resolveValidationCacheSettingsSignature(options);
        const fullCacheKey = `${baseFullCacheKey}::s:${settingsSignature}`;
        let expectedFingerprint = '';
        const getExpectedFingerprint = () => {
            if (!expectedFingerprint) {
                expectedFingerprint = getCachedDocumentFingerprint(document);
            }
            return expectedFingerprint;
        };
        const documentCache = getDocumentDiagnosticsCache(document, { create: false });
        const memoizedFullValue = documentCache?.full?.fullCacheKey === fullCacheKey
            ? documentCache.full.cacheEntry
            : null;
        if (memoizedFullValue) {
            if (isCachedDiagnosticEntryFresh(document, memoizedFullValue, getExpectedFingerprint())) {
                return {
                    fullCacheKey,
                    diagnostics: memoizedFullValue.diagnostics,
                    cacheEntry: memoizedFullValue,
                    cacheSource: 'full',
                    fresh: true
                };
            }
            documentCache.full = null;
            liveValidationFullResultCache.delete(fullCacheKey);
        }
        const cachedValue = liveValidationFullResultCache.get(fullCacheKey);
        if (cachedValue) {
            if (isCachedDiagnosticEntryFresh(document, cachedValue, getExpectedFingerprint())) {
                rememberFullResult(document, fullCacheKey, cachedValue);
                return {
                    fullCacheKey,
                    diagnostics: cachedValue.diagnostics,
                    cacheEntry: cachedValue,
                    cacheSource: 'full',
                    fresh: true
                };
            }
            liveValidationFullResultCache.delete(fullCacheKey);
            forgetFullResult(document, fullCacheKey);
        }
        if (options.allowPublishedReuse === true) {
            const publishedValue = getCachedPublishedDiagnosticsEntry(document, getExpectedFingerprint(), {
                settingsSignature
            });
            if (publishedValue) {
                return {
                    fullCacheKey,
                    diagnostics: publishedValue.diagnostics,
                    cacheEntry: publishedValue,
                    cacheSource: 'published',
                    fresh: true
                };
            }
        }
        if (
            options.allowPersistentReuse === true &&
            document?.isDirty !== true &&
            typeof readPersistentLiveDiagnosticsCache === 'function'
        ) {
            const persistentValue = readPersistentLiveDiagnosticsCache(document, {
                documentFingerprint: getExpectedFingerprint(),
                settingsSignature
            });
            const hydratedPersistentValue = persistentValue
                ? hydratePersistentDiagnosticEntry(document, persistentValue, getExpectedFingerprint())
                : null;
            if (hydratedPersistentValue) {
                setFullResultCacheEntry(document, fullCacheKey, hydratedPersistentValue);
                return {
                    fullCacheKey,
                    diagnostics: hydratedPersistentValue.diagnostics,
                    cacheEntry: hydratedPersistentValue,
                    cacheSource: 'persistent',
                    fresh: true
                };
            }
        }
        return {
            fullCacheKey,
            diagnostics: null,
            cacheEntry: null,
            cacheSource: '',
            fresh: false
        };
    }

    function buildFullResultCacheEntry(document, diagnostics) {
        const dependencyState = buildDocumentDependencyCacheState(document);
        return {
            diagnostics,
            dependencyStamps: dependencyState.dependencyStamps,
            documentFingerprint: getCachedDocumentFingerprint(document),
            includeSignature: dependencyState.includeSignature,
            dependencySignature: dependencyState.dependencySignature
        };
    }

    function setFullResultCacheEntry(document, fullCacheKey, cacheEntry) {
        if (!fullCacheKey || !cacheEntry) return;
        liveValidationFullResultCache.set(fullCacheKey, cacheEntry);
        rememberFullResult(document, fullCacheKey, cacheEntry);
    }

    function getValidationCacheSettingsSignature() {
        return [
            LIVE_VALIDATION_DIAGNOSTIC_ENGINE_SIGNATURE,
            `stock:${settingsService?.getUnusedStockValidationMode?.() || 'reachable-only'}`,
            `issues:${normalizeLiveValidationIssueMode(settingsService?.getLiveValidationIssueMode?.())}`,
            `include:${settingsService?.getIncludeValidationMode?.() || 'balanced'}`,
            `callback:${settingsService?.getCallbackSignatureMode?.() || 'strict'}`,
            `sourceExt:${(settingsService?.getPawnFileExtensions?.() || []).join(',')}`,
            `includeExt:${(settingsService?.getIncludeFileExtensions?.() || []).join(',')}`,
            `globalPaths:${(settingsService?.getGlobalIncludePaths?.() || []).join('|')}`,
            `projectPaths:${(settingsService?.getProjectLocalIncludePaths?.() || []).join('|')}`,
            `programmaticPaths:${(settingsService?.getProgrammaticIncludePaths?.() || []).join('|')}`,
            `lang:${vscode?.env?.language || ''}`
        ].join('|');
    }

    function getEditedValidationResultCacheKey(document, targetLines = [], focusLines = [], options = {}) {
        const normalized = normalizeFsPath(document?.fileName || '');
        if (!normalized || !Number.isInteger(document?.version)) return '';
        const settingsSignature = resolveValidationCacheSettingsSignature(options);
        return [
            normalized,
            `v${document.version}`,
            `s:${settingsSignature}`,
            `t:${(targetLines || []).join(',')}`,
            `f:${(focusLines || []).join(',')}`
        ].join('|');
    }

    function getCachedEditedResultEntry(document, targetLines = [], focusLines = [], options = {}) {
        const cacheKey = getEditedValidationResultCacheKey(document, targetLines, focusLines, options);
        const documentCache = cacheKey ? getDocumentDiagnosticsCache(document, { create: false }) : null;
        const cachedValue = cacheKey ? documentCache?.edited?.get(cacheKey) : null;
        if (!cachedValue) return { cacheKey, diagnostics: null, fresh: false };
        if (!isCachedDiagnosticEntryFresh(document, cachedValue, getCachedDocumentFingerprint(document))) {
            documentCache.edited.delete(cacheKey);
            editedValidationResultCacheSize--;
            return { cacheKey, diagnostics: null, fresh: false };
        }
        documentCache.edited.delete(cacheKey);
        documentCache.edited.set(cacheKey, cachedValue);
        return {
            cacheKey,
            diagnostics: cachedValue.diagnostics || [],
            fresh: true
        };
    }

    function setEditedResultCacheEntry(document, targetLines = [], focusLines = [], diagnostics = [], options = {}) {
        const cacheKey = getEditedValidationResultCacheKey(document, targetLines, focusLines, options);
        if (!cacheKey) return;
        const documentCache = getDocumentDiagnosticsCache(document);
        if (!documentCache) return;
        if (!documentCache.edited.has(cacheKey)) {
            editedValidationResultCacheSize++;
        }
        documentCache.edited.delete(cacheKey);
        documentCache.edited.set(cacheKey, buildFullResultCacheEntry(document, diagnostics));
        pruneEditedDiagnosticsCache();
    }

    function recordPublishedDiagnostics(document, diagnostics, cacheEntry = null, options = {}) {
        const normalized = normalizeFsPath(document?.fileName || '');
        if (!normalized || !Number.isInteger(document?.version)) return;
        const entry = cacheEntry || buildFullResultCacheEntry(document, diagnostics);
        if (!entry?.documentFingerprint || !Array.isArray(entry.diagnostics)) return;
        const documentCache = getDocumentDiagnosticsCache(normalized);
        if (!documentCache) return;
        documentCache.published = {
            ...entry,
            version: document.version,
            settingsSignature: resolveValidationCacheSettingsSignature(options),
            dependencyFreshnessVersion: getDependencyFreshnessVersion()
        };
    }

    function deletePublishedDiagnostics(documentOrFilePath) {
        const filePath = typeof documentOrFilePath === 'string'
            ? documentOrFilePath
            : documentOrFilePath?.fileName || '';
        const normalized = normalizeFsPath(filePath);
        const documentCache = normalized
            ? getDocumentDiagnosticsCache(normalized, { create: false })
            : null;
        if (documentCache) documentCache.published = null;
    }

    function getDiagnosticListSignature(diagnostics = []) {
        if (!Array.isArray(diagnostics) || !diagnostics.length) return '0:';
        return diagnostics.map(diagnostic => [
            makeLiveValidationDiagnosticKey(diagnostic),
            diagnostic?.severity ?? '',
            diagnostic?.source || '',
            diagnostic?.code ?? '',
            Array.isArray(diagnostic?.tags) ? diagnostic.tags.join(',') : ''
        ].join('|')).join('\n');
    }

    function setCollectionDiagnosticsIfChanged(liveValidationCollection, document, diagnostics) {
        if (typeof liveValidationCollection?.get === 'function') {
            const currentDiagnostics = liveValidationCollection.get(document.uri);
            if (
                Array.isArray(currentDiagnostics) &&
                getDiagnosticListSignature(currentDiagnostics) === getDiagnosticListSignature(diagnostics)
            ) {
                return false;
            }
        }
        liveValidationCollection.set(document.uri, diagnostics);
        return true;
    }

    function getDiagnosticSeverityName(severity) {
        const severities = vscode?.DiagnosticSeverity || {};
        if (severity === severities.Error) return 'error';
        if (severity === severities.Warning) return 'warning';
        if (Object.prototype.hasOwnProperty.call(severities, 'Information') && severity === severities.Information) return 'info';
        if (Object.prototype.hasOwnProperty.call(severities, 'Hint') && severity === severities.Hint) return 'hint';
        return 'unknown';
    }

    function summarizeDiagnosticLines(diagnostics) {
        const byLine = new Map();
        for (const diagnostic of diagnostics || []) {
            const startLine = getDiagnosticStartLine(diagnostic);
            if (startLine < 0) continue;
            let lineEntry = byLine.get(startLine);
            if (!lineEntry) {
                lineEntry = { total: 0, error: 0, warning: 0, info: 0, hint: 0, unknown: 0 };
                byLine.set(startLine, lineEntry);
            }
            lineEntry.total++;
            lineEntry[getDiagnosticSeverityName(diagnostic?.severity)]++;
        }
        return [...byLine.entries()].sort((left, right) => left[0] - right[0]);
    }

    function formatDiagnosticLineSummary(lineNumber, entry) {
        const parts = [];
        if (entry.error) parts.push(`errors=${entry.error}`);
        if (entry.warning) parts.push(`warnings=${entry.warning}`);
        if (entry.info) parts.push(`info=${entry.info}`);
        if (entry.hint) parts.push(`hints=${entry.hint}`);
        if (entry.unknown) parts.push(`unknown=${entry.unknown}`);
        return `${lineNumber + 1} (${entry.total}${parts.length ? `; ${parts.join(', ')}` : ''})`;
    }

    function logPublishedDiagnostics(document, diagnostics, options = {}) {
        if (!isDebugOutputChannelEnabled(liveValidationOutputChannel)) {
            return;
        }
        if (typeof liveValidationOutputChannel?.appendLine !== 'function') return;
        const lineSummaries = summarizeDiagnosticLines(diagnostics);
        const source = String(options.source || 'publish');
        const reason = String(options.reason || 'unspecified');
        const issueMode = normalizeLiveValidationIssueMode(settingsService?.getLiveValidationIssueMode?.());
        const scanStats = options.scanStats || null;
        const statsText = scanStats
            ? [
                `usage=${scanStats.usageDiagnostics ?? 0}`,
                `usageKept=${scanStats.usageDiagnosticsKept ?? 0}`,
                `warnings=${scanStats.warningsEnabled === false ? 'off' : 'on'}`
            ].join(' ')
            : '';
        const fileName = document?.fileName || document?.uri?.toString?.() || '<unknown>';
        const total = Array.isArray(diagnostics) ? diagnostics.length : 0;
        const linesText = lineSummaries.length
            ? lineSummaries.map(([line, entry]) => formatDiagnosticLineSummary(line, entry)).join(', ')
            : 'none';
        liveValidationOutputChannel.appendLine(
            `[live diagnostics] ${source} reason=${reason} issues=${issueMode} count=${total}${statsText ? ` ${statsText}` : ''} file=${fileName}`
        );
        liveValidationOutputChannel.appendLine(`[live diagnostics] lines: ${linesText}`);
    }

    function setLiveValidationDiagnostics(liveValidationCollection, document, diagnostics, options = {}) {
        if (!isPawnDocument(document)) return;
        const changed = setCollectionDiagnosticsIfChanged(liveValidationCollection, document, diagnostics);
        recordPublishedDiagnostics(document, diagnostics, options.cacheEntry || null, options);
        if (changed || options.scanStats) {
            logPublishedDiagnostics(document, diagnostics, options);
        }
    }

    function updateLiveValidationDiagnostics(liveValidationCollection, document, lines, diagnostics, options = {}) {
        if (!isPawnDocument(document)) return;
        const current = liveValidationCollection.get(document.uri) || [];
        const targetLines = new Set(lines || []);
        const replaceDiagnosticCodes = new Set(options.replaceDiagnosticCodes || []);
        const retained = current.filter(diagnostic => {
            if (replaceDiagnosticCodes.has(diagnostic?.code)) return false;
            const span = getDiagnosticLineSpan(diagnostic);
            if (!span) return true;
            for (const line of targetLines) {
                if (line >= span.startLine && line <= span.endLine) return false;
            }
            return true;
        });
        const mergedDiagnostics = [];
        const seen = new Set();
        for (const diagnostic of [...retained, ...diagnostics]) {
            const key = makeLiveValidationDiagnosticKey(diagnostic);
            if (seen.has(key)) continue;
            seen.add(key);
            mergedDiagnostics.push(diagnostic);
        }
        const changed = setCollectionDiagnosticsIfChanged(liveValidationCollection, document, mergedDiagnostics);
        recordPublishedDiagnostics(document, mergedDiagnostics, null, options);
        if (changed) {
            logPublishedDiagnostics(document, mergedDiagnostics, options);
        }
        return mergedDiagnostics;
    }

    return {
        getCachedDocumentFingerprint,
        isDocumentSnapshotCurrent,
        shouldAllowPublishedDiagnosticsReuse,
        getCachedFullResultEntry,
        buildFullResultCacheEntry,
        setFullResultCacheEntry,
        getValidationCacheSettingsSignature,
        getCachedEditedResultEntry,
        setEditedResultCacheEntry,
        deletePublishedDiagnostics,
        setLiveValidationDiagnostics,
        updateLiveValidationDiagnostics
    };
}

module.exports = {
    LIVE_VALIDATION_DIAGNOSTIC_ENGINE_SIGNATURE,
    createLiveDiagnosticsCache
};
