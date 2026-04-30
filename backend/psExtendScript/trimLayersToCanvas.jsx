// trimLayersToCanvas.jsx
// ────────────────────────────────────────────────────────────────────────
// 把每个图层超出画布的像素清掉。三步：
//   1. 把所有 SmartObject 图层栅格化（PS Crop 对智能对象会保留外延像素，
//      栅格化后才彻底清掉）。
//   2. Select all（选画布）。
//   3. Image → Crop（带 delete=true，强制丢弃画布外像素）。
//
// 用途定位：
//   接在 flattenClippingMasks.jsx 之后、第二次 Delete All Empty Layers 之前。
//
// 为什么走 Image → Crop 而不是循环每个 layer 自己 clear：
//   PS 的 crop 命令是引擎级一次性处理：所有 ArtLayer 的 raster 数据都会被
//   裁到选区/给定 bounds 之内，layer.bounds 也会自动收缩。比我们自己
//   循环 selection.clear 更稳、更快、副作用少。
//
// 关键参数：crop ActionDescriptor 必须带 `delete = true`——这跟 PS 工具栏的
// "Delete Cropped Pixels" 复选框一致；不加 / false 时 PS 会保留画布外像素
// （只是隐藏），等于这一步白做。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

(function () {
    if (app.documents.length === 0) return "no document";

    var doc = app.activeDocument;
    var origRulerUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    var docW = doc.width.as("px");
    var docH = doc.height.as("px");

    var smartScanned = 0;
    var smartRasterized = 0;
    var smartFailed = 0;
    var cropped = false;

    try {
        // ─── 1. 栅格化所有 SmartObject ───────────────────────────────
        var smartIds = [];
        collectSmartObjectIds(doc, smartIds);
        smartScanned = smartIds.length;

        for (var i = 0; i < smartIds.length; i++) {
            try {
                var layer = findLayerById(doc, smartIds[i]);
                if (!layer) continue;
                doc.activeLayer = layer;
                layer.rasterize(RasterizeType.ENTIRELAYER);
                smartRasterized++;
            } catch (e) {
                smartFailed++;
                $.writeln("rasterize smart object failed (id=" +
                          smartIds[i] + "): " + e);
            }
        }

        // ─── 2. Select all ──────────────────────────────────────────
        doc.selection.selectAll();

        // ─── 3. Image → Crop（带 delete=true 强制丢弃画布外像素）─────
        // 全部用 PS Script Listener 录制的 4-char ID 形式——这是 PS 内部
        // 100% 认得的格式。早期版本用 stringIDToTypeID("crop"/"to"/
        // "classRectangle"/"pixelsUnit"/"delete")，PS 报 8800 通用错误
        // "该功能可能无法在这个版本中使用"——说明这条路径下 stringID 映射
        // 到 crop 命令的内部 typeID 不可靠。
        // 必传参数（缺一不可）：
        //   T    (to)        : Rctn (classRectangle) 矩形 = 整个画布
        //   Angl (angle)     : 0    ← 缺这个 PS 当作命令不完整
        //   Dlt  (delete)    : true ("Delete Cropped Pixels")
        var cropDesc = new ActionDescriptor();

        var rect = new ActionDescriptor();
        var idPxl = charIDToTypeID("#Pxl");   // pixelsUnit
        rect.putUnitDouble(charIDToTypeID("Top "), idPxl, 0);
        rect.putUnitDouble(charIDToTypeID("Left"), idPxl, 0);
        rect.putUnitDouble(charIDToTypeID("Btom"), idPxl, docH);
        rect.putUnitDouble(charIDToTypeID("Rght"), idPxl, docW);
        cropDesc.putObject(charIDToTypeID("T   "),
                           charIDToTypeID("Rctn"), rect);

        cropDesc.putUnitDouble(charIDToTypeID("Angl"),
                               charIDToTypeID("#Ang"), 0.0);
        cropDesc.putBoolean(charIDToTypeID("Dlt "), true);

        executeAction(charIDToTypeID("Crop"), cropDesc, DialogModes.NO);
        cropped = true;

        try { doc.selection.deselect(); } catch (e) { /* no-op */ }
    } finally {
        app.preferences.rulerUnits = origRulerUnits;
    }

    return "smartScanned=" + smartScanned +
           ", smartRasterized=" + smartRasterized +
           ", smartFailed=" + smartFailed +
           ", cropped=" + cropped;

    // ─── helpers ────────────────────────────────────────────────────

    // 递归收集所有 SmartObject 图层的 layerID
    function collectSmartObjectIds(parent, out) {
        for (var i = 0; i < parent.layers.length; i++) {
            var l = parent.layers[i];
            if (l.typename === "LayerSet") {
                collectSmartObjectIds(l, out);
            } else if (l.kind === LayerKind.SMARTOBJECT) {
                out.push(l.id);
            }
        }
    }

    // 通过 layerID 在文档树里递归查找
    function findLayerById(parent, id) {
        for (var i = 0; i < parent.layers.length; i++) {
            var l = parent.layers[i];
            if (l.id === id) return l;
            if (l.typename === "LayerSet") {
                var found = findLayerById(l, id);
                if (found) return found;
            }
        }
        return null;
    }
})();
