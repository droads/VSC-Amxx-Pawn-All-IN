const { createStructuralRangeHelpers } = require('./structural-ranges');
const { getStructuralScanBounds } = require('./structural-scan-bounds');
const { createControlContextTracker } = require('../../core/syntax/control-context');
const { getTypeAnalysisSourceDecls } = require('../../core/validation/type-analysis-cache');
const {
    findPreviousNonEmptyLine,
    getCompilerMultilineStatementRange,
    isDoWhileClosingLine: isDoWhileClosingLineCore
} = require('../../core/syntax/control-lines');
const { computeLineStartGroupContextFlags } = require('../../core/syntax/group-context');
const {
    PAWN_IDENTIFIER_SOURCE,
    containsPawnIdentifierStartChar
} = require('../../core/syntax/identifiers');
const {
    resolveLineStartOffset,
    splitPawnLines
} = require('../../core/syntax/lines');
const {
    buildInactivePreprocessorLineFlags,
    isPreprocessorDirectiveLine
} = require('../../core/syntax/preprocessor-lines');

const PAWN_IDENTIFIER_WORD_RE = new RegExp(`\\b${PAWN_IDENTIFIER_SOURCE}\\b`, 'g');
const PAWN_IDENTIFIER_AT_START_RE = new RegExp(`^(${PAWN_IDENTIFIER_SOURCE})\\b`);

function createStructuralDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        classifyPawnStatementLine,
        countStructuralBraces,
        countTopLevelSemicolonStatements,
        collectDeclarationText,
        createHoverTypeAnalysisCache,
        createLiveValidationDiagnostic,
        createOffsetRange,
        evaluatePawnNumericExpr,
        explainArrayShapeDiagnosticIssue,
        findBalancedGroupEnd,
        findPossiblyUnintendedAssignmentInCondition,
        findDuplicateSwitchCaseEntry,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        getConstantControlTestIssue: getConstantControlTestWarningIssue,
        getFunctionBodyRangeByLine,
        getFunctionShouldReturnValueIssue,
        getLiveArrayShapeIssue,
        getStateStatementIssues,
        getNoEffectConstantStatementIssue,
        getStatementHasNoEffectIssue,
        getUnreachableCodeIssue,
        getWarningSeverity,
        hasControlInlinePrefix,
        inferArrayShapeActualType,
        isFunctionHeaderLine,
        isIncludeDocument,
        isKeywordAt,
        isLocalDeclarationStatementStart,
        isPreprocessorDirectiveOrContinuationLine,
        maskStringLiteralContent,
        mayHaveInlineStatementPrefix,
        rememberSwitchCaseEntry,
        resolveSwitchCaseLabelValues,
        shouldIncludeTargetLine,
        skipInlineControlHeader,
        stripLeadingInlineStatementPrefix,
        stripTrailingSemicolon,
        t,
        vscode
    } = deps;

    function collectStructuralLiveDiagnostics(document, rootCtx, docLength, targetLineNumbers = null, scanServices = null) {
        const diagnostics = [];
        const includeDocument = isIncludeDocument(document);
        const targetLines = targetLineNumbers instanceof Set ? targetLineNumbers : null;
        const warningsEnabled = areWarningDiagnosticsEnabled();
        const rawLines = rootCtx.rawLines || splitPawnLines(rootCtx.text);
        const strippedLines = rootCtx.strippedLines || rawLines;
        let fallbackInactivePreprocessorLineFlags = null;
        const getInactivePreprocessorLineFlags = () => {
            if (fallbackInactivePreprocessorLineFlags !== null) {
                return fallbackInactivePreprocessorLineFlags;
            }
            fallbackInactivePreprocessorLineFlags = buildInactivePreprocessorLineFlags(
                rawLines,
                rootCtx.preprocessedState?.rawLines,
                rawLines.length,
                {
                    isPreprocessorDirectiveLineNumber: line =>
                        typeof rootCtx.lineIndex?.isPreprocessorDirectiveLine === 'function' &&
                        rootCtx.lineIndex.isPreprocessorDirectiveLine(line)
                }
            ) || false;
            return fallbackInactivePreprocessorLineFlags;
        };
        const isInactivePreprocessorLine = lineNumber => {
            if (!Number.isInteger(lineNumber) || lineNumber < 0) return false;
            if (typeof scanServices?.isInactivePreprocessorLine === 'function') {
                return !!scanServices.isInactivePreprocessorLine(lineNumber);
            }
            const flags = scanServices?.inactivePreprocessorLineFlags || getInactivePreprocessorLineFlags();
            return !!(flags && flags[lineNumber]);
        };
        const depths = rootCtx.parsedDecls.depths || [];
        const lineStartOffsets = rootCtx.lineStartOffsets || null;
        const getLineStartOffset = lineNumber =>
            resolveLineStartOffset(
                lineStartOffsets,
                lineNumber,
                () => document.offsetAt(new vscode.Position(lineNumber, 0))
            );
        const structuralCandidateLineNumbers = rootCtx.lineIndex.structuralDiagnosticCandidateLines || [];
        const unreachableCandidateLineNumbers =
            scanServices?.unreachableCandidateLineNumbers ||
            rootCtx.lineIndex.generalDiagnosticCandidateLines ||
            [];
        const functionBodyRangeByLine = getFunctionBodyRangeByLine(rootCtx);
        const functionHeaderEndLineFlags = (() => {
            const flags = new Uint8Array(rawLines.length);
            for (const func of rootCtx.parsedDecls.functions || []) {
                const endLine = func.headerEndLine ?? func.startLine;
                if (Number.isInteger(endLine) && endLine >= 0) {
                    flags[endLine] = 1;
                }
            }
            return flags;
        })();
        const scanBounds = getStructuralScanBounds({
            targetLines,
            strippedLines,
            functions: rootCtx.parsedDecls.functions || [],
            functionBodyRangeByLine
        });
        const createNameRangeOnLine = (lineNumber, name) => {
            const lineText = rawLines[lineNumber] || '';
            const lineStartOffset = getLineStartOffset(lineNumber);
            const nameText = String(name || '');
            const nameIndex = nameText ? lineText.indexOf(nameText) : -1;
            return nameIndex >= 0
                ? createOffsetRange(
                    document,
                    lineStartOffset + nameIndex,
                    lineStartOffset + nameIndex + Math.max(1, nameText.length),
                    docLength
                )
                : createOffsetRange(
                    document,
                    lineStartOffset,
                    lineStartOffset + Math.max(1, lineText.length),
                    docLength
                );
        };
        const collectDuplicateEnumNameDiagnostics = () => {
            const seenEnumNames = new Map();
            for (const decl of rootCtx.parsedDecls.globals || []) {
                if (decl?.type !== 'enum' || !decl.name || decl.name === '_') continue;
                const lineNumber = decl.lineNumber ?? -1;
                if (!Number.isInteger(lineNumber) || lineNumber < 0) continue;
                if (seenEnumNames.has(decl.name)) {
                    if (shouldIncludeTargetLine(targetLines, lineNumber)) {
                        diagnostics.push(createLiveValidationDiagnostic(
                            createNameRangeOnLine(lineNumber, decl.name),
                            t('validation.symbolAlreadyDefined', { name: decl.name })
                        ));
                    }
                    continue;
                }
                seenEnumNames.set(decl.name, decl);
            }
        };
        collectDuplicateEnumNameDiagnostics();
        const returnStyleByFunction = new Map();
        const terminalStateByFunction = new Map();
        const functionLikeDefineDeclsByName = new Map();
        for (const decl of rootCtx?.preprocessedState?.defineDecls || []) {
            if (decl?.type === 'define' && decl.macroStyle === 'paren' && decl.name) {
                functionLikeDefineDeclsByName.set(decl.name, decl);
            }
        }
        const macroControlTypeCache = new Map();
        const getReturnLineContext = lineNumber =>
            scanServices?.getLineContext?.(lineNumber) || rootCtx;
        const getReturnAnalysisCache = (lineNumber, lineCtx) =>
            scanServices?.getAnalysisCacheForLine?.(lineNumber, lineCtx) ||
            createHoverTypeAnalysisCache([], lineCtx?.lookup || rootCtx.lookup);
        const getLineTypeAnalysisInfo = lineNumber => {
            const lineCtx = getReturnLineContext(lineNumber);
            const analysisCache = getReturnAnalysisCache(lineNumber, lineCtx);
            return {
                decls: getTypeAnalysisSourceDecls(lineCtx, analysisCache, rootCtx),
                analysisCache
            };
        };
        const getCheapScalarReturnTypeInfo = valueText => {
            const source = String(valueText || '').trim();
            if (!source) return null;
            const scalarLiteralSource = source
                .replace(/^\(+\s*/, '')
                .replace(/\s*\)+$/, '')
                .trim();
            if (
                /^(?:[A-Za-z_@]\w*:\s*)?(?:true|false|cellmin|cellmax)$/i.test(scalarLiteralSource) ||
                /^(?:[A-Za-z_@]\w*:\s*)?(?:[-+~!]\s*)?(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)$/.test(scalarLiteralSource) ||
                /^'(?:\\.|[^'\\])'$/.test(scalarLiteralSource)
            ) {
                return {
                    type: { tag: '', dims: '' },
                    decls: [],
                    analysisCache: null,
                    escapeChar: ''
                };
            }
            return null;
        };
        const getReturnValueTypeInfo = (lineNumber, valueText) => {
            const cheapScalar = getCheapScalarReturnTypeInfo(valueText);
            if (cheapScalar) return cheapScalar;
            const returnCtx = getReturnLineContext(lineNumber);
            const returnAnalysisCache = getReturnAnalysisCache(lineNumber, returnCtx);
            const returnDecls = getTypeAnalysisSourceDecls(returnCtx, returnAnalysisCache, rootCtx);
            const { type: returnType } = inferArrayShapeActualType(valueText, returnDecls, returnAnalysisCache);
            return {
                type: returnType || { tag: '', dims: '' },
                decls: returnDecls,
                analysisCache: returnAnalysisCache,
                escapeChar: returnCtx?.resolver?.ctrlCharAtLine?.(lineNumber) || ''
            };
        };
        const getEffectiveReturnInfo = (lineNumber, currentDepth, statement) => {
            if (!statement?.returnInfo) return null;
            const range = getCompilerMultilineRangeForLine(lineNumber, currentDepth);
            if (!range || range.startLine !== lineNumber || !range.text) return statement.returnInfo;
            const returnMatch = range.text.match(/\breturn\b/);
            if (!returnMatch) return statement.returnInfo;
            return {
                ...statement.returnInfo,
                valueText: stripTrailingSemicolon(range.text.slice(returnMatch.index + 'return'.length))
            };
        };

        const getPreviousNonEmptyLine = startLine =>
            findPreviousNonEmptyLine(strippedLines, startLine, {
                getTrimmedLine: getTrimmedStructuralLine
            });
        const isDoWhileClosingLine = lineNumber =>
            isDoWhileClosingLineCore(strippedLines, depths, lineNumber, {
                getLineText: getStructuralLine,
                getTrimmedLine: getTrimmedStructuralLine
            });
        const isTopLevelBraceStartWithoutHeader = lineNumber => {
            const trimmedLine = getTrimmedStructuralLine(lineNumber);
            if (!/^\{/.test(trimmedLine)) return false;
            const previousNonEmptyLine = getPreviousNonEmptyLine(lineNumber - 1);
            if (previousNonEmptyLine < 0) return true;
            const previousTrimmedLine = getTrimmedStructuralLine(previousNonEmptyLine);
            if (!previousTrimmedLine) return true;
            if (functionHeaderEndLineFlags[previousNonEmptyLine]) return false;
            const previousStatement = classifyPawnStatementLine(previousTrimmedLine);
            if (
                previousStatement.firstKeyword === 'if' ||
                previousStatement.firstKeyword === 'for' ||
                previousStatement.firstKeyword === 'while' ||
                previousStatement.firstKeyword === 'switch' ||
                previousStatement.firstKeyword === 'do' ||
                previousStatement.firstKeyword === 'else' ||
                previousStatement.firstKeyword === 'enum' ||
                previousStatement.firstKeyword === 'new' ||
                previousStatement.firstKeyword === 'static' ||
                previousStatement.firstKeyword === 'const'
            ) {
                return false;
            }
            if (/[=,]\s*$/.test(previousTrimmedLine)) return false;
            if (/^[A-Za-z_@]\w*\s*:\s*$/.test(previousTrimmedLine)) return false;
            return true;
        };
        const controlContextTracker = createControlContextTracker({
            strippedLines,
            depths,
            classifyPawnStatementLine,
            countStructuralBraces,
            findFirstNonWhitespaceIndex,
            findKeywordOccurrences,
            skipInlineControlHeader,
            isDoWhileClosingLine
        });
        const hasInlineContextBefore = controlContextTracker.hasInlineContextBefore;
        const getMacroProvidedControlType = (decl, seen = null) => {
            if (!decl?.name) return '';
            if (macroControlTypeCache.has(decl.name)) return macroControlTypeCache.get(decl.name);
            if (seen?.has(decl.name)) return '';
            const localSeen = seen || new Set();
            localSeen.add(decl.name);
            const expandedStatement = classifyPawnStatementLine(String(decl.value || ''));
            let type = '';
            if ((expandedStatement.controlStarts || []).some(control => control.keyword === 'for')) {
                type = 'for';
            } else if ((expandedStatement.controlStarts || []).some(control => control.keyword === 'while')) {
                type = 'while';
            } else if ((expandedStatement.controlStarts || []).some(control => control.keyword === 'do')) {
                type = 'do';
            } else if ((expandedStatement.controlStarts || []).some(control => control.keyword === 'switch')) {
                type = 'switch';
            }
            if (!type) {
                for (const match of String(decl.value || '').matchAll(PAWN_IDENTIFIER_WORD_RE)) {
                    const nestedDecl = functionLikeDefineDeclsByName.get(match[0]);
                    if (!nestedDecl || nestedDecl === decl) continue;
                    type = getMacroProvidedControlType(nestedDecl, localSeen);
                    if (type) break;
                }
            }
            localSeen.delete(decl.name);
            macroControlTypeCache.set(decl.name, type);
            return type;
        };
        const getMacroProvidedControlContext = source => {
            const text = String(source || '');
            const start = findFirstNonWhitespaceIndex(text, 0);
            if (start >= text.length) return null;
            const match = text.slice(start).match(PAWN_IDENTIFIER_AT_START_RE);
            if (!match) return null;
            const name = match[1];
            const decl = functionLikeDefineDeclsByName.get(name);
            if (!decl) return null;
            let index = start + name.length;
            index = findFirstNonWhitespaceIndex(text, index);
            if (text[index] !== '(') return null;
            const type = getMacroProvidedControlType(decl);
            return type ? { type, start } : null;
        };
        const {
            createFunctionNameRange,
            createKeywordRange,
            createSwitchCaseLabelRange
        } = createStructuralRangeHelpers({
            document,
            docLength,
            rawLines,
            getLineStartOffset,
            createOffsetRange
        });
        const functionBodyDepthByFunction = new Map();
        for (const func of rootCtx.parsedDecls.functions || []) {
            const headerEndLine = func.headerEndLine ?? func.startLine ?? func.lineNumber ?? 0;
            const headerDepth = depths[headerEndLine] ?? depths[func.startLine ?? func.lineNumber ?? 0] ?? 0;
            functionBodyDepthByFunction.set(func, headerDepth + 1);
        }
        const getControlConditionExpression = (source, keywordStart, keyword) => {
            if (keyword !== 'if' && keyword !== 'while') return '';
            const text = String(source || '');
            let index = findFirstNonWhitespaceIndex(text, keywordStart + keyword.length);
            if (text[index] !== '(') return '';
            const closeIndex = findBalancedGroupEnd(text, index, '(', ')');
            return closeIndex > index ? text.slice(index + 1, closeIndex).trim() : '';
        };
        const getConstantControlTestIssue = (lineNumber, structuralLine, statement) => {
            const keyword = statement.firstKeyword;
            if (keyword !== 'if' && keyword !== 'while') return null;
            if (keyword === 'while' && isDoWhileClosingLine(lineNumber)) return null;
            const expr = getControlConditionExpression(
                structuralLine,
                statement.firstKeywordStart,
                keyword
            );
            if (!expr) return null;
            const lineCtx = getReturnLineContext(lineNumber);
            const analysisCache = getReturnAnalysisCache(lineNumber, lineCtx);
            const decls = getTypeAnalysisSourceDecls(lineCtx, analysisCache, rootCtx);
            const value = evaluatePawnNumericExpr(expr, decls, null, analysisCache);
            if (value == null) return null;
            return getConstantControlTestWarningIssue(value);
        };
        const getConditionAssignmentIssue = (structuralLine, statement) => {
            if (statement.firstKeyword !== 'if' && statement.firstKeyword !== 'while') return null;
            return findPossiblyUnintendedAssignmentInCondition(
                structuralLine,
                statement.firstKeywordStart,
                statement.firstKeyword
            );
        };
        const pushControlContext = controlContextTracker.pushControlContext;
        const stripLeadingCloseBracesText = trimmedLine =>
            String(trimmedLine || '').replace(/^(?:}\s*)+/, '').trimStart();
        const isUnreachableResetLine = trimmedLine => {
            const normalizedLine = stripLeadingCloseBracesText(trimmedLine);
            return /^(?:case\b|default\b|else\b)/.test(normalizedLine) ||
                /^[A-Za-z_@]\w*\s*:\s*$/.test(normalizedLine);
        };
        const isExecutableStatementForUnreachable = trimmedLine => {
            if (!trimmedLine) return false;
            if (/^[{};]+$/.test(trimmedLine)) return false;
            if (isPreprocessorDirectiveLine(trimmedLine)) return false;
            if (isUnreachableResetLine(trimmedLine)) return false;
            return true;
        };
        const updateFunctionTerminalState = (lineNumber, functionBody, trimmedLine, statement) => {
            const func = functionBody?.func || null;
            if (!func || !isExecutableStatementForUnreachable(trimmedLine)) return;
            const currentDepth = depths[lineNumber] ?? 0;
            const isFunctionSingleStatementBody =
                Number.isInteger(func.singleStatementBodyLine) &&
                func.singleStatementBodyLine === lineNumber;
            const baseDepth = isFunctionSingleStatementBody
                ? currentDepth
                : functionBodyDepthByFunction.get(func);
            terminalStateByFunction.set(func, {
                hasFunctionLevelTerminal:
                    currentDepth === baseDepth &&
                    !isSingleStatementControlledBodyLine(lineNumber) &&
                    (statement.firstKeyword === 'return' || statement.firstKeyword === 'goto')
            });
        };
        const getWholeLineTerminalKind = (lineNumber, trimmedLine, currentDepth) => {
            const directKind = getStatementTerminalKindFromText(trimmedLine);
            if (directKind && /;\s*$/.test(String(trimmedLine || ''))) return directKind;
            return getMultilineTerminalKindEndingAt(lineNumber, scanBounds.start, currentDepth);
        };
        const isSingleStatementControlledBodyLine = lineNumber => {
            // A control header that already carries its own non-empty inline body
            // (e.g. `if (cond) return x` written without a trailing semicolon) is a
            // COMPLETE statement; the following line is its sibling, not its
            // controlled body. Mirrors the empty-inline-body check the first branch
            // below already performs.
            const controlHeaderHasInlineBody = (text, keyword, keywordStart) => {
                let kw = keyword, start = keywordStart;
                if (kw === 'else') {
                    const afterElseStart = skipInlineControlHeader(text, start, 'else');
                    const afterElse = afterElseStart >= 0 ? text.slice(afterElseStart).trimStart() : '';
                    if (lineStartsWithKeyword(afterElse, 'if')) {
                        kw = 'if';
                        start = text.indexOf('if', afterElseStart);
                    }
                }
                const bodyStart = skipInlineControlHeader(text, start, kw);
                return bodyStart >= 0 && !!text.slice(bodyStart).trim();
            };
            const previousBodyLine = getPreviousNonEmptyLine(lineNumber - 1);
            if (previousBodyLine >= 0) {
                const previousTrimmed = getTrimmedStructuralLine(previousBodyLine);
                if (
                    previousTrimmed &&
                    !/;\s*$/.test(previousTrimmed) &&
                    !/\{\s*$/.test(previousTrimmed) &&
                    !/^\}/.test(previousTrimmed)
                ) {
                    let previousStatement = classifyPawnStatementLine(previousTrimmed);
                    let keyword = previousStatement.firstKeyword;
                    let keywordStart = previousStatement.firstKeywordStart;
                    if (keyword === 'else') {
                        const afterElseStart = skipInlineControlHeader(previousTrimmed, keywordStart, 'else');
                        const afterElse = afterElseStart >= 0 ? previousTrimmed.slice(afterElseStart).trimStart() : '';
                        if (lineStartsWithKeyword(afterElse, 'if')) {
                            keyword = 'if';
                            keywordStart = previousTrimmed.indexOf('if', afterElseStart);
                        }
                    }
                    if (
                        keyword === 'if' ||
                        keyword === 'for' ||
                        (keyword === 'while' && !isDoWhileClosingLine(previousBodyLine)) ||
                        keyword === 'else' ||
                        keyword === 'do'
                    ) {
                        const bodyStart = skipInlineControlHeader(previousTrimmed, keywordStart, keyword);
                        if (bodyStart >= 0 && !previousTrimmed.slice(bodyStart).trim()) {
                            return true;
                        }
                    }
                }
            }
            let combined = '';
            for (let probeLine = lineNumber - 1, scanned = 0; probeLine >= 0 && scanned < 12; probeLine--, scanned++) {
                const trimmed = getTrimmedStructuralLine(probeLine);
                if (!trimmed) continue;
                combined = combined ? `${trimmed} ${combined}` : trimmed;
                if (/;\s*$/.test(trimmed) || /\{\s*$/.test(trimmed) || /^\}/.test(trimmed)) return false;
                const statement = classifyPawnStatementLine(combined);
                if (
                    statement.firstKeyword === 'if' ||
                    statement.firstKeyword === 'for' ||
                    (statement.firstKeyword === 'while' && !isDoWhileClosingLine(probeLine)) ||
                    statement.firstKeyword === 'else' ||
                    statement.firstKeyword === 'do'
                ) {
                    // A control header with its own inline body is a complete
                    // statement; the tested line is its sibling, not its body.
                    if (controlHeaderHasInlineBody(combined, statement.firstKeyword, statement.firstKeywordStart)) {
                        return false;
                    }
                    return true;
                }
                const previousLine = getPreviousNonEmptyLine(probeLine - 1);
                const previousTrimmed = previousLine >= 0
                    ? getTrimmedStructuralLine(previousLine)
                    : '';
                const startsContinuation = /^(?:&&|\|\||[+\-*/%&|^<>=!?:,])/.test(trimmed);
                const previousContinues = /(?:&&|\|\||[+\-*/%&|^<>=!?:,])\s*$/.test(previousTrimmed) ||
                    /\(\s*$/.test(previousTrimmed);
                if (!startsContinuation && !previousContinues) return false;
            }
            return false;
        };
        const structuralLineCache = [];
        const getStructuralLine = lineNumber => {
            const cached = structuralLineCache[lineNumber];
            if (cached !== undefined) return cached;
            if (isInactivePreprocessorLine(lineNumber)) {
                structuralLineCache[lineNumber] = '';
                return '';
            }
            const escapeChar = rootCtx.resolver?.ctrlCharAtLine?.(lineNumber) || '';
            const line = maskStringLiteralContent(String(strippedLines[lineNumber] || ''), escapeChar);
            structuralLineCache[lineNumber] = line;
            return line;
        };
        let lineStartGroupContextFlags = null;
        const getLineStartGroupContextFlags = () => {
            if (lineStartGroupContextFlags) return lineStartGroupContextFlags;
            lineStartGroupContextFlags = computeLineStartGroupContextFlags(strippedLines, {
                getLineText: getStructuralLine,
                lineIndex: rootCtx.lineIndex
            });
            return lineStartGroupContextFlags;
        };
        const isInsideLineStartGroupContext = lineNumber =>
            !!getLineStartGroupContextFlags()[lineNumber];
        let topLevelDeclarationContinuationLines = null;
        const getTopLevelDeclarationContinuationLines = () => {
            if (topLevelDeclarationContinuationLines) return topLevelDeclarationContinuationLines;
            const lines = new Set();
            const lineCtrlChars = rootCtx.lineCtrlChars || [];
            for (const decl of rootCtx.parsedDecls.globals || []) {
                if (!decl || (decl.type !== 'variable' && decl.type !== 'constant')) continue;
                const declarationLine = decl.lineNumber ?? -1;
                if (declarationLine < 0) continue;
                const parsedNextLine = Number.isInteger(decl.declarationNextLine)
                    ? decl.declarationNextLine
                    : -1;
                const nextLine = parsedNextLine > declarationLine
                    ? parsedNextLine
                    : (collectDeclarationText(rawLines, declarationLine, lineCtrlChars, strippedLines)?.nextLine ?? (declarationLine + 1));
                for (let coveredLine = declarationLine + 1; coveredLine < nextLine; coveredLine++) {
                    lines.add(coveredLine);
                }
            }
            topLevelDeclarationContinuationLines = lines;
            return lines;
        };
        const isTopLevelDeclarationContinuationLine = lineNumber =>
            getTopLevelDeclarationContinuationLines().has(lineNumber);
        const structuralTrimmedLineCache = new Array(strippedLines.length);
        const getTrimmedStructuralLine = lineNumber => {
            if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= strippedLines.length) return '';
            const cached = structuralTrimmedLineCache[lineNumber];
            if (cached !== undefined) return cached;
            const trimmed = String(getStructuralLine(lineNumber) || '').trim();
            structuralTrimmedLineCache[lineNumber] = trimmed;
            return trimmed;
        };
        const isCompilerLaststIgnoredLine = trimmedLine =>
            !trimmedLine ||
            /^[{}]+;?$/.test(trimmedLine) ||
            isPreprocessorDirectiveLine(trimmedLine);
        const getCompilerMultilineRangeForLine = (lineNumber, baseDepth, endLine = scanBounds.end) =>
            getCompilerMultilineStatementRange(strippedLines, lineNumber, {
                startLine: scanBounds.start,
                endLine,
                baseDepth,
                getLineText: getStructuralLine,
                getTrimmedLine: getTrimmedStructuralLine,
                getLineDepth: getCompilerLineEffectiveDepth,
                isIgnoredLine: isCompilerLaststIgnoredLine
            });
        const findNextCompilerStatementLine = (startLine, endLine) => {
            for (let line = Math.max(0, startLine); line <= endLine; line++) {
                const trimmed = getTrimmedStructuralLine(line);
                if (isCompilerLaststIgnoredLine(trimmed)) continue;
                return line;
            }
            return -1;
        };
        const getFunctionBodyRangeForFunction = func => {
            const headerEndLine = func?.headerEndLine ?? func?.startLine ?? func?.lineNumber ?? -1;
            for (let line = Math.max(0, headerEndLine + 1); line < strippedLines.length; line++) {
                const range = functionBodyRangeByLine[line] || null;
                if (range?.func === func) return range;
                if ((depths[line] ?? 0) <= (depths[headerEndLine] ?? 0) && line > headerEndLine + 1) break;
            }
            return null;
        };
        const functionHeaderTextEndsWithSemicolon = func => {
            const startLine = func?.startLine ?? func?.lineNumber ?? -1;
            const endLine = func?.headerEndLine ?? startLine;
            if (startLine < 0 || endLine < startLine) return false;
            let text = '';
            for (let line = startLine; line <= endLine && line < strippedLines.length; line++) {
                text += `${line > startLine ? ' ' : ''}${getTrimmedStructuralLine(line)}`;
            }
            return /;\s*$/.test(text);
        };
        const getFunctionHeaderText = func => {
            const startLine = func?.startLine ?? func?.lineNumber ?? -1;
            const endLine = func?.headerEndLine ?? startLine;
            if (startLine < 0 || endLine < startLine) return '';
            let text = '';
            for (let line = startLine; line <= endLine && line < strippedLines.length; line++) {
                text += `${line > startLine ? ' ' : ''}${getTrimmedStructuralLine(line)}`;
            }
            return text;
        };
        const functionHeaderHasInlineBody = func => {
            const text = getFunctionHeaderText(func);
            const name = String(func?.name || '').trim();
            if (!text || !name) return false;
            const nameIndex = text.indexOf(name);
            if (nameIndex < 0) return false;
            const openIndex = text.indexOf('(', nameIndex + name.length);
            if (openIndex < 0) return false;
            const closeIndex = findBalancedGroupEnd(text, openIndex, '(', ')');
            if (closeIndex < openIndex) return false;
            return text.slice(closeIndex + 1).includes('{');
        };
        const collectMissingFunctionBodyDiagnostics = () => {
            for (const func of rootCtx.parsedDecls.functions || []) {
                const startLine = func?.startLine ?? func?.lineNumber ?? -1;
                if (!shouldIncludeTargetLine(targetLines, startLine)) continue;
                if (func?.type === 'native' || func?.type === 'forward' || func?.type === 'define') continue;
                if (functionHeaderTextEndsWithSemicolon(func)) continue;
                if (functionHeaderHasInlineBody(func)) continue;
                if (Number.isInteger(func?.singleStatementBodyLine)) continue;
                if (getFunctionBodyRangeForFunction(func)) continue;
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createFunctionNameRange(func),
                        t('validation.functionBodyExpected')
                    )
                );
            }
        };
        const lineStartsWithKeyword = (trimmedLine, keyword) =>
            trimmedLine === keyword || trimmedLine.startsWith(`${keyword} `) || trimmedLine.startsWith(`${keyword}(`);
        const getStatementTerminalKindFromText = text => {
            const trimmed = String(text || '').trim();
            if (lineStartsWithKeyword(trimmed, 'return')) return 'return';
            if (lineStartsWithKeyword(trimmed, 'goto')) return 'goto';
            return '';
        };
        const getLeadingCloseBraceCount = trimmedLine => {
            const match = String(trimmedLine || '').match(/^(?:}\s*)+/);
            return match ? (match[0].match(/}/g) || []).length : 0;
        };
        const getCompilerControlLineInfo = lineNumber => {
            const structuralLine = getStructuralLine(lineNumber);
            const leadingWhitespace = structuralLine.search(/\S|$/);
            const visibleStart = Math.max(0, leadingWhitespace);
            const visibleText = structuralLine.slice(visibleStart);
            const closeMatch = visibleText.match(/^(?:}\s*)+/);
            const closeLength = closeMatch ? closeMatch[0].length : 0;
            return {
                text: visibleText.slice(closeLength).trimStart(),
                offset: visibleStart + closeLength,
                leadingCloseBraces: closeMatch ? (closeMatch[0].match(/}/g) || []).length : 0
            };
        };
        const getCompilerLineEffectiveDepth = lineNumber => {
            const depth = depths[lineNumber] ?? 0;
            const trimmed = getTrimmedStructuralLine(lineNumber);
            return Math.max(0, depth - getLeadingCloseBraceCount(trimmed));
        };
        const getMultilineTerminalKindEndingAt = (lineNumber, startLine, baseDepth) => {
            const range = getCompilerMultilineStatementRange(strippedLines, lineNumber, {
                startLine,
                endLine: scanBounds.end,
                baseDepth,
                getLineText: getStructuralLine,
                getTrimmedLine: getTrimmedStructuralLine,
                getLineDepth: getCompilerLineEffectiveDepth,
                isIgnoredLine: isCompilerLaststIgnoredLine
            });
            if (!range || range.startLine === lineNumber || range.endLine !== lineNumber) return '';
            return getStatementTerminalKindFromText(range.text);
        };
        const findStructuralBlockEndLine = (startLine, endLine) => {
            let balance = 0;
            let sawOpen = false;
            for (let line = startLine; line <= endLine; line++) {
                const structuralLine = getStructuralLine(line);
                for (const char of structuralLine) {
                    if (char === '{') {
                        sawOpen = true;
                        balance++;
                    } else if (char === '}') {
                        if (!sawOpen) continue;
                        balance--;
                        if (sawOpen && balance <= 0) return line;
                    }
                }
            }
            return -1;
        };
        const getCompilerLikeTerminalKindForRange = (startLine, endLine, baseDepth) => {
            let lastStatementLine = -1;
            for (let line = Math.max(0, startLine); line <= endLine; line++) {
                const trimmed = getTrimmedStructuralLine(line);
                if (isCompilerLaststIgnoredLine(trimmed)) continue;
                if (getCompilerLineEffectiveDepth(line) !== baseDepth) continue;
                if (lineStartsWithKeyword(getCompilerControlLineInfo(line).text.trim(), 'else')) continue;
                if (isSingleStatementControlledBodyLine(line)) continue;
                lastStatementLine = line;
            }
            return lastStatementLine >= 0
                ? (
                    getCompilerLikeTerminalKindForStatement(lastStatementLine, endLine, baseDepth) ||
                    getMultilineTerminalKindEndingAt(lastStatementLine, startLine, baseDepth)
                )
                : '';
        };
        const getCompilerLikeTerminalKindForBranch = (startLine, endLine, parentDepth) => {
            const firstLine = findNextCompilerStatementLine(startLine, endLine);
            if (firstLine < 0) return { kind: '', endLine: startLine };
            const trimmed = getTrimmedStructuralLine(firstLine);
            if (trimmed.startsWith('{') || (depths[firstLine] ?? parentDepth) > parentDepth) {
                const previousTrimmed = firstLine > 0 ? getTrimmedStructuralLine(firstLine - 1) : '';
                const blockStartLine = trimmed.startsWith('{')
                    ? firstLine
                    : (previousTrimmed.includes('{') ? firstLine - 1 : firstLine);
                const blockEndLine = findStructuralBlockEndLine(blockStartLine, endLine);
                if (blockEndLine < 0) return { kind: '', endLine: firstLine };
                return {
                    kind: getCompilerLikeTerminalKindForRange(firstLine, blockEndLine - 1, parentDepth + 1),
                    endLine: blockEndLine
                };
            }
            return {
                kind: getCompilerLikeTerminalKindForStatement(firstLine, endLine, depths[firstLine] ?? parentDepth),
                endLine: firstLine
            };
        };
        const getControlInlineBodyStart = (lineNumber, keywordStart, keyword) => {
            const line = getStructuralLine(lineNumber);
            const start = skipInlineControlHeader(line, keywordStart, keyword);
            return Number.isInteger(start) && start >= 0 ? start : -1;
        };
        const getCompilerLikeIfTerminalKind = (ifLine, endLine, baseDepth) => {
            let currentIfLine = ifLine;
            let expectedKind = '';
            for (let guard = 0; guard < 64; guard++) {
                const currentInfo = getCompilerControlLineInfo(currentIfLine);
                const currentLine = currentInfo.text;
                const currentTrimmed = currentLine.trim();
                const ifKeywordIndex = currentTrimmed.startsWith('else')
                    ? currentLine.indexOf('if', currentLine.indexOf('else') + 4)
                    : currentLine.indexOf('if');
                if (ifKeywordIndex < 0) return '';
                const rawIfKeywordIndex = currentInfo.offset + ifKeywordIndex;
                const inlineBodyStart = getControlInlineBodyStart(currentIfLine, rawIfKeywordIndex, 'if');
                const inlineBody = inlineBodyStart >= 0
                    ? getStructuralLine(currentIfLine).slice(inlineBodyStart).trim()
                    : '';
                const branch = inlineBody && inlineBody !== '{'
                    ? { kind: getStatementTerminalKindFromText(inlineBody), endLine: currentIfLine }
                    : getCompilerLikeTerminalKindForBranch(currentIfLine + 1, endLine, baseDepth);
                if (!branch.kind) return '';
                if (!expectedKind) expectedKind = branch.kind;
                if (branch.kind !== expectedKind) return '';

                const branchEndInfo = getCompilerControlLineInfo(branch.endLine);
                const elseLine = lineStartsWithKeyword(branchEndInfo.text.trim(), 'else')
                    ? branch.endLine
                    : findNextCompilerStatementLine(branch.endLine + 1, endLine);
                if (elseLine < 0) return '';
                if (getCompilerLineEffectiveDepth(elseLine) !== baseDepth) return '';
                const elseInfo = getCompilerControlLineInfo(elseLine);
                const elseText = elseInfo.text.trim();
                if (!lineStartsWithKeyword(elseText, 'else')) return '';
                const elseKeywordStart = elseInfo.offset + elseInfo.text.indexOf('else');
                const afterElseStart = getControlInlineBodyStart(elseLine, elseKeywordStart, 'else');
                const afterElse = afterElseStart >= 0
                    ? getStructuralLine(elseLine).slice(afterElseStart).trim()
                    : '';
                if (lineStartsWithKeyword(afterElse, 'if')) {
                    currentIfLine = elseLine;
                    continue;
                }
                const elseBranch = afterElse && afterElse !== '{'
                    ? { kind: getStatementTerminalKindFromText(afterElse), endLine: elseLine }
                    : getCompilerLikeTerminalKindForBranch(elseLine + 1, endLine, baseDepth);
                return elseBranch.kind === expectedKind ? expectedKind : '';
            }
            return '';
        };
        function getCompilerLikeTerminalKindForStatement(lineNumber, endLine, baseDepth) {
            const trimmed = getTrimmedStructuralLine(lineNumber);
            const directKind = getStatementTerminalKindFromText(trimmed);
            if (directKind) return directKind;
            if (lineStartsWithKeyword(trimmed, 'if')) {
                return getCompilerLikeIfTerminalKind(lineNumber, endLine, baseDepth);
            }
            return '';
        }
        const hasCompilerLikeFunctionTerminal = func => {
            const bodyRange = getFunctionBodyRangeForFunction(func);
            if (!bodyRange) return false;
            const baseDepth = functionBodyDepthByFunction.get(func) ?? 1;
            const terminalKind = getCompilerLikeTerminalKindForRange(
                bodyRange.startLine,
                bodyRange.endLine,
                baseDepth
            );
            return terminalKind === 'return' || terminalKind === 'goto';
        };
        collectMissingFunctionBodyDiagnostics();
        const collectUnreachableCodeDiagnostics = () => {
            const result = [];
            const terminalLineByFunctionDepth = new Map();
            let activeFuncKey = null;

            const processUnreachableLine = lineNumber => {
                const functionBody = functionBodyRangeByLine[lineNumber] || null;
                if (!functionBody) {
                    activeFuncKey = null;
                    terminalLineByFunctionDepth.clear();
                    return;
                }
                if (activeFuncKey !== functionBody.func) {
                    activeFuncKey = functionBody.func;
                    terminalLineByFunctionDepth.clear();
                }

                const structuralLine = getStructuralLine(lineNumber);
                const trimmedLine = structuralLine.trim();
                if (!trimmedLine || isPreprocessorDirectiveOrContinuationLine(rootCtx, lineNumber, trimmedLine)) {
                    return;
                }
                if (isInsideLineStartGroupContext(lineNumber)) {
                    return;
                }
                const currentDepth = getCompilerLineEffectiveDepth(lineNumber);
                const multilineRange = getCompilerMultilineRangeForLine(lineNumber, currentDepth);
                const isMultilineContinuation = !!multilineRange && multilineRange.startLine < lineNumber;
                for (const depth of terminalLineByFunctionDepth.keys()) {
                    if (depth > currentDepth) terminalLineByFunctionDepth.delete(depth);
                }
                if (isUnreachableResetLine(trimmedLine)) {
                    terminalLineByFunctionDepth.delete(currentDepth);
                }
                const terminalKind = getWholeLineTerminalKind(lineNumber, trimmedLine, currentDepth);
                const terminalLine = terminalLineByFunctionDepth.get(currentDepth);
                if (
                    !isMultilineContinuation &&
                    terminalLine != null &&
                    terminalLine < lineNumber &&
                    !isSingleStatementControlledBodyLine(terminalLine) &&
                    isExecutableStatementForUnreachable(trimmedLine) &&
                    shouldIncludeTargetLine(targetLines, lineNumber)
                ) {
                    const rawLine = String(rawLines[lineNumber] || '');
                    const lineStartOffset = getLineStartOffset(lineNumber);
                    const firstVisibleIndex = rawLine.search(/\S|$/);
                    const issue = getUnreachableCodeIssue();
                    result.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + Math.max(0, firstVisibleIndex),
                                lineStartOffset + Math.max(1, rawLine.length),
                                docLength
                            ),
                            t(issue.messageKey, issue.params || {}),
                            getWarningSeverity()
                        )
                    );
                }
                if (terminalKind && !isSingleStatementControlledBodyLine(lineNumber)) {
                    terminalLineByFunctionDepth.set(currentDepth, lineNumber);
                } else if (!isMultilineContinuation && isExecutableStatementForUnreachable(trimmedLine)) {
                    terminalLineByFunctionDepth.delete(currentDepth);
                }
            };

            for (const lineNumber of unreachableCandidateLineNumbers) {
                if (lineNumber < scanBounds.start) continue;
                if (lineNumber > scanBounds.end) break;
                processUnreachableLine(lineNumber);
            }

            return result;
        };

        let structuralCandidateIndex = 0;
        while (
            structuralCandidateIndex < structuralCandidateLineNumbers.length &&
            structuralCandidateLineNumbers[structuralCandidateIndex] < scanBounds.start
        ) {
            structuralCandidateIndex++;
        }
        for (let lineNumber = scanBounds.start; lineNumber <= scanBounds.end; lineNumber++) {
            const candidateLine = structuralCandidateLineNumbers[structuralCandidateIndex];
            if (candidateLine == null || candidateLine > scanBounds.end) break;
            if (lineNumber !== candidateLine) lineNumber = candidateLine;
            structuralCandidateIndex++;
            const structuralLine = getStructuralLine(lineNumber);
            const trimmedLine = structuralLine.trim();
            const currentDepth = depths[lineNumber] ?? 0;
            if (!trimmedLine) continue;
            if (isPreprocessorDirectiveOrContinuationLine(rootCtx, lineNumber, trimmedLine)) continue;
            const statement = classifyPawnStatementLine(structuralLine);
            const includeTargetLine = shouldIncludeTargetLine(targetLines, lineNumber);

            controlContextTracker.beginLine(lineNumber, currentDepth, trimmedLine);
            const {
                activeBlockSwitch,
                activeSingleStatementContext,
                activeSwitch,
                hasActiveLoop,
                hasActiveBreakContext
            } = controlContextTracker.getActiveContext();
            const switchLabel = statement.switchLabel;
            const caseMatch = switchLabel?.kind === 'case' ? switchLabel : null;
            const defaultMatch = switchLabel?.kind === 'default';
            const inlineCaseBody = switchLabel?.inlineBody || '';

            if (
                !includeDocument &&
                currentDepth === 0 &&
                !functionBodyRangeByLine[lineNumber] &&
                !isFunctionHeaderLine(rootCtx, lineNumber)
            ) {
                if (trimmedLine.startsWith('{') && isTopLevelBraceStartWithoutHeader(lineNumber) && includeTargetLine) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, '{'),
                            t('validation.startOfFunctionBodyWithoutHeader')
                        )
                    );
                    continue;
                }
                if (isTopLevelDeclarationContinuationLine(lineNumber)) {
                    continue;
                }
                const invalidOutsideKeyword = (
                    statement.firstKeyword === 'if' ||
                    statement.firstKeyword === 'for' ||
                    statement.firstKeyword === 'while' ||
                    statement.firstKeyword === 'switch' ||
                    statement.firstKeyword === 'do' ||
                    statement.firstKeyword === 'else' ||
                    statement.firstKeyword === 'return' ||
                    statement.firstKeyword === 'state' ||
                    statement.firstKeyword === 'goto' ||
                    statement.firstKeyword === 'assert' ||
                    statement.firstKeyword === 'sleep' ||
                    statement.firstKeyword === 'exit'
                )
                    ? statement.firstKeyword
                    : '';
                if (invalidOutsideKeyword && includeTargetLine) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, invalidOutsideKeyword, statement.firstKeywordStart),
                            t('validation.invalidOutsideFunctions')
                        )
                    );
                    continue;
                }
                const invalidOutsideConstantIssue = isInsideLineStartGroupContext(lineNumber)
                    ? null
                    : getNoEffectConstantStatementIssue(structuralLine);
                if (invalidOutsideConstantIssue && includeTargetLine) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, invalidOutsideConstantIssue.text, invalidOutsideConstantIssue.start),
                            t('validation.invalidOutsideFunctions')
                        )
                    );
                    continue;
                }
            }

            if (functionBodyRangeByLine[lineNumber]) {
                const isWholeLineEmptyStatement = trimmedLine === ';';
                let isInlineEmptyStatement = false;
                const isDoWhileClosingStatement =
                    statement.firstKeyword === 'while' &&
                    isDoWhileClosingLine(lineNumber);
                if (
                    !isWholeLineEmptyStatement &&
                    !isDoWhileClosingStatement &&
                    trimmedLine.endsWith(';') &&
                    mayHaveInlineStatementPrefix(structuralLine)
                ) {
                    const inlinePrefix = stripLeadingInlineStatementPrefix(structuralLine);
                    isInlineEmptyStatement =
                        hasControlInlinePrefix(inlinePrefix) &&
                        inlinePrefix.startOffset > 0 &&
                        inlinePrefix.text.trim() === ';';
                }
                if (includeTargetLine && (isWholeLineEmptyStatement || isInlineEmptyStatement)) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, ';'),
                            t('validation.emptyStatement')
                        )
                    );
                    continue;
                }

                const noEffectConstantIssue = isInsideLineStartGroupContext(lineNumber)
                    ? null
                    : getNoEffectConstantStatementIssue(structuralLine);
                if (includeTargetLine && noEffectConstantIssue) {
                    const warningIssue = getStatementHasNoEffectIssue(noEffectConstantIssue);
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, noEffectConstantIssue.text, noEffectConstantIssue.start),
                            t(warningIssue?.messageKey || 'validation.statementHasNoEffect', warningIssue?.params || {}),
                            warningIssue?.severity === 'warning' ? getWarningSeverity() : undefined
                        )
                    );
                    continue;
                }

                const constantControlTestIssue = getConstantControlTestIssue(lineNumber, structuralLine, statement);
                if (warningsEnabled && includeTargetLine && constantControlTestIssue) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, statement.firstKeyword, statement.firstKeywordStart),
                            t(constantControlTestIssue.messageKey, constantControlTestIssue.params || {}),
                            getWarningSeverity()
                        )
                    );
                }
                const conditionAssignmentIssue = getConditionAssignmentIssue(structuralLine, statement);
                if (warningsEnabled && includeTargetLine && conditionAssignmentIssue) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, '=', conditionAssignmentIssue.start),
                            t(conditionAssignmentIssue.messageKey || 'validation.possiblyUnintendedAssignment', conditionAssignmentIssue.params || {}),
                            getWarningSeverity()
                        )
                    );
                }

                const startsWithLocalDecl = statement.firstKeyword === 'new' || statement.firstKeyword === 'static';
                let inlinePrefixForLine = null;
                const mayContainInlineLocalDeclAfterControl =
                    !startsWithLocalDecl &&
                    (
                        statement.firstKeyword === 'if' ||
                        statement.firstKeyword === 'for' ||
                        statement.firstKeyword === 'while' ||
                        statement.firstKeyword === 'do' ||
                        statement.firstKeyword === 'else'
                    ) &&
                    findKeywordOccurrences(structuralLine, ['new', 'static']).length > 0;
                let inlineLocalDeclAfterControl = false;
                if (mayContainInlineLocalDeclAfterControl) {
                    inlinePrefixForLine = stripLeadingInlineStatementPrefix(structuralLine);
                    inlineLocalDeclAfterControl =
                        hasControlInlinePrefix(inlinePrefixForLine) &&
                        inlinePrefixForLine.startOffset > 0 &&
                        isLocalDeclarationStatementStart(inlinePrefixForLine.text);
                }
                let previousLineControlLocalDecl = false;
                if (startsWithLocalDecl) {
                    const previousNonEmptyLine = getPreviousNonEmptyLine(lineNumber - 1);
                    if (previousNonEmptyLine >= 0) {
                        const previousTrimmedLine = getTrimmedStructuralLine(previousNonEmptyLine);
                        const previousInlinePrefix = stripLeadingInlineStatementPrefix(previousTrimmedLine);
                        const previousStatement = classifyPawnStatementLine(previousTrimmedLine);
                        previousLineControlLocalDecl =
                            !isDoWhileClosingLine(previousNonEmptyLine) &&
                            (
                                previousStatement.firstKeyword === 'if' ||
                                previousStatement.firstKeyword === 'for' ||
                                previousStatement.firstKeyword === 'while' ||
                                previousStatement.firstKeyword === 'switch' ||
                                previousStatement.firstKeyword === 'do' ||
                                previousStatement.firstKeyword === 'else'
                            ) &&
                            !/[{;]\s*$/.test(previousTrimmedLine) &&
                            !String(previousInlinePrefix.text || '').trim();
                    }
                }
                if (
                    includeTargetLine &&
                    (inlineLocalDeclAfterControl || (startsWithLocalDecl && (activeSingleStatementContext || previousLineControlLocalDecl)))
                ) {
                    const localDeclSource = inlinePrefixForLine?.text || trimmedLine;
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(
                                lineNumber,
                                isKeywordAt(localDeclSource.trimStart(), 0, 'static') ? 'static' : 'new'
                            ),
                            t('validation.localDeclarationMustAppearInCompoundBlock')
                        )
                    );
                    continue;
                }
            }

            if ((caseMatch || defaultMatch) && !activeSwitch && includeTargetLine) {
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createKeywordRange(lineNumber, caseMatch ? 'case' : 'default', switchLabel.keywordStart),
                        t('validation.invalidStatementNotInSwitch')
                    )
                );
            }

            if (
                activeSwitch &&
                inlineCaseBody &&
                !inlineCaseBody.startsWith('{') &&
                countTopLevelSemicolonStatements(inlineCaseBody) > 1 &&
                includeTargetLine
            ) {
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createKeywordRange(lineNumber, caseMatch ? 'case' : 'default', switchLabel.keywordStart),
                        t('validation.singleStatementAfterCase')
                    )
                );
            }

            if (activeBlockSwitch && currentDepth === activeBlockSwitch.bodyDepth) {
                if (caseMatch) {
                    if (activeBlockSwitch.seenDefault && includeTargetLine) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createKeywordRange(lineNumber, 'case', switchLabel.keywordStart),
                                t('validation.defaultMustBeLast')
                            )
                        );
                    }
                    const rawSwitchLabel = classifyPawnStatementLine(String(strippedLines[lineNumber] || '')).switchLabel;
                    const valueCaseMatch = rawSwitchLabel?.kind === 'case'
                        ? rawSwitchLabel
                        : caseMatch;
                    const rawValue = stripTrailingSemicolon(valueCaseMatch.label);
                    const caseAnalysis = containsPawnIdentifierStartChar(rawValue)
                        ? getLineTypeAnalysisInfo(lineNumber)
                        : null;
                    const resolvedCaseValues = resolveSwitchCaseLabelValues(rawValue, caseAnalysis?.decls || [], {
                        analysisCache: caseAnalysis?.analysisCache || null
                    });
                    if (resolvedCaseValues.invalidRange && includeTargetLine) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createSwitchCaseLabelRange(lineNumber, caseMatch),
                                t('validation.invalidRange')
                            )
                        );
                    }
                    if (resolvedCaseValues.invalidConstant && includeTargetLine) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createSwitchCaseLabelRange(lineNumber, caseMatch),
                                t('validation.mustBeConstantExpression')
                            )
                        );
                    }
                    let duplicateValue = '';
                    for (const entry of resolvedCaseValues.entries) {
                        const duplicateEntryValue = findDuplicateSwitchCaseEntry(activeBlockSwitch, entry);
                        if (duplicateEntryValue && !duplicateValue) {
                            duplicateValue = duplicateEntryValue;
                        }
                        rememberSwitchCaseEntry(activeBlockSwitch, entry);
                    }
                    if (duplicateValue && includeTargetLine) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createSwitchCaseLabelRange(lineNumber, caseMatch),
                                t('validation.duplicateCaseLabel', { value: duplicateValue })
                            )
                        );
                    }
                } else if (defaultMatch) {
                    if (activeBlockSwitch.seenDefault) {
                        if (includeTargetLine) {
                            diagnostics.push(
                                createLiveValidationDiagnostic(
                                    createKeywordRange(lineNumber, 'default', switchLabel.keywordStart),
                                    t('validation.multipleDefaultsInSwitch')
                                )
                            );
                        }
                    } else {
                        activeBlockSwitch.seenDefault = true;
                    }
                }
            }

            for (const controlMatch of statement.controlOccurrences) {
                const keyword = controlMatch.keyword;
                const isValid = keyword === 'break'
                    ? (hasActiveBreakContext || hasInlineContextBefore(structuralLine, controlMatch.start, keyword))
                    : (hasActiveLoop || hasInlineContextBefore(structuralLine, controlMatch.start, keyword));
                if (!isValid && includeTargetLine) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, keyword, controlMatch.start),
                            t('validation.outOfContextControl', { keyword })
                        )
                    );
                }
            }

            const functionBody = functionBodyRangeByLine[lineNumber] || null;
            if (functionBody) {
                updateFunctionTerminalState(lineNumber, functionBody, trimmedLine, statement);
            }
            if (functionBody && statement.firstKeyword === 'state') {
                const stateIssues = getStateStatementIssues(structuralLine, rootCtx.parsedDecls?.functions || []);
                for (const issue of stateIssues) {
                    if (!includeTargetLine) continue;
                    const rangeStart = Number.isInteger(issue.rangeStart) ? issue.rangeStart : statement.firstKeywordStart;
                    const rangeEnd = Number.isInteger(issue.rangeEnd)
                        ? issue.rangeEnd
                        : rangeStart + Math.max(1, statement.firstKeyword.length);
                    const lineStartOffset = getLineStartOffset(lineNumber);
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(document, lineStartOffset + rangeStart, lineStartOffset + rangeEnd, docLength),
                            t(issue.messageKey, issue.params || {})
                        )
                    );
                }
            }
            const effectiveReturnInfo = functionBody
                ? getEffectiveReturnInfo(lineNumber, currentDepth, statement)
                : null;
            if (functionBody && effectiveReturnInfo) {
                    const funcKey = functionBody.func || null;
                    const state = returnStyleByFunction.get(funcKey) || {
                        sawVoid: false,
                        sawValue: false,
                        sawArray: false,
                        sawScalar: false,
                        valueReturnCount: 0,
                        firstValueReturn: null,
                        firstArrayReturnType: null,
                        firstArrayReturnDecls: null,
                        firstArrayReturnAnalysisCache: null
                    };
                    const returnValueText = effectiveReturnInfo.valueText;
                    const usesValue = !!returnValueText;
                    if (usesValue ? state.sawVoid : state.sawValue) {
                        if (includeTargetLine) {
                            diagnostics.push(
                                createLiveValidationDiagnostic(
                                    createKeywordRange(lineNumber, 'return', effectiveReturnInfo.start),
                                    t('validation.mixedReturnStyles')
                                )
                            );
                        }
                    }
                    if (usesValue) {
                        const returnTypeInfo = getReturnValueTypeInfo(lineNumber, returnValueText);
                        const returnsArray = !!returnTypeInfo.type?.dims;
                        state.valueReturnCount++;
                        if (state.valueReturnCount === 1) {
                            state.firstValueReturn = {
                                lineNumber,
                                valueText: returnValueText
                            };
                            if (returnsArray) {
                                state.sawArray = true;
                                state.firstArrayReturnType = returnTypeInfo.type;
                                state.firstArrayReturnDecls = returnTypeInfo.decls;
                                state.firstArrayReturnAnalysisCache = returnTypeInfo.analysisCache;
                            } else {
                                state.sawScalar = true;
                            }
                        }
                        if (returnsArray ? state.sawScalar : state.sawArray) {
                            if (includeTargetLine) {
                                diagnostics.push(
                                    createLiveValidationDiagnostic(
                                        createKeywordRange(lineNumber, 'return', effectiveReturnInfo.start),
                                        t('validation.inconsistentReturnTypesArrayNonArray')
                                    )
                                );
                            }
                        }
                        if (state.valueReturnCount > 1) {
                            if (returnsArray) {
                                if (state.firstArrayReturnType?.dims) {
                                    const shapeIssue = getLiveArrayShapeIssue(
                                        state.firstArrayReturnType.dims,
                                        returnTypeInfo.type.dims,
                                        returnValueText,
                                        state.firstArrayReturnDecls || returnTypeInfo.decls,
                                        state.firstArrayReturnAnalysisCache || returnTypeInfo.analysisCache,
                                        returnTypeInfo.escapeChar
                                    );
                                    if (shapeIssue && includeTargetLine) {
                                        diagnostics.push(
                                            createLiveValidationDiagnostic(
                                                createKeywordRange(lineNumber, 'return', effectiveReturnInfo.start),
                                                explainArrayShapeDiagnosticIssue(shapeIssue).reason,
                                                shapeIssue.severity
                                            )
                                        );
                                    }
                                }
                                state.sawArray = true;
                                if (!state.firstArrayReturnType) {
                                    state.firstArrayReturnType = returnTypeInfo.type;
                                    state.firstArrayReturnDecls = returnTypeInfo.decls;
                                    state.firstArrayReturnAnalysisCache = returnTypeInfo.analysisCache;
                                }
                            } else {
                                state.sawScalar = true;
                            }
                        }
                    }
                    if (usesValue) state.sawValue = true;
                    else state.sawVoid = true;
                    returnStyleByFunction.set(funcKey, state);
            }

            let firstSwitchStart = -1;
            let firstForStart = -1;
            let firstWhileStart = -1;
            let firstDoStart = -1;
            for (const controlStart of statement.controlStarts) {
                if (controlStart.keyword === 'switch') {
                    if (firstSwitchStart < 0) firstSwitchStart = controlStart.start;
                } else if (controlStart.keyword === 'for') {
                    if (firstForStart < 0) firstForStart = controlStart.start;
                } else if (controlStart.keyword === 'while') {
                    if (firstWhileStart < 0) firstWhileStart = controlStart.start;
                } else if (controlStart.keyword === 'do') {
                    if (firstDoStart < 0) firstDoStart = controlStart.start;
                }
            }
            if (firstSwitchStart >= 0) {
                pushControlContext('switch', lineNumber, structuralLine, currentDepth, firstSwitchStart);
            }
            if (firstForStart >= 0) {
                pushControlContext('for', lineNumber, structuralLine, currentDepth, firstForStart);
            }
            if (firstWhileStart >= 0 && !isDoWhileClosingLine(lineNumber)) {
                pushControlContext('while', lineNumber, structuralLine, currentDepth, firstWhileStart);
            }
            if (firstDoStart >= 0) {
                pushControlContext('do', lineNumber, structuralLine, currentDepth, firstDoStart);
            }
            const macroProvidedControl = getMacroProvidedControlContext(structuralLine);
            if (macroProvidedControl) {
                pushControlContext(
                    macroProvidedControl.type,
                    lineNumber,
                    structuralLine,
                    currentDepth,
                    macroProvidedControl.start
                );
            }

            controlContextTracker.finishLine(lineNumber, structuralLine);
        }

        if (warningsEnabled) {
            for (const [func, returnState] of returnStyleByFunction) {
                if (!shouldIncludeTargetLine(targetLines, func.startLine ?? func.lineNumber ?? -1)) continue;
                const issue = getFunctionShouldReturnValueIssue(
                    func,
                    returnState,
                    hasCompilerLikeFunctionTerminal(func)
                        ? { hasFunctionLevelTerminal: true }
                        : (terminalStateByFunction.get(func) || null)
                );
                if (!issue) continue;
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createFunctionNameRange(func),
                        t(issue.messageKey || 'validation.functionShouldReturnValue', issue.params || { name: issue.name || func.name }),
                        getWarningSeverity()
                    )
                );
            }
            diagnostics.push(...collectUnreachableCodeDiagnostics());
        }
        return diagnostics;
    }

    return {
        collectStructuralLiveDiagnostics
    };
}

module.exports = { createStructuralDiagnostics };
