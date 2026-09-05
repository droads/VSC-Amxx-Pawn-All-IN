const {
    createCoreSyntaxPrelude,
    createBaseSyntaxRuntime
} = require('./core-wiring/base-syntax');
const { createDeclarationSupportRuntime } = require('./core-wiring/declaration-support');
const { createAnalysisRuntime } = require('./core-wiring/analysis');
const { createDocumentSystemRuntime } = require('./core-wiring/document-system');
const { createPreprocessorRuntime } = require('./core-wiring/preprocessor');
const { createDocumentStateRuntime } = require('./core-wiring/document-state');
const { createCoreRuntimeBundle } = require('./core-wiring/runtime-bundle');

function buildCoreActivationRuntime(deps) {
    const {
        vscode,
        fs,
        path,
        context,
        t,
        settingsService,
        programmaticIncludePathsService,
        state,
        liveValidationOutputChannel = null
    } = deps;
    const {
        includeFileDecls,
        projectIncludeSourceCache,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        documentWarmupTimers,
        documentContextCache,
        sharedDocumentContextCache,
        documentContextVersionHistory,
        documentEditImpactHistory,
        documentContextFileLru,
        declNameBucketCache,
        funcArgsParseCache,
        liveValidationFullResultCache,
        includeDocumentModelWarmCache,
        includeFileTextCache,
        fileSnapshotCache,
        commentAnalysisCache,
        ctrlCharStateCache,
        resolvedIncludePathCache,
        searchPathCache,
        dependencyFreshnessState
    } = state;
    const {
        refresh: refreshExtensionSettings,
        getIncludeFileExtensions,
        getDocumentContextCacheFileLimit,
        getIncludeDocumentWarmupFileLimit,
        getPersistentIncludeDeclarationCacheMaxBytes,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths
    } = settingsService;
    const getProgrammaticIncludePaths = () => (
        typeof programmaticIncludePathsService?.getProgrammaticIncludePaths === 'function'
            ? (programmaticIncludePathsService.getProgrammaticIncludePaths() || [])
            : []
    );

    const syntaxPrelude = createCoreSyntaxPrelude({ t });
    const {
        FORBIDDEN,
        BUILTIN_DECLS,
        VAR_MODS,
        OPERATOR_SYMBOLS,
        MOD_RE,
        TAG_RE,
        NAME_RE,
        normalizeFsPath,
        isSameFilePath
    } = syntaxPrelude;
    let readPersistentIncludePreprocessedState = null;
    let writePersistentIncludePreprocessedState = null;
    const documentStateRuntime = createDocumentStateRuntime({
        vscode,
        fs,
        normalizeFsPath,
        documentContextFileLru,
        includeDocumentModelWarmCache,
        includeFileTextCache,
        dependencyFreshnessState,
        includeFileDecls,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        sharedDocumentContextCache,
        documentContextCache,
        documentContextVersionHistory,
        funcArgsParseCache,
        liveValidationFullResultCache,
        getDocumentContextCacheFileLimit
    });
    const {
        getDefineStateKey,
        touchDocumentContextCacheFile,
        pruneDocumentContextCache,
        getFileStamp,
        readNormalizedFileContent,
        clearIncludeFileTextCacheForFile,
        invalidateFileStamp,
        isSameFileStamp,
        touchWarmedIncludeDocument,
        buildDependencyStampMap,
        bumpDependencyFreshnessVersion,
        getDependencyFreshnessVersion,
        areDependencyStampsFresh,
        getIncludeDeclCacheKey,
        getActiveIncludeDeclsCacheKey,
        getSharedDocumentContextCacheKey,
        getDocumentContextCacheKey,
        getLiveValidationFullCacheKey,
        getFuncArgsParseCacheKey,
        trackVersionedDocumentCacheVersion,
        clearIncludeDeclCacheForFile,
        clearFileDeclParseCacheForFile,
        clearActiveIncludeDeclsCacheForFile,
        clearDocumentContextCacheForFile
    } = documentStateRuntime;

    let getSearchPaths = null;
    let getNestedSearchPaths = null;
    let resolveInclude = null;
    let getIncludeCompletionEntries = null;
    let parseForInit = null;
    let parseEnumBlock = null;
    let getPotentialDeclarationStartLineKind = null;
    let isExplicitDeclarationStartLine = null;
    let parseDeclLine = null;
    let parseDimsParts = null;
    let parseDimSpec = null;
    let evaluatePawnNumericExpr = null;
    let collectDefineDeclarationText = null;
    let collectActiveDefineDecls = null;
    let filterEnumEvalOuterDecls = null;
    let parseFileDecls = null;
    let preprocessPawnContent = null;
    let parsePreprocessorDirectiveLine = null;
    let parsePreprocessorSingleIdentifierPayload = null;
    let parsePreprocessorDefineDirective = null;
    let parseEnumHeaderSpec = null;
    let applyEnumStep = null;
    let getIncludePreprocessedStateKey = null;

    const baseSyntaxRuntime = createBaseSyntaxRuntime({
        vscode,
        normalizeFsPath,
        getSearchPaths: (...args) => getSearchPaths(...args),
        getNestedSearchPaths: (...args) => getNestedSearchPaths
            ? getNestedSearchPaths(...args)
            : getSearchPaths(args[0]),
        resolveInclude: (...args) => resolveInclude(...args),
        OPERATOR_SYMBOLS,
        commentAnalysisCache,
        ctrlCharStateCache,
        fileSnapshotCache,
        readNormalizedFileContent
    });
    const {
        getActiveCtrlChar,
        getCtrlCharStateForContent,
        withCtrlCharForContent,
        createCtrlCharResolver,
        isEscapedQuote,
        getIncludeNameFromLine,
        isPawnDocument,
        getDocumentTextAndResolver,
        stripLineComment,
        stripCommentsFromLines,
        netParenDepth,
        extractParenContent,
        splitTopLevel,
        splitTopLevelWithRanges,
        unwrapOuterParens,
        stripRootTagCasts,
        parseIndexedAccessExpression,
        parseTopLevelTernaryExpression,
        parseBraceArrayLiteralExpression,
        looksLikePawnExpressionFragment,
        extractDocs,
        parseDims,
        parseValueAndRemainder,
        isLinePositionInsideCommentOrString,
        getLookupTokenAtPosition,
        computeLineDepths,
        getFileSnapshot,
        clearFileSnapshotCacheForFile,
        measurePawnStringLiteral,
        collectRationalLiteralIssues,
        isVariadicParam,
        getLabelDeclarationIssues,
        parseLabelDeclaration,
        collectGotoReferences,
        parseFunctionStateSpecTail,
        parseFunctionStateSpecFromHeaderText,
        parseStateStatement,
        collectFunctionStateIssues,
        areStatefulFunctionRedeclarationsAllowed,
        getStateStatementIssues,
        escapeRegExp,
        normalizeExtensionList,
        normalizeLiveValidationIssueMode,
        areLiveValidationWarningsEnabled,
        getDocumentFingerprint,
        isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar,
        isPawnIdentifierBoundaryChar,
        buildCommentAnalysis,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis
    } = baseSyntaxRuntime;
    refreshExtensionSettings();

    const declarationSupportRuntime = createDeclarationSupportRuntime({
        t,
        declNameBucketCache,
        BUILTIN_DECLS,
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment,
        netParenDepth,
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts: (...args) => parseDimsParts(...args),
        parseDimSpec: (...args) => parseDimSpec(...args),
        evaluatePawnNumericExpr: (...args) => evaluatePawnNumericExpr(...args),
        parseForInit: (...args) => parseForInit(...args),
        parseDeclLine: (...args) => parseDeclLine(...args)
    });
    const {
        findDepthScopeEndLine,
        computeFunctionRangeMaps,
        findStatementScopeEndLine,
        findForScopeEndLine,
        parseSingleStatementBodyDecls,
        collectDeclarationText,
        collectForHeaderText,
        extractEnumSymbolName,
        formatResolvedEnumValueDisplay,
        formatAutoEnumValueDisplay,
        getEnumDeclsForVariableDims,
        buildEnumMemberLine,
        buildSig,
        isFunctionLikeDefineDecl,
        isObjectLikeDefineDecl,
        isFunctionLikeDecl,
        getDeclNameBuckets,
        findDeclByNameCached,
        buildDocumentDeclLookup,
        isKnownFunctionName,
        hasIncludeFunctionTwin,
        getDeclMatchKey,
        finalizeDeclMatches,
        collectWordDeclMatches,
        findFirstNavigableDecl
    } = declarationSupportRuntime;
    const preprocessorRuntime = createPreprocessorRuntime({
        evaluatePawnNumericExpr: (...args) => evaluatePawnNumericExpr(...args),
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths: (...args) => getSearchPaths(...args),
        getNestedSearchPaths: (...args) => getNestedSearchPaths
            ? getNestedSearchPaths(...args)
            : getSearchPaths(args[0]),
        resolveInclude: (...args) => resolveInclude(...args),
        getIncludeNameFromLine,
        collectDeclarationText,
        stripLineComment,
        splitTopLevel,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        getCtrlCharStateForContent,
        readCachedIncludePreprocessedState: (...args) => readPersistentIncludePreprocessedState
            ? readPersistentIncludePreprocessedState(...args)
            : null,
        writeCachedIncludePreprocessedState: (...args) => {
            if (writePersistentIncludePreprocessedState) {
                writePersistentIncludePreprocessedState(...args);
            }
        }
    });
    ({
        getIncludePreprocessedStateKey,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        preprocessPawnContent,
        parseEnumHeaderSpec,
        applyEnumStep
    } = preprocessorRuntime);
    const analysisRuntime = createAnalysisRuntime({
        vscode,
        fs,
        t,
        normalizeFsPath,
        getActiveCtrlChar,
        isEscapedQuote,
        measurePawnStringLiteral,
        splitTopLevel,
        splitTopLevelWithRanges,
        escapeRegExp,
        unwrapOuterParens,
        parseTopLevelTernaryExpression,
        extractEnumSymbolName,
        findDeclByNameCached,
        getDeclNameBuckets,
        isFunctionLikeDecl,
        BUILTIN_DECLS,
        FORBIDDEN,
        TAG_RE,
        MOD_RE,
        NAME_RE,
        VAR_MODS,
        getLookupTokenAtPosition,
        collectDeclarationText,
        collectForHeaderText,
        getCtrlCharStateForContent,
        withCtrlCharForContent,
        stripLineComment,
        stripCommentsFromLines,
        extractParenContent,
        parseEnumHeaderSpec,
        formatAutoEnumValueDisplay,
        formatResolvedEnumValueDisplay,
        applyEnumStep,
        extractDocs,
        parseDims,
        parseValueAndRemainder,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        parseFunctionStateSpecTail,
        computeLineDepths,
        preprocessPawnContent,
        buildDependencyStampMap,
        areDependencyStampsFresh,
        fileDeclParseCache,
        getFileSnapshot,
        isObjectLikeDefineDecl,
        isFunctionLikeDefineDecl,
        parseSingleStatementBodyDecls,
        findStatementScopeEndLine,
        findForScopeEndLine,
        findDepthScopeEndLine,
        getFuncArgsParseCacheKey,
        funcArgsParseCache,
        getDocumentTextAndResolver,
        isKnownFunctionName,
        collectRationalLiteralIssues,
        isVariadicParam,
        isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar
    });
    ({
        parseForInit,
        parseEnumBlock,
        getPotentialDeclarationStartLineKind,
        isExplicitDeclarationStartLine,
        parseDeclLine,
        parseDimsParts,
        parseDimSpec,
        evaluatePawnNumericExpr,
        collectDefineDeclarationText,
        collectActiveDefineDecls,
        filterEnumEvalOuterDecls,
        parseFileDecls
    } = analysisRuntime);

    const documentSystemRuntime = createDocumentSystemRuntime({
        vscode,
        fs,
        path,
        context,
        isPawnDocument,
        normalizeFsPath,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths,
        getProgrammaticIncludePaths,
        getIncludeFileExtensions,
        getIncludeDocumentWarmupFileLimit,
        getPersistentIncludeDeclarationCacheMaxBytes,
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
        parsePreprocessorSingleIdentifierPayload,
        activeIncludeDeclsCache,
        areDependencyStampsFresh,
        buildDependencyStampMap,
        normalizeExtensionList,
        createCtrlCharResolver,
        parseFileDecls,
        filterEnumEvalOuterDecls,
        buildDocumentDeclLookup,
        getDocumentContextCacheKey,
        getSharedDocumentContextCacheKey,
        sharedDocumentContextCache,
        documentContextVersionHistory,
        documentEditImpactHistory,
        documentContextCache,
        trackVersionedDocumentCacheVersion,
        touchDocumentContextCacheFile,
        pruneDocumentContextCache,
        documentWarmupTimers,
        touchWarmedIncludeDocument,
        includeFileTextCache,
        fileSnapshotCache,
        commentAnalysisCache,
        ctrlCharStateCache,
        fileDeclParseCache,
        documentContextFileLru,
        funcArgsParseCache,
        liveValidationFullResultCache,
        includeDocumentModelWarmCache,
        bumpDependencyFreshnessVersion,
        invalidateFileStamp,
        clearFileDeclParseCacheForFile,
        clearActiveIncludeDeclsCacheForFile,
        clearDocumentContextCacheForFile,
        clearIncludeDeclCacheForFile,
        clearIncludeFileTextCacheForFile,
        clearFileSnapshotCacheForFile,
        parsePreprocessorDirectiveLine,
        isExplicitDeclarationStartLine,
        liveValidationOutputChannel
    });
    ({
        getSearchPaths,
        getNestedSearchPaths,
        resolveInclude,
        getIncludeCompletionEntries,
        readPersistentIncludePreprocessedState,
        writePersistentIncludePreprocessedState
    } = documentSystemRuntime);

    return createCoreRuntimeBundle({
        t,
        settingsService,
        programmaticIncludePathsService,
        state,
        syntaxPrelude,
        baseSyntaxRuntime,
        declarationSupportRuntime,
        analysisRuntime,
        preprocessorRuntime,
        documentStateRuntime,
        documentSystemRuntime
    });
}

module.exports = { buildCoreActivationRuntime };
