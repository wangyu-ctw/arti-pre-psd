// deleteProblematicClipLayers.jsx
// ────────────────────────────────────────────────────────────────────────
// 删除所有"被剪切"（grouped=true）且满足以下任一条件的 ArtLayer：
//   · 混合模式不是 Normal
//   · 是调整图层（LayerKind 既不是 NORMAL / SMARTOBJECT / TEXT，即
//     色相饱和度、曲线、色阶、亮度对比度、颜色填充等非破坏性图层）
//
// 目的：flattenClippingMasks.jsx 无法合并含这类图层的 clip group；
//       先把这些"障碍层"删掉，clip group 里剩下都是普通像素层，
//       再跑一遍 flattenClippingMasks 就能正常合并。
//
// 注意：只删 ArtLayer，不删 LayerSet（组文件夹）。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

(function () {
    if (app.documents.length === 0) return "no document";

    var doc = app.activeDocument;

    // 先遍历收集，再统一删除（避免边遍历边修改结构导致索引乱）
    var toDelete = [];
    collect(doc, toDelete);

    var deleted = 0;
    var failedNames = [];
    for (var i = 0; i < toDelete.length; i++) {
        var layer = toDelete[i];
        var name = layer.name;
        try {
            layer.remove();
            deleted++;
        } catch (e) {
            $.writeln("delete failed (" + name + "): " + e);
            failedNames.push(name + " (" + e + ")");
        }
    }

    if (failedNames.length > 0) {
        throw "以下剪切层未能删除（共 " + failedNames.length + " 个）：" +
              failedNames.join("、");
    }
    return "deleted=" + deleted;

    // ─── helpers ────────────────────────────────────────────────────────

    // 递归收集所有满足条件的剪切层
    function collect(parent, result) {
        var arr = parent.layers;
        for (var i = 0; i < arr.length; i++) {
            var layer = arr[i];
            if (layer.typename === "LayerSet") {
                collect(layer, result);
                continue;
            }
            // 只处理 ArtLayer
            if (!isClipped(layer)) continue;
            if (isNonNormalBlend(layer) || isAdjustmentLayer(layer)) {
                result.push(layer);
            }
        }
    }

    // 判断图层是否被剪切到下方基底
    function isClipped(layer) {
        try {
            if (typeof layer.grouped !== "undefined") return layer.grouped === true;
        } catch (e1) { /* fall through */ }
        try {
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
            var desc = executeActionGet(ref);
            return desc.getBoolean(stringIDToTypeID("group"));
        } catch (e2) {
            return false;
        }
    }

    // 混合模式是否不是 Normal
    function isNonNormalBlend(layer) {
        try {
            return layer.blendMode !== BlendMode.NORMAL;
        } catch (e) {
            return false;
        }
    }

    // 是否是调整图层（非像素/智能对象/文字图层）
    function isAdjustmentLayer(layer) {
        try {
            var k = layer.kind;
            return k !== LayerKind.NORMAL &&
                   k !== LayerKind.SMARTOBJECT &&
                   k !== LayerKind.TEXT;
        } catch (e) {
            return false;
        }
    }
})();
