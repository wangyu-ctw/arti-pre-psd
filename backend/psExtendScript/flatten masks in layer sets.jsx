// flatten_masks_final.jsx — 最终版，无弹窗，支持矢量蒙版和像素蒙版，PS 27.4 验证
#target photoshop
(function () {
    var doc = app.activeDocument;
    if (!doc) return;

    var savedUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    function getMaskType(layer) {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        var d = executeActionGet(ref);
        return {
            vector: d.hasKey(stringIDToTypeID("vectorMaskEnabled")) &&
                    d.getBoolean(stringIDToTypeID("vectorMaskEnabled")),
            pixel:  d.hasKey(stringIDToTypeID("userMaskEnabled")) &&
                    d.getBoolean(stringIDToTypeID("userMaskEnabled"))
        };
    }

    function storeVectorMaskAsChannel(group) {
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
        catch(e) { return null; }
        var ch = doc.channels.add();
        ch.name = "__vm__";
        doc.selection.store(ch);
        doc.selection.deselect();
        return ch;
    }

    function storePixelMaskAsChannel(group) {
        doc.activeLayer = group;
        try {
            var selD = new ActionDescriptor();
            var selR = new ActionReference();
            selR.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
            selD.putReference(charIDToTypeID("null"), selR);
            selD.putBoolean(charIDToTypeID("MkVs"), false);
            executeAction(charIDToTypeID("slct"), selD, DialogModes.NO);

            doc.selection.selectAll();
            executeAction(charIDToTypeID("copy"), undefined, DialogModes.NO);
            doc.selection.deselect();

            var ch = doc.channels.add();
            ch.name = "__pm__";
            doc.activeChannels = [ch];
            executeAction(charIDToTypeID("past"), undefined, DialogModes.NO);

            doc.activeChannels = [doc.channels[0]];
            doc.selection.load(ch);
            var ch2 = doc.channels.add();
            ch2.name = "__pm2__";
            doc.selection.store(ch2);
            doc.selection.deselect();
            ch.remove();
            return ch2;
        } catch(e) { return null; }
    }

    function applyChannelToLeaf(leaf, ch) {
        doc.activeLayer = leaf;
        try {
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), leaf.id);
            var kind = executeActionGet(ref).getInteger(stringIDToTypeID("layerKind"));
            if (kind === 2) return;
        } catch(e) {}
        try { leaf.rasterize(RasterizeType.ENTIRELAYER); } catch(e) {}
        doc.activeLayer = leaf;
        doc.selection.load(ch);
        doc.selection.invert();
        try { doc.selection.clear(); } catch(e) {}
        doc.selection.deselect();
    }

    function applyToAllLeaves(container, ch) {
        var layers = container.layers;
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            if (l.typename === "LayerSet") applyToAllLeaves(l, ch);
            else applyChannelToLeaf(l, ch);
        }
    }

    function deleteMasks(group, mt) {
        doc.activeLayer = group;
        if (mt.vector) {
            try {
                executeAction(stringIDToTypeID("deleteVectorMask"), new ActionDescriptor(), DialogModes.NO);
            } catch(e) {
                try {
                    var d = new ActionDescriptor();
                    var r = new ActionReference();
                    r.putEnumerated(stringIDToTypeID("path"), stringIDToTypeID("pathClass"), stringIDToTypeID("vectorMask"));
                    d.putReference(charIDToTypeID("null"), r);
                    executeAction(charIDToTypeID("Dlt "), d, DialogModes.NO);
                } catch(e2) {}
            }
        }
        if (mt.pixel) {
            try {
                var selLD = new ActionDescriptor();
                var selLR = new ActionReference();
                selLR.putIdentifier(charIDToTypeID("Lyr "), group.id);
                selLD.putReference(charIDToTypeID("null"), selLR);
                executeAction(charIDToTypeID("slct"), selLD, DialogModes.NO);
            } catch(e) {}
            try {
                var d2 = new ActionDescriptor();
                var r2 = new ActionReference();
                r2.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
                d2.putReference(charIDToTypeID("null"), r2);
                d2.putBoolean(charIDToTypeID("Aply"), false);
                executeAction(charIDToTypeID("Dlt "), d2, DialogModes.NO);
            } catch(e) {}
        }
    }

    function processGroup(group) {
        var mt = getMaskType(group);
        if (!mt.vector && !mt.pixel) return;

        var tempCh = mt.vector
            ? storeVectorMaskAsChannel(group)
            : storePixelMaskAsChannel(group);
        if (!tempCh) return;

        try {
            doc.activeLayer = group;
            doc.activeChannels = [doc.channels[0]];
        } catch(e) {}

        applyToAllLeaves(group, tempCh);
        tempCh.remove();
        deleteMasks(group, mt);
    }

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
        for (var i = 0; i < groups.length; i++) {
            processGroup(groups[i]);
        }
    } catch(e) {
        doc.activeHistoryState = snapshot;
    }

    app.preferences.rulerUnits = savedUnits;
})();
