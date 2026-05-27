// flatten_masks_final.jsx — 递归传递蒙版版本
#target photoshop
(function () {
    var doc = app.activeDocument;
    if (!doc) { return; }

    var savedUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    var count = 0;

    function hasVMask(layerId) {
        try {
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
            return executeActionGet(ref).hasKey(stringIDToTypeID("vectorMaskEnabled"));
        } catch(e) { return false; }
    }

    function getLayerKind(layer) {
        try {
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
            return executeActionGet(ref).getInteger(stringIDToTypeID("layerKind"));
        } catch(e) { return -1; }
    }

    function storeVMaskAsChannel(group) {
        doc.activeLayer = group;
        var paths = doc.pathItems;
        if (paths.length === 0) return null;
        var vmPath = paths[0];
        for (var i = 0; i < paths.length; i++) {
            var n = paths[i].name;
            if (n.indexOf("矢量") >= 0 || n.toLowerCase().indexOf("vector") >= 0) {
                vmPath = paths[i]; break;
            }
        }
        try { vmPath.makeSelection(0, false, SelectionType.REPLACE); }
        catch(e) { $.writeln("  makeSelection 失败: " + e.message); return null; }
        var ch = doc.channels.add();
        ch.name = "__vm__";
        doc.selection.store(ch);
        doc.selection.deselect();
        return ch;
    }

    // 对单个叶子层（非 group）应用通道蒙版：载入→反选→clear
    function applyChannelToLeaf(leaf, ch) {
        doc.activeLayer = leaf;
        var kind = getLayerKind(leaf);

        // 调整图层（kind=2）跳过
        if (kind === 2) {
            $.writeln("    跳过调整图层: " + leaf.name);
            return;
        }

        // 栅格化
        try { leaf.rasterize(RasterizeType.ENTIRELAYER); } catch(e) {}

        doc.activeLayer = leaf;
        doc.selection.load(ch);
        doc.selection.invert();
        try {
            doc.selection.clear();
            $.writeln("    ✓ " + leaf.name);
        } catch(e) {
            $.writeln("    ✗ " + leaf.name + ": " + e.message);
        }
        doc.selection.deselect();
    }

    // 递归对 container 内所有叶子层应用通道蒙版
    function applyChannelToAllLeaves(container, ch) {
        var layers = container.layers;
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            if (l.typename === "LayerSet") {
                // 子 group：递归进去处理叶子层
                applyChannelToAllLeaves(l, ch);
            } else {
                applyChannelToLeaf(l, ch);
            }
        }
    }

    function deleteVectorMask(group) {
        doc.activeLayer = group;
        try {
            executeAction(stringIDToTypeID("deleteVectorMask"), new ActionDescriptor(), DialogModes.NO);
        } catch(e) {
            try {
                var d = new ActionDescriptor();
                var r = new ActionReference();
                r.putEnumerated(stringIDToTypeID("path"), stringIDToTypeID("pathClass"), stringIDToTypeID("vectorMask"));
                d.putReference(charIDToTypeID("null"), r);
                executeAction(charIDToTypeID("Dlt "), d, DialogModes.NO);
            } catch(e2) { $.writeln("  deleteVectorMask 失败: " + e2.message); }
        }
    }

    function processGroup(group) {
        if (!hasVMask(group.id)) return;
        $.writeln("\n处理: '" + group.name + "' id=" + group.id);

        var tempCh = storeVMaskAsChannel(group);
        if (!tempCh) { $.writeln("  !! 跳过"); return; }

        // 对 group 内所有叶子层（递归）应用蒙版
        applyChannelToAllLeaves(group, tempCh);

        tempCh.remove();
        deleteVectorMask(group);
        $.writeln("  group 蒙版已删除 ✓");
        count++;
    }

    // 收集所有 group，深层优先（先处理 SD，再处理 list）
    function collectGroups(container, result) {
        var layers = container.layers;
        for (var i = 0; i < layers.length; i++) {
            if (layers[i].typename === "LayerSet") {
                collectGroups(layers[i], result);
                result.push(layers[i]);
            }
        }
        return result;
    }

    var snapshot = doc.activeHistoryState;
    try {
        var groups = collectGroups(doc, []);
        $.writeln("发现 " + groups.length + " 个图层组");
        for (var i = 0; i < groups.length; i++) {
            processGroup(groups[i]);
        }
        $.writeln("完成！共处理 " + count + " 个带矢量蒙版的图层组。");
    } catch(e) {
        doc.activeHistoryState = snapshot;
        $.writeln("ERROR: " + e.message);
    }

    app.preferences.rulerUnits = savedUnits;
})();
