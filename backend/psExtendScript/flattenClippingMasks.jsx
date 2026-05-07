/**
 * merge_clipping_masks_v2.jsx
 *
 * 修复说明（相较 v1）：
 *  Bug 1 - 扁平化策略错误：
 *    原版把所有图层扁平到一个列表，但 PSD 的剪切蒙版关系是「同一父容器内」判断的。
 *    递归进入图层组时，组内的剪切关系会被完全忽略。
 *  Bug 2 - 遍历顺序错误：
 *    必须先处理最内层（后序遍历），否则合并外层时内层还有剪切层，导致异常。
 *  Bug 3 - mergeLayersNew 兼容性问题：
 *    该 stringID 在部分 PS 版本不存在，改用更通用的多选 + Mrg2。
 *
 * 使用方法：
 *   Photoshop 菜单 → 文件 → 脚本 → 浏览... → 选择本文件
 */

#target photoshop

(function () {
    var doc = app.activeDocument;
    if (!doc) {
        alert("请先打开一个 PSD 文件。");
        return;
    }

    var historyState = doc.activeHistoryState;

    try {
        var totalMerged = 0;
        // 循环直到文档中没有任何剪切蒙版
        var maxLoop = 200;
        var loopCount = 0;
        while (loopCount < maxLoop) {
            loopCount++;
            var merged = processSinglePass(doc);
            if (merged === 0) break;
            totalMerged += merged;
        }
    } catch (e) {
        doc.activeHistoryState = historyState;
    }

    // ─────────────────────────────────────────────────────────────────
    // 每次 pass：在文档内所有层级中，找到「第一个」剪切蒙版组并合并
    // 采用后序遍历：先处理最内层，再处理外层
    // 返回本次合并数量（每次只合并一个，然后让外层循环重新扫描）
    // ─────────────────────────────────────────────────────────────────
    function processSinglePass(doc) {
        return processContainer(doc.layers);
    }

    // container 是 layers 集合（doc.layers 或 LayerSet.layers）
    // 返回 1 表示已合并一次，0 表示无需合并
    function processContainer(layersCollection) {
        // 将集合转为数组（index 0 = 最上层，PS 原生顺序）
        var arr = collectionToArray(layersCollection);

        // ── 后序遍历：先递归处理每个子组内部 ──────────────────────
        for (var i = 0; i < arr.length; i++) {
            var layer = arr[i];
            if (layer.typename === "LayerSet") {
                var innerResult = processContainer(layer.layers);
                if (innerResult > 0) {
                    return innerResult; // 已合并，交给外层循环重新扫描
                }
            }
        }

        // ── 在当前容器内查找第一个基底+剪切组 ─────────────────────
        // PS 层顺序：arr[0] = 最上层；剪切层在其「被剪切基底」的上方
        // 也就是说：基底 arr[i]，其剪切层在 arr[i-1], arr[i-2]...（index 更小）
        //
        // 从下往上扫描（index 从大到小），找「自身不是剪切层，但紧上方有剪切层」的位置

        for (var baseIdx = arr.length - 1; baseIdx >= 0; baseIdx--) {
            var baseLayer = arr[baseIdx];
            if (isClipped(baseLayer)) continue; // 自身是剪切层，跳过

            // 检查其上方（index 更小方向）是否紧跟着剪切层
            if (baseIdx > 0 && isClipped(arr[baseIdx - 1])) {
                // 收集连续的剪切层（向上）
                var clipLayers = [];
                for (var ci = baseIdx - 1; ci >= 0; ci--) {
                    if (isClipped(arr[ci])) {
                        clipLayers.push(arr[ci]);
                    } else {
                        break;
                    }
                }

                // 执行合并
                mergeClippingGroup(baseLayer, clipLayers);
                return 1;
            }
        }

        return 0; // 本容器内无剪切蒙版
    }

    // ─────────────────────────────────────────────────────────────────
    // 合并一个「基底 + 剪切层」组
    // ─────────────────────────────────────────────────────────────────
    function mergeClippingGroup(baseLayer, clipLayers) {
        var doc = app.activeDocument;

        // Step 1：若基底是图层组，先合并为普通图层
        if (baseLayer.typename === "LayerSet") {
            doc.activeLayer = baseLayer;
            // 先取消对图层组内部子层的选中状态，只选中组本身
            selectSingleLayer(baseLayer);
            // 合并图层组（等同于在组上按 Ctrl+E / Cmd+E）
            mergeGroup();
            // 合并后图层引用已失效，外层循环会重新扫描，直接返回
            return;
        }

        // Step 2：多选基底层 + 所有剪切层，然后合并
        // 先选中基底层
        selectSingleLayer(baseLayer);
        // 追加选择所有剪切层
        for (var k = 0; k < clipLayers.length; k++) {
            selectLayerAdditive(clipLayers[k]);
        }
        // 合并选中图层
        mergeLayers();
    }

    // ─────────────────────────────────────────────────────────────────
    // Action Manager 工具函数
    // ─────────────────────────────────────────────────────────────────

    // 判断图层是否是「剪切图层」（clipping = 1）
    function isClipped(layer) {
        try {
            // 通过 AM 获取 clipping 属性（比 layer.grouped 更可靠）
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
            var desc = executeActionGet(ref);
            var clipping = desc.getInteger(stringIDToTypeID("clipping"));
            return clipping === 1;
        } catch (e) {
            // fallback：使用 layer.grouped
            try { return layer.grouped; } catch (e2) { return false; }
        }
    }

    // 单选某个图层（取消其他所有选中）
    function selectSingleLayer(layer) {
        var doc = app.activeDocument;
        doc.activeLayer = layer;

        var idSlct = charIDToTypeID("slct");
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putBoolean(charIDToTypeID("MkVs"), false);
        // 不加 selectionModifier = 替换选择
        executeAction(idSlct, desc, DialogModes.NO);
    }

    // 追加选择某个图层（不取消已选中的）
    function selectLayerAdditive(layer) {
        var idSlct = charIDToTypeID("slct");
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putBoolean(charIDToTypeID("MkVs"), false);
        desc.putEnumerated(
            stringIDToTypeID("selectionModifier"),
            stringIDToTypeID("selectionModifierType"),
            stringIDToTypeID("addToSelection")
        );
        executeAction(idSlct, desc, DialogModes.NO);
    }

    // 合并当前选中的多个图层（Ctrl+E / Cmd+E 在多选状态下）
    function mergeLayers() {
        // 尝试 mergeLayersNew（CC 2015+）
        try {
            executeAction(stringIDToTypeID("mergeLayersNew"), new ActionDescriptor(), DialogModes.NO);
            return;
        } catch (e1) {}
        // fallback：Mrg2（所有版本均支持）
        try {
            executeAction(charIDToTypeID("Mrg2"), new ActionDescriptor(), DialogModes.NO);
            return;
        } catch (e2) {}
        // 最终 fallback：FltI（拼合到下方）—— 仅选两层时可用
        try {
            executeAction(charIDToTypeID("FltI"), new ActionDescriptor(), DialogModes.NO);
        } catch (e3) {
            throw new Error("无法执行合并操作，请确认 Photoshop 版本兼容性。\n内部错误：" + e3.message);
        }
    }

    // 合并图层组（在选中图层组的情况下执行 Mrg2）
    function mergeGroup() {
        executeAction(charIDToTypeID("Mrg2"), new ActionDescriptor(), DialogModes.NO);
    }

    // 将 Photoshop 图层集合转为 JS 数组
    function collectionToArray(layersCollection) {
        var arr = [];
        for (var i = 0; i < layersCollection.length; i++) {
            arr.push(layersCollection[i]);
        }
        return arr;
    }

})();
