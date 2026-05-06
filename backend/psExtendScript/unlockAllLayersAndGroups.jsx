// Unlock all locked layers/layer groups in current document.
// Traversal rule: if a locked group is encountered, unlock the group first,
// then traverse and unlock its children.
#target Photoshop

(function () {
    if (!app.documents.length) return;

    var doc = app.activeDocument;

    function unlockOne(layer) {
        try {
            layer.allLocked = false;
        } catch (e) {}
        try {
            if (layer.pixelsLocked !== undefined) layer.pixelsLocked = false;
        } catch (e2) {}
        try {
            if (layer.positionLocked !== undefined) layer.positionLocked = false;
        } catch (e3) {}
        try {
            if (layer.transparentPixelsLocked !== undefined) layer.transparentPixelsLocked = false;
        } catch (e4) {}
    }

    function traverseAndUnlock(container) {
        for (var i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                // Parent group must be unlocked first.
                unlockOne(layer);
                traverseAndUnlock(layer);
            } else {
                unlockOne(layer);
            }
        }
    }

    // Top-level traversal from active document.
    traverseAndUnlock(doc);
})();
