// ungroupArtboards.jsx
// ────────────────────────────────────────────────────────────────────────
// 对文档内所有「画板」（Artboard，实为带 artboardEnabled 的 LayerSet）执行
// 「取消画板编组」：通过 ActionManager 的 ungroupLayersEvent（与 PS 菜单一致，
// 目标为当前选中图层），把画板容器拆掉，子层保留在父级。
//
// 顺序：深度优先，先处理子树里的画板，再处理当前容器内的画板，避免父画板
// 先拆导致结构错乱。单步失败记入 failedIds，避免死循环。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

(function () {
    if (app.documents.length === 0) {
        return "no document";
    }

    var doc = app.activeDocument;
    var ungrouped = 0;
    var failedIds = {};
    var iter = 0;
    var MAX_ITER = 500;

    function isArtboardLayerSet(lyr) {
        if (lyr.typename !== "LayerSet") {
            return false;
        }
        try {
            if (typeof lyr.artboardEnabled !== "undefined" && lyr.artboardEnabled) {
                return true;
            }
        } catch (eDom) {
            /* no-op */
        }
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), lyr.id);
        var desc;
        try {
            desc = executeActionGet(ref);
        } catch (eGet) {
            return false;
        }
        try {
            return desc.getBoolean(stringIDToTypeID("artboardEnabled"));
        } catch (eBool) {
            return false;
        }
    }

    /** 先深入子组，再返回当前层级遇到的第一个画板（最深优先）。 */
    function findDeepestArtboard(container) {
        var ls = container.layers;
        var i;
        for (i = 0; i < ls.length; i++) {
            if (ls[i].typename === "LayerSet" && !failedIds[ls[i].id]) {
                var inner = findDeepestArtboard(ls[i]);
                if (inner !== null) {
                    return inner;
                }
            }
        }
        for (i = 0; i < ls.length; i++) {
            var L = ls[i];
            if (L.typename === "LayerSet" && !failedIds[L.id] && isArtboardLayerSet(L)) {
                return L;
            }
        }
        return null;
    }

    function ungroupTarget() {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        desc.putReference(charIDToTypeID("null"), ref);
        executeAction(stringIDToTypeID("ungroupLayersEvent"), desc, DialogModes.NO);
    }

    while (iter < MAX_ITER) {
        iter++;
        var ab = findDeepestArtboard(doc);
        if (ab === null) {
            break;
        }
        try {
            doc.activeLayer = ab;
            // Unlock before ungrouping to avoid permission errors.
            try { ab.allLocked = false; } catch (eLock) {}
            ungroupTarget();
            ungrouped++;
        } catch (e) {
            failedIds[ab.id] = true;
        }
    }

    // Deselect all layers after ungrouping.
    try {
        var deselDesc = new ActionDescriptor();
        executeAction(stringIDToTypeID("selectNoLayers"), deselDesc, DialogModes.NO);
    } catch (eDesel) { /* no-op */ }

    return "ungrouped=" + ungrouped + ", iter=" + iter;
})();
