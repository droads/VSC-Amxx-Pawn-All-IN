// In-memory, runtime-only registry of programmatic include path contributions.
// External tools (builders, package managers, other extensions) can register their
// own include search directories here without writing VS Code settings or any file.
// Contributor paths form a search tier between project-local configured paths and
// configured global paths (see PAWN_INCLUDE_PATHS_API.md). This module is vscode-free
// so it can be unit-tested and reasoned about on its own.

function createProgrammaticIncludePathsService() {
    const contributions = new Map();
    const listeners = new Set();
    let flattenedIncludePathsCache = null;

    function setIncludePaths(contributorId, paths) {
        const id = String(contributorId || '').trim();
        if (!id) return;
        if (!Array.isArray(paths)) return;
        for (const entry of paths) {
            if (typeof entry !== 'string') return;
        }
        if (!paths.length) {
            if (contributions.delete(id)) fire();
            return;
        }
        const nextList = paths.slice();
        const existing = contributions.get(id);
        if (existing && listsAreIdentical(existing, nextList)) return;
        contributions.set(id, nextList);
        fire();
    }

    function clearIncludePaths(contributorId) {
        const id = String(contributorId || '').trim();
        if (!id) return;
        if (contributions.delete(id)) fire();
    }

    function getIncludePaths(contributorId) {
        const id = String(contributorId || '').trim();
        if (!id) return [];
        const stored = contributions.get(id);
        return stored ? stored.slice() : [];
    }

    function getProgrammaticIncludePaths() {
        if (flattenedIncludePathsCache === null) {
            const flattened = [];
            for (const list of contributions.values()) {
                for (const entry of list) {
                    flattened.push(entry);
                }
            }
            flattenedIncludePathsCache = flattened;
        }
        return flattenedIncludePathsCache.slice();
    }

    function onDidChangeIncludePaths(listener) {
        if (typeof listener === 'function') {
            listeners.add(listener);
        }
        return {
            dispose() {
                listeners.delete(listener);
            }
        };
    }

    function listsAreIdentical(left, right) {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index++) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    function fire() {
        flattenedIncludePathsCache = null;
        const snapshot = [...listeners];
        for (const listener of snapshot) {
            try {
                listener();
            } catch {
                // One bad listener must not break the others.
            }
        }
    }

    function dispose() {
        listeners.clear();
    }

    return {
        setIncludePaths,
        clearIncludePaths,
        getIncludePaths,
        getProgrammaticIncludePaths,
        onDidChangeIncludePaths,
        dispose
    };
}

module.exports = { createProgrammaticIncludePathsService };
