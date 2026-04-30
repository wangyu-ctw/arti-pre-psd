// organizeLayerGroups.jsx
// ────────────────────────────────────────────────────────────────────────
// 解散"只含一个子层（ArtLayer 或 LayerSet）"的图层组：
//   把那个唯一子层移到原组的位置（上方），删除现在已空的组。
//
// 执行顺序：从最深层（最内层）开始处理，再往外扩。
//   这样内层先被压平，外层再判断是否变成了单子组，继续压平。
//
// 迭代直到文档里不再有单子组为止，最多 500 次。
// 失败的组记入 failedIds，跳过避免死循环。
//
// 注意：不处理空组（0 个子层），那类由 Delete All Empty Layers 负责。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

(function () {
    if (app.documents.length === 0) return "no document";

    var doc = app.activeDocument;
    var dissolved = 0;
    var failedIds = {};
    var iter = 0;
    var MAX_ITER = 500;

    while (iter < MAX_ITER) {
        iter++;
        var group = findDeepestSingleChildGroup(doc, failedIds);
        if (group === null) break;
        try {
            dissolveGroup(group);
            dissolved++;
        } catch (e) {
            $.writeln("dissolve failed (" + group.name + "): " + e);
            failedIds[group.id] = true;
        }
    }

    return "dissolved=" + dissolved + ", iter=" + iter;

    // ─── helpers ────────────────────────────────────────────────────────

    // 深度优先：先在子组里找，找到就返回（最深优先）；
    // 子树里没有单子组，再检查当前层自身是否是单子组。
    function findDeepestSingleChildGroup(parent, failedIds) {
        var arr = parent.layers;
        for (var i = 0; i < arr.length; i++) {
            var layer = arr[i];
            if (layer.typename !== "LayerSet") continue;
            if (failedIds && failedIds[layer.id]) continue;
            // 先递归进子树
            var found = findDeepestSingleChildGroup(layer, failedIds);
            if (found !== null) return found;
            // 子树里没有，看自身是否单子
            if (layer.layers.length === 1) return layer;
        }
        return null;
    }

    // 解散单子组：子层移到组正上方，删除空组
    function dissolveGroup(group) {
        var child = group.layers[0];

        // 如果组本身是隐藏的，把隐藏属性传给子层
        if (!group.visible) {
            try { child.visible = false; } catch (e) { /* no-op */ }
        }

        // PLACEBEFORE = 在面板里位于 group 的上方（视觉上同位置）
        child.move(group, ElementPlacement.PLACEBEFORE);

        // 删除现在已空的组
        if (group.allLocked) group.allLocked = false;
        group.remove();
    }
})();
