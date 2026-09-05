const { createEditorLifecycleFeature } = require('../../features/editor-lifecycle');

function buildEditorLifecycleFeature(deps, support, liveValidationRuntime) {
    const {
        vscode,
        fs,
        path,
        context,
        liveValidationCollection,
        liveValidationOutputChannel,
        programmaticIncludePathsService
    } = deps;
    const {
        settingsRuntime,
        stateRuntime,
        cacheRuntime,
        sharedRuntime
    } = deps.coreRuntime;
    const {
        CONFIG_KEYS,
        SETTINGS_REFRESH_CONFIG_KEYS,
        CACHE_RESET_CONFIG_KEYS,
        THEME_RECOMMENDATION_CONFIG_KEYS,
        VALIDATION_DIAGNOSTIC_CONFIG_KEYS,
        affectsAnyConfiguration,
        refreshExtensionSettings,
        normalizeExtensionList,
        getPawnFileExtensions,
        getIncludeFileExtensions,
        getLiveValidationMode,
        getLiveValidationTypingDelayMs,
        shouldRunLiveValidationScanOnOpen,
        getExternalIncludeWatchMode,
        isPersistentIncludeDeclarationCacheEnabled
    } = settingsRuntime;
    const {
        includeDocumentModelWarmCache,
        lastSavedDocumentVersions,
        liveValidationTimers,
        liveValidationFullResultCache,
        workspaceIncludeWatcherState
    } = stateRuntime;
    const {
        summarizeDocumentEditImpact,
        recordDocumentEditImpact,
        invalidateDocumentCaches,
        resetCachesAndWarmActiveDocument,
        bumpDependencyFreshnessVersion
    } = cacheRuntime;
    const {
        normalizeFsPath,
        isPawnDocument,
        getPawnDocumentContext,
        warmWorkspaceIncludeSources,
        markWorkspaceIncludeSourcesDirty,
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache,
        getConfiguredGlobalIncludeSources,
        getProjectRootForFile,
        scheduleWarmDocumentContext,
        clearAllScheduledWarmups,
        warmDocumentContext,
        warmIncludedDocumentModels,
        parsePreprocessorDirectiveLine,
        getLiveValidationFullCacheKey,
        areDependencyStampsFresh,
        getDocumentFingerprint
    } = sharedRuntime;
    const {
        clearScheduledLiveValidation,
        resolveEditedValidationPlan,
        scheduleLiveValidation,
        handleOpenedPawnDocument,
        handleActivePawnEditor
    } = liveValidationRuntime;

    return createEditorLifecycleFeature({
        vscode,
        fs,
        path,
        context,
        liveValidationCollection,
        ensureConfiguredPawnLanguage: support.ensureConfiguredPawnLanguage,
        handleOpenedPawnDocument,
        summarizeDocumentEditImpact,
        recordDocumentEditImpact,
        invalidateDocumentCaches,
        normalizeFsPath,
        isPawnDocument,
        getPawnDocumentContext,
        warmWorkspaceIncludeSources,
        markWorkspaceIncludeSourcesDirty,
        getConfiguredGlobalIncludeSources,
        getProjectRootForFile,
        getExternalIncludeWatchMode,
        normalizeExtensionList,
        getPawnFileExtensions,
        getIncludeFileExtensions,
        scheduleWarmDocumentContext,
        clearAllScheduledWarmups,
        getLiveValidationMode,
        getLiveValidationTypingDelayMs,
        shouldRunLiveValidationScanOnOpen,
        scheduleLiveValidation,
        resolveEditedValidationPlan,
        lastSavedDocumentVersions,
        getLiveValidationFullCacheKey,
        liveValidationFullResultCache,
        areDependencyStampsFresh,
        warmDocumentContext,
        warmIncludedDocumentModels,
        clearScheduledLiveValidation,
        handleActivePawnEditor,
        affectsAnyConfiguration,
        SETTINGS_REFRESH_CONFIG_KEYS,
        refreshExtensionSettings,
        CONFIG_KEYS,
        CACHE_RESET_CONFIG_KEYS,
        VALIDATION_DIAGNOSTIC_CONFIG_KEYS,
        resetCachesAndWarmActiveDocument,
        isPersistentIncludeDeclarationCacheEnabled,
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache,
        includeDocumentModelWarmCache,
        workspaceIncludeWatcherState,
        bumpDependencyFreshnessVersion,
        THEME_RECOMMENDATION_CONFIG_KEYS,
        themeRecommendationFeature: support.themeRecommendationFeature,
        liveValidationTimers,
        getDocumentFingerprint,
        parsePreprocessorDirectiveLine,
        liveValidationOutputChannel,
        programmaticIncludePathsService
    });
}

module.exports = { buildEditorLifecycleFeature };
